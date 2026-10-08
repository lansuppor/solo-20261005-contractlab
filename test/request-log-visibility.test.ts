// 请求记录持久化的“按保存发布”可见性并发回归（serve --requests-file）。
//
// 这些用例专门核对：运行中查询只展示最近一次成功保存的完整整库——
// - 新记录在其保存成功前不可见、其计划响应不发送；
// - sent/interrupted 的状态保存尚在途时，查询仍显示此前保存的状态；
// - 清空删除保存成功前仍返回此前记录（不提前返回空集合），清空成功响应也须等待保存；
// - 查询不等待在途保存；count 与 records 始终一致；
// - 一次保存只发布它入队时固化的内容：保存等待期间的新增/状态/清空不会因较早保存
//   成功而提前可见，多个保存阶段不混写，后续保存也不发布较旧状态；
// - 清空只移除开始处理时已完整接收的记录，其后请求正常续号且不被删掉，旧回调不复现；
// - 受控失败一次保存：失败变更不发布、未保存响应不发送、清空不报成功、文件保留、
//   stderr 定位、非零退出；
// - 重启续号与恢复（pending→interrupted、sent 不回退、初始查询即采用该转换）。
//
// 全部通过持久模式专用的受控落盘入口（/__contractlab/saves/*）把保存停在写盘闸门处，
// 事件驱动地等待 waiting/queued 或文件/查询状态，不依赖固定等待时间；
// 每个用例使用独立临时文件与端口 0。

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  makeTempDir,
  writeConfig,
  startPersistentServer,
  spawnServerWith,
  type SpawnedServer,
} from './helpers.ts';

const SLOW_DELAY = 600;

function config(): unknown {
  return {
    endpoints: [
      {
        method: 'GET',
        path: '/api/seq',
        responses: [
          { status: 200, headers: { 'X-Item': 'one' }, body: 'one', delay: 0 },
          { status: 201, headers: { 'X-Item': 'two' }, body: 'two', delay: 0 },
          { status: 202, headers: { 'X-Item': 'last' }, body: 'last', delay: 0 },
        ],
      },
      {
        method: 'GET',
        path: '/api/slow',
        responses: [{ status: 200, headers: {}, body: 'slow-one', delay: SLOW_DELAY }],
      },
    ],
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface StoredFile {
  readonly format: string;
  readonly version: number;
  readonly nextId: number;
  readonly records: StoredRecord[];
}

interface StoredRecord {
  readonly id: number;
  readonly delivery: string;
  readonly plannedResponse: { readonly kind: string; readonly status: number; readonly body: string } | null;
}

async function readStore(file: string): Promise<StoredFile> {
  return JSON.parse(await readFile(file, 'utf8')) as StoredFile;
}

async function waitFor<T>(fn: () => Promise<T | null> | (T | null), timeoutMs = 4000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined) {
        return v as T;
      }
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${label}${lastErr ? `（${String(lastErr)}）` : ''}`);
    }
    await sleep(15);
  }
}

function textRequest(
  port: number,
  method: string,
  urlPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.end();
  });
}

interface QueryReply {
  readonly count: number;
  readonly records: StoredRecord[];
}

async function getRecords(port: number): Promise<StoredRecord[]> {
  const reply = await textRequest(port, 'GET', '/__contractlab/requests');
  assert.equal(reply.status, 200);
  const parsed = JSON.parse(reply.body) as QueryReply;
  assert.equal(parsed.count, parsed.records.length, 'count 必须与 records 长度一致');
  return parsed.records;
}

interface SaveState {
  readonly paused: boolean;
  readonly failNext: boolean;
  readonly queued: number;
  readonly waiting: number;
}

async function saves(port: number, action: 'pause' | 'resume' | 'step' | 'fail-next'): Promise<SaveState> {
  const reply = await textRequest(port, 'POST', `/__contractlab/saves/${action}`);
  assert.equal(reply.status, 200, `saves/${action} 应返回 200`);
  return (JSON.parse(reply.body) as { saves: SaveState }).saves;
}

async function savesState(port: number): Promise<SaveState> {
  const reply = await textRequest(port, 'GET', '/__contractlab/saves/state');
  assert.equal(reply.status, 200);
  return (JSON.parse(reply.body) as { saves: SaveState }).saves;
}

function waitSaves(port: number, pred: (s: SaveState) => boolean, label: string): Promise<SaveState> {
  return waitFor(
    async () => {
      const s = await savesState(port);
      return pred(s) ? s : null;
    },
    4000,
    label,
  );
}

// 断言一个 Promise 在当前同步点尚未落定（不使用任何固定等待）。
async function assertHeld<T>(p: Promise<T>): Promise<void> {
  const outcome = await Promise.race([p.then(() => 'done'), Promise.resolve('held')]);
  assert.equal(outcome, 'held', '该响应此时必须尚未发送/落定');
}

function openGet(port: number, urlPath: string): { req: http.ClientRequest; done: Promise<{ status: number; body: string }> } {
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath });
  const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on('response', (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
  });
  req.end();
  return { req, done };
}

// 注册一个持久服务到测试清理（断言失败也会关闭，避免挂住测试进程）。
function track(t: TestContext, s: SpawnedServer): SpawnedServer {
  t.after(async () => {
    try {
      await s.close();
    } catch {
      // 已退出：忽略
    }
  });
  return s;
}

async function start(t: TestContext): Promise<{ server: SpawnedServer; dir: string; file: string; storeFile: string }> {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  const server = await track(t, await startPersistentServer(file, storeFile));
  return { server, dir, file, storeFile };
}

// 先落一条已保存的 sent 基线 id1，并确保在途保存全部排空。
async function baselineOne(port: number, storeFile: string): Promise<void> {
  const r = await textRequest(port, 'GET', '/api/seq');
  assert.equal(r.status, 200);
  await waitFor(
    async () => {
      const s = await readStore(storeFile);
      const rec = s.records.find((x) => x.id === 1);
      return rec && rec.delivery === 'sent' ? true : null;
    },
    4000,
    'id1 sent 落盘',
  );
  await waitSaves(port, (s) => s.queued === 0 && s.waiting === 0, '基线保存排空');
}

// ---------------------------------------------------------------------------

test('新记录保存成功前不可见、不发送计划响应；查询与文件保持上一快照；sent 保存中仍显示此前状态', { timeout: 30_000 }, async (t) => {
  const { server, storeFile } = await start(t);
  const port = server.port;
  await baselineOne(port, storeFile);

  await saves(port, 'pause');
  const second = openGet(port, '/api/seq'); // id2 的提交保存停在闸门，响应不得发送
  await waitSaves(port, (s) => s.waiting === 1, 'id2 提交保存在闸门等待');

  // 在途保存期间连续查询：始终只看到已保存的 id1，count 一致
  for (let i = 0; i < 3; i += 1) {
    const recs = await getRecords(port);
    assert.deepEqual(recs.map((r) => r.id), [1]);
    assert.equal(recs[0].delivery, 'sent');
  }
  // 文件仍只含 id1
  let onDisk = await readStore(storeFile);
  assert.deepEqual(onDisk.records.map((r) => r.id), [1]);
  // id2 的计划响应尚未发送
  await assertHeld(second.done);

  // 仅放行 id2 的提交保存：发布 [1,2(pending)]，响应随后发出
  await saves(port, 'step');
  const res2 = await second.done;
  assert.equal(res2.status, 201);
  assert.equal(res2.body, 'two');
  // id2 响应完成会触发 sent 状态保存，它同样停在闸门
  await waitSaves(port, (s) => s.waiting === 1, 'id2 的 sent 状态保存在闸门等待');

  // sent 尚未保存：查询与文件仍显示此前保存的 pending（上一快照），不提前显示 sent
  let recs = await getRecords(port);
  assert.deepEqual(recs.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'pending']]);
  onDisk = await readStore(storeFile);
  assert.deepEqual(onDisk.records.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'pending']]);

  // 放行 sent 保存后整体切换为 sent
  await saves(port, 'resume');
  await waitFor(
    async () => ((await readStore(storeFile)).records.find((x) => x.id === 2)?.delivery === 'sent' ? true : null),
    4000,
    'id2 sent 落盘',
  );
  recs = await getRecords(port);
  assert.deepEqual(recs.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'sent']]);
  await server.close();
});

test('每次保存只发布入队时固化的内容：两条在途新记录与各自 sent 保存不混阶段', { timeout: 30_000 }, async (t) => {
  const { server, storeFile } = await start(t);
  const port = server.port;
  await baselineOne(port, storeFile);

  await saves(port, 'pause');
  const r2 = openGet(port, '/api/seq'); // id2
  await waitSaves(port, (s) => s.waiting === 1, 'id2 提交保存在闸门');
  const r3 = openGet(port, '/api/seq'); // id3：排在 id2 之后
  await waitSaves(port, (s) => s.waiting === 1 && s.queued >= 2, 'id3 提交保存已排队');

  // 放行 id2 提交：文件/查询只到 [1,2(pending)]；id2 响应发出，其 sent 保存排在 id3 之后
  await saves(port, 'step');
  const res2 = await r2.done;
  assert.equal(res2.body, 'two');
  await waitSaves(port, (s) => s.waiting === 1, '下一保存（id3 提交）到达闸门');

  // 此时 id3 尚未保存成功：查询与文件不含 id3；id2 虽已响应，但 sent 保存未成功，仍为 pending
  let recs = await getRecords(port);
  assert.deepEqual(recs.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'pending']]);
  let onDisk = await readStore(storeFile);
  assert.deepEqual(onDisk.records.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'pending']]);
  await assertHeld(r3.done);

  // 放行 id3 提交：其内容在 id2 还是 pending 时固化，故发布 [1,2(pending),3(pending)]，
  // 不混入尚未保存的 id2=sent
  await saves(port, 'step');
  const res3 = await r3.done;
  assert.equal(res3.body, 'last');
  await waitSaves(port, (s) => s.waiting === 1, '下一保存（id2 sent）到达闸门');
  onDisk = await readStore(storeFile);
  assert.deepEqual(
    onDisk.records.map((r) => [r.id, r.delivery]),
    [[1, 'sent'], [2, 'pending'], [3, 'pending']],
    'id3 的保存不得提前发布 id2 的 sent',
  );
  recs = await getRecords(port);
  assert.deepEqual(
    recs.map((r) => [r.id, r.delivery]),
    [[1, 'sent'], [2, 'pending'], [3, 'pending']],
  );

  // 放行 id2 sent 保存：只把 id2 切为 sent；id3 仍 pending（其 sent 保存在后）
  await saves(port, 'step');
  await waitSaves(port, (s) => s.waiting === 1, 'id3 sent 保存到达闸门');
  onDisk = await readStore(storeFile);
  assert.deepEqual(
    onDisk.records.map((r) => [r.id, r.delivery]),
    [[1, 'sent'], [2, 'sent'], [3, 'pending']],
  );

  // 放行 id3 sent：最终全部 sent
  await saves(port, 'resume');
  await waitFor(
    async () => {
      const s = await readStore(storeFile);
      return s.records.length === 3 && s.records.every((r) => r.delivery === 'sent') ? true : null;
    },
    4000,
    '三条全部 sent',
  );
  recs = await getRecords(port);
  assert.deepEqual(recs.map((r) => r.delivery), ['sent', 'sent', 'sent']);
  await server.close();
});

test('interrupted 状态保存中仍显示此前 pending；保存成功后才切换', { timeout: 30_000 }, async (t) => {
  const { server, storeFile } = await start(t);
  const port = server.port;
  await baselineOne(port, storeFile);

  await saves(port, 'pause');
  const slow = openGet(port, '/api/slow'); // id2，延迟中；提交保存停在闸门
  await waitSaves(port, (s) => s.waiting === 1, 'slow 提交保存在闸门');
  await saves(port, 'step'); //提交成功：id2 以 pending 发布，延迟计时开始
  await waitFor(
    async () => ((await readStore(storeFile)).records.some((r) => r.id === 2 && r.delivery === 'pending') ? true : null),
    4000,
    'id2 pending 落盘',
  );

  // 延迟结束前断开：触发 interrupted 状态保存（停在闸门）
  slow.req.destroy();
  slow.done.catch(() => undefined);
  await waitSaves(port, (s) => s.waiting === 1, 'interrupted 保存在闸门');

  // interrupted 尚未保存：查询与文件仍显示 pending
  let recs = await getRecords(port);
  assert.equal(recs.find((r) => r.id === 2)?.delivery, 'pending');
  let onDisk = await readStore(storeFile);
  assert.equal(onDisk.records.find((r) => r.id === 2)?.delivery, 'pending');

  await saves(port, 'resume');
  await waitFor(
    async () => ((await readStore(storeFile)).records.find((x) => x.id === 2)?.delivery === 'interrupted' ? true : null),
    4000,
    'id2 interrupted 落盘',
  );
  recs = await getRecords(port);
  assert.equal(recs.find((r) => r.id === 2)?.delivery, 'interrupted');
  onDisk = await readStore(storeFile);
  assert.equal(onDisk.records.find((r) => r.id === 2)?.delivery, 'interrupted');
  await server.close(); // SIGTERM 会取消尚未触发的延迟
});

test('清空保存中不提前返回空集合、成功响应等待保存；其后请求续号不被删、旧回调不复现', { timeout: 30_000 }, async (t) => {
  const { server, file, storeFile } = await start(t);
  const port = server.port;
  await baselineOne(port, storeFile);

  await saves(port, 'pause');
  const r2 = openGet(port, '/api/seq'); // id2 提交保存停在闸门
  await waitSaves(port, (s) => s.waiting === 1, 'id2 提交保存在闸门');

  // 发起清空：其删除保存排在 id2 之后；工作集此刻已清空，但发布基线不变
  const clearAttempt = textRequest(port, 'POST', '/__contractlab/requests/clear');
  clearAttempt.catch(() => undefined);
  await waitSaves(port, (s) => s.queued >= 2, '清空删除保存已排队');

  // id2 保存先成功：发布 [1,2]，id2 响应随后发出（但它已不在 live，sent 回调是 no-op）；
  // 清空保存紧接着到达闸门并停住
  await saves(port, 'step');
  const res2 = await r2.done;
  assert.equal(res2.body, 'two');
  await waitSaves(port, (s) => s.waiting === 1, '清空删除保存在闸门');

  // 清空尚未保存成功：查询/文件仍是此前记录（绝不提前为空），清空成功响应也未返回
  let recs = await getRecords(port);
  assert.deepEqual(recs.map((r) => r.id), [1, 2]);
  let onDisk = await readStore(storeFile);
  assert.deepEqual(onDisk.records.map((r) => r.id), [1, 2]);
  await assertHeld(clearAttempt);

  // 清空处理之后才来的新请求 id3：其保存排在清空之后，编号继续、不会被本次清空删掉
  const r3 = openGet(port, '/api/seq');
  await waitSaves(port, (s) => s.queued >= 2, '清空后新请求 id3 已排队');

  // 放行清空保存：发布空库（编号进度保留），清空成功响应此时才返回
  await saves(port, 'step');
  const clearReply = await clearAttempt;
  assert.equal(clearReply.status, 200);
  assert.equal(JSON.parse(clearReply.body).removed, 2);
  await waitFor(
    async () => {
      const s = await readStore(storeFile);
      return s.records.length === 0 ? s : null;
    },
    4000,
    '清空落盘为空',
  );
  recs = await getRecords(port);
  assert.deepEqual(recs.map((r) => r.id), []);
  onDisk = await readStore(storeFile);
  assert.equal(onDisk.nextId, 3, '清空保留编号进度');

  // 放行 id3：只发布清空后的新记录；id1/id2 不复活；id3 取序列末项（消费未被清空重置）
  await saves(port, 'resume');
  const res3 = await r3.done;
  assert.equal(res3.status, 202);
  assert.equal(res3.body, 'last');
  const finalDisk = await waitFor(
    async () => {
      const s = await readStore(storeFile);
      return s.records.length === 1 && s.records[0].id === 3 && s.records[0].delivery === 'sent' ? s : null;
    },
    4000,
    '只剩 id3 且 sent',
  );
  assert.equal(finalDisk.nextId, 4);
  recs = await getRecords(port);
  assert.deepEqual(recs.map((r) => r.id), [3]);

  // 重启：编号在清空基础上继续（下一条为 id4，不复用 1/2/3）；业务序列不恢复，
  // 重启后 seq 从首项 'one' 重新开始。
  await server.close();
  const server2 = await track(t, await startPersistentServer(file, storeFile));
  const recs2 = await getRecords(server2.port);
  assert.deepEqual(recs2.map((r) => r.id), [3]);
  const afterRestart = await textRequest(server2.port, 'GET', '/api/seq');
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.body, 'one', '业务序列不恢复：重启后从首项开始');
  const disk2 = await waitFor(
    async () => {
      const s = await readStore(storeFile);
      return s.records.some((r) => r.id === 4) ? s : null;
    },
    4000,
    '重启后新记录 id4 落盘',
  );
  assert.equal(disk2.nextId, 5);
  assert.deepEqual(disk2.records.map((r) => r.id), [3, 4]);
  await server2.close();
});

test('受控失败一次保存：新记录不发送、变更不发布、文件保留此前内容、非零退出且 stderr 定位', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());

  // 情形 A：新记录的提交保存失败一次
  const storeA = path.join(dir, 'a.json');
  let server = await track(t, await startPersistentServer(file, storeA));
  await baselineOne(server.port, storeA);
  await saves(server.port, 'fail-next');
  const blocked = textRequest(server.port, 'GET', '/api/seq');
  blocked.catch(() => undefined);
  const exitA = await server.waitExit();
  assert.notEqual(exitA.code, 0, '保存失败必须非零退出');
  await assert.rejects(blocked, '未保存成功的新记录不得发送计划响应');
  assert.match(server.stderr(), /保存失败/);
  assert.match(server.stderr(), new RegExp(path.basename(storeA)));
  const keptA = await readStore(storeA);
  assert.deepEqual(keptA.records.map((r) => r.id), [1], '文件保留最后成功保存的内容');

  // 情形 B：清空删除保存失败一次——不得报成功、文件保留、非零退出
  const storeB = path.join(dir, 'b.json');
  server = await track(t, await startPersistentServer(file, storeB));
  await baselineOne(server.port, storeB);
  await saves(server.port, 'pause');
  const clearAttempt = textRequest(server.port, 'POST', '/__contractlab/requests/clear');
  clearAttempt.catch(() => undefined);
  await waitSaves(server.port, (s) => s.waiting === 1, '清空保存在闸门');
  // 查询在清空保存失败前仍显示旧记录
  assert.deepEqual((await getRecords(server.port)).map((r) => r.id), [1]);
  await saves(server.port, 'fail-next');
  await saves(server.port, 'step'); // 放行后该保存失败（不写入）→ 致命关闭
  const exitB = await server.waitExit();
  assert.notEqual(exitB.code, 0);
  await clearAttempt.then(
    (reply) => assert.notEqual(reply.status, 200, '清空保存失败不得报成功'),
    () => undefined,
  );
  assert.match(server.stderr(), /保存失败/);
  const keptB = await readStore(storeB);
  assert.deepEqual(keptB.records.map((r) => r.id), [1], '失败的清空不得删除已保存记录');

  // 文件保留此前内容：重启后恢复为 id1
  server = await track(t, await startPersistentServer(file, storeB));
  assert.deepEqual((await getRecords(server.port)).map((r) => r.id), [1]);
  await server.close();
});

test('受控暂停/失败/状态入口仅持久模式有效；内存模式一律 404', { timeout: 20_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server = await spawnServerWith(['serve', '--config', file, '--port', '0']);
  for (const action of ['pause', 'resume', 'step', 'fail-next']) {
    const r = await textRequest(server.port, 'POST', `/__contractlab/saves/${action}`);
    assert.equal(r.status, 404, `内存模式 saves/${action} 必须 404`);
  }
  const s = await textRequest(server.port, 'GET', '/__contractlab/saves/state');
  assert.equal(s.status, 404);
  await server.close();
});

test('SIGKILL 后恢复：初始查询即把 pending 转 interrupted、sent 不回退；重启后续号', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');

  let server = await track(t, await startPersistentServer(file, storeFile));
  await baselineOne(server.port, storeFile); // id1 sent

  // 用闸门确定性地得到一条已落盘 pending（延迟响应尚未发出），无需等待固定延迟
  await saves(server.port, 'pause');
  const slow = openGet(server.port, '/api/slow'); // id2
  await waitSaves(server.port, (s) => s.waiting === 1, 'slow 提交保存在闸门');
  await saves(server.port, 'resume'); // 放行提交：id2 pending 落盘，响应延迟中
  await waitFor(
    async () => ((await readStore(storeFile)).records.some((r) => r.id === 2 && r.delivery === 'pending') ? true : null),
    4000,
    'id2 pending 落盘',
  );
  slow.done.catch(() => undefined);
  server.send('SIGKILL');
  await server.waitExit();
  await slow.done.catch(() => undefined);

  // 磁盘：id1 sent、id2 pending
  const onDisk = await readStore(storeFile);
  assert.deepEqual(onDisk.records.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'pending']]);

  // 重启：初始查询即采用 pending→interrupted、sent 不回退，计划响应保留且不重发
  server = await track(t, await startPersistentServer(file, storeFile));
  const recs = await getRecords(server.port);
  assert.deepEqual(recs.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'interrupted']]);
  assert.equal(recs.find((r) => r.id === 2)?.plannedResponse?.body, 'slow-one');

  // 编号继续：新记录为 id3；业务序列不恢复，重启后 seq 从首项 'one' 开始
  const next = await textRequest(server.port, 'GET', '/api/seq');
  assert.equal(next.status, 200);
  assert.equal(next.body, 'one');
  const after = await waitFor(
    async () => {
      const s = await readStore(storeFile);
      return s.records.some((r) => r.id === 3 && r.delivery === 'sent') ? s : null;
    },
    4000,
    'id3 sent 落盘',
  );
  assert.equal(after.nextId, 4);
  assert.deepEqual(after.records.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'interrupted'], [3, 'sent']]);
  await server.close();
});

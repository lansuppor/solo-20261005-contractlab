// 请求记录持久化的“快照发布”一致性回归（serve --requests-file）。
//
// 这些用例通过仅测试使用的环境变量在保存（flush）物理写入前做**受控暂停**或
// **强制失败一次**，从而确定性地复现“保存等待期间”的交错，不依赖固定等待时间：
// - CONTRACTLAB_TEST_SAVE_GATE_DIR：第 N 次 flush 开始写入前若存在 hold（全局）
//   或 hold-N 文件，就暂停并写出 N-started；移除 hold 后写出 N-finished 并继续。
// - CONTRACTLAB_TEST_SAVE_FAIL_ON_FLUSH=K：第 K 次 flush 的物理写入强制失败一次。
//
// 核对要点（题述）：
// - 查询只展示最近一次成功保存的完整记录及状态；不等待正在进行的保存，返回此前快照；
// - 新记录保存前不可见且不发送计划响应；sent/interrupted 尚未保存时仍显示此前状态；
// - 清空删除结果保存前仍显示此前记录、不提前返回空集合，成功响应也等待保存；
// - 每次成功保存整体切换为该次实际写入内容；保存等待期间的新增/状态/清空不因较早
//   保存成功而提前可见，不混用多个保存阶段，后续保存不发布较旧状态；
// - 清空移除开始处理时已完整接收的全部记录、保留编号；其后请求正常续号、不被删掉；
// - 保存失败不发布失败变更：保留最后成功保存的文件内容、未保存响应不发送、stderr
//   定位文件与原因、服务非零退出；重启续号、pending→interrupted 的恢复后初始查询。

import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  makeTempDir,
  writeConfig,
  spawnServerWith,
  startPersistentServer,
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
        responses: [
          { status: 200, headers: {}, body: 'slow-one', delay: SLOW_DELAY },
          { status: 201, headers: {}, body: 'slow-two', delay: SLOW_DELAY },
        ],
      },
    ],
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | null> | (T | null), timeoutMs = 5000, label = 'condition'): Promise<T> {
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
    await sleep(10);
  }
}

async function fileExists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

const marker = (gateDir: string, seq: number, kind: 'started' | 'finished'): string =>
  path.join(gateDir, `${seq}-${kind}`);
const waitMarker = (gateDir: string, seq: number, kind: 'started' | 'finished'): Promise<void> =>
  waitFor(async () => ((await fileExists(marker(gateDir, seq, kind))) ? true : null), 5000, `flush${seq} ${kind}`);

async function hold(gateDir: string, seq: number): Promise<void> {
  await writeFile(path.join(gateDir, `hold-${seq}`), '', 'utf8');
}
async function release(gateDir: string, seq: number): Promise<void> {
  await rm(path.join(gateDir, `hold-${seq}`), { force: true });
}

async function startGated(
  configPath: string,
  requestsFile: string,
  gateDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<SpawnedServer> {
  await mkdir(gateDir, { recursive: true });
  return spawnServerWith(
    ['serve', '--config', configPath, '--port', '0', '--requests-file', requestsFile],
    20_000,
    { CONTRACTLAB_TEST_SAVE_GATE_DIR: gateDir, ...extraEnv },
  );
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

interface StoredFile {
  readonly nextId: number;
  readonly records: ReadonlyArray<{ readonly id: number; readonly delivery: string }>;
}
async function readStore(file: string): Promise<StoredFile> {
  return JSON.parse(await readFile(file, 'utf8')) as StoredFile;
}

async function getSnapshot(port: number): Promise<{ count: number; records: Array<{ id: number; delivery: string }> }> {
  const reply = await textRequest(port, 'GET', '/__contractlab/requests');
  assert.equal(reply.status, 200);
  const parsed = JSON.parse(reply.body) as { count: number; records: Array<{ id: number; delivery: string }> };
  // count 与 records 必须始终一致
  assert.equal(parsed.count, parsed.records.length, 'count 必须与 records 数量一致');
  return parsed;
}

const ids = (recs: ReadonlyArray<{ id: number }>): number[] => recs.map((r) => r.id);
const deliveriesOf = (recs: ReadonlyArray<{ id: number; delivery: string }>, id: number): string =>
  (recs.find((r) => r.id === id) as { id: number; delivery: string }).delivery;

// ---------------------------------------------------------------------------

test('保存窗口内：新记录不可见且不发送，sent 尚未保存仍显示此前状态，查询与文件一致', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const gateDir = path.join(dir, 'gate');
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  const server = await startGated(file, storeFile, gateDir);
  const port = server.port;
  t.after(server.close);

  // flush 编号：启动建空库=1；A 提交=2，A sent=3；B 提交=4，B sent=5。
  await hold(gateDir, 2);
  await hold(gateDir, 4);
  await hold(gateDir, 5);

  // A 的提交保存（flush2）被暂停：A 尚未保存，不可见、且计划响应未发送
  let aDone = false;
  const a = textRequest(port, 'GET', '/api/seq').then((v) => {
    aDone = true;
    return v;
  });
  await waitMarker(gateDir, 2, 'started');
  const snap1 = await getSnapshot(port);
  assert.deepEqual(ids(snap1.records), [], '保存成功前不得提前暴露新记录');
  assert.equal((await readStore(storeFile)).records.length, 0, '物理文件尚未写入 A');
  assert.equal(aDone, false, '保存成功前不得发送计划响应');

  // 放行 flush2：A 才发布并发送；随后 flush3（A sent）不设闸门，立即落盘
  await release(gateDir, 2);
  await waitMarker(gateDir, 2, 'finished');
  const aRes = await a;
  assert.equal(aRes.status, 200);
  assert.equal(aRes.body, 'one');
  await waitFor(async () => ((await readStore(storeFile)).records[0]?.delivery === 'sent' ? true : null), 5000, 'A sent 落盘');

  // B（延迟响应）提交保存 flush4 被暂停
  let bDone = false;
  const b = textRequest(port, 'GET', '/api/slow').then((v) => {
    bDone = true;
    return v;
  });
  await waitMarker(gateDir, 4, 'started');
  const snap2 = await getSnapshot(port);
  assert.deepEqual(ids(snap2.records), [1], 'B 保存前只显示此前已保存的 A');
  assert.equal(bDone, false, 'B 保存前不发送');
  assert.deepEqual((await readStore(storeFile)).records.map((r) => r.id), [1]);

  // 放行 flush4：B 以 pending 发布，延迟开始计时；其 sent 保存 flush5 已预先设闸
  await release(gateDir, 4);
  await waitMarker(gateDir, 4, 'finished');
  await waitFor(async () => (ids((await getSnapshot(port)).records).join() === '1,2' ? true : null), 5000, 'B 发布为 pending');
  let snap3 = await getSnapshot(port);
  assert.equal(deliveriesOf(snap3.records, 2), 'pending');

  // B 延迟结束触发 sent 保存 flush5：保存完成前查询仍显示此前保存的 pending
  await waitMarker(gateDir, 5, 'started');
  snap3 = await getSnapshot(port);
  assert.equal(deliveriesOf(snap3.records, 2), 'pending', 'sent 尚未保存时仍显示此前保存的 pending');
  assert.equal((await readStore(storeFile)).records.find((r) => r.id === 2)?.delivery, 'pending');
  assert.equal(bDone, true, 'B 的响应已实际写出（只是 sent 状态尚在保存）');

  await release(gateDir, 5);
  await waitMarker(gateDir, 5, 'finished');
  await b;
  const snap4 = await getSnapshot(port);
  assert.equal(deliveriesOf(snap4.records, 2), 'sent', '保存成功后整体切换为 sent');
  assert.equal((await readStore(storeFile)).records.find((r) => r.id === 2)?.delivery, 'sent');
});

test('保存窗口内：interrupted 尚未保存时仍显示此前保存的 pending，保存后才切换', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const gateDir = path.join(dir, 'gate');
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  const server = await startGated(file, storeFile, gateDir);
  const port = server.port;
  t.after(server.close);

  // flush：启动=1；C 提交=2；连接断开标记 interrupted=3
  await hold(gateDir, 2);
  await hold(gateDir, 3);

  // 原始可中止的 GET：在 flush2 确认暂停后主动断开（写出前断开 → interrupted）
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/slow' }, () => undefined);
  req.on('error', () => undefined);
  req.end();

  await waitMarker(gateDir, 2, 'started');
  assert.deepEqual(ids((await getSnapshot(port)).records), [], 'C 保存前不可见');
  req.destroy();

  // 放行提交保存：C 先以 pending 发布；interrupted 保存（flush3）随即在闸门处暂停
  await release(gateDir, 2);
  await waitMarker(gateDir, 2, 'finished');
  await waitMarker(gateDir, 3, 'started');

  // interrupted 尚未保存：查询与文件都仍是此前保存的 pending
  let snap = await getSnapshot(port);
  assert.deepEqual(ids(snap.records), [1]);
  assert.equal(deliveriesOf(snap.records, 1), 'pending', 'interrupted 尚未保存时仍显示 pending');
  assert.equal((await readStore(storeFile)).records[0]?.delivery, 'pending');

  await release(gateDir, 3);
  await waitMarker(gateDir, 3, 'finished');
  await waitFor(
    async () => ((await readStore(storeFile)).records[0]?.delivery === 'interrupted' ? true : null),
    5000,
    'interrupted 落盘',
  );
  snap = await getSnapshot(port);
  assert.equal(deliveriesOf(snap.records, 1), 'interrupted');
});

test('清空删除结果保存前仍显示此前记录、不提前返回空；其后续号请求不被本次清空删掉', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const gateDir = path.join(dir, 'gate');
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  const server = await startGated(file, storeFile, gateDir);
  const port = server.port;
  t.after(server.close);

  // 先存一条 A（flush2 提交、flush3 sent，均不设闸）
  const a = await textRequest(port, 'GET', '/api/seq');
  assert.equal(a.status, 200);
  await waitFor(async () => ((await readStore(storeFile)).records[0]?.delivery === 'sent' ? true : null), 5000, 'A sent');

  // flush：清空=4；清空保存期间到达的 B 提交=5
  await hold(gateDir, 4);
  await hold(gateDir, 5);

  let clearDone = false;
  const clear = textRequest(port, 'POST', '/__contractlab/requests/clear').then((v) => {
    clearDone = true;
    return v;
  });
  await waitMarker(gateDir, 4, 'started');

  // 清空删除结果尚未保存：仍显示此前记录，绝不能提前返回空集合；成功响应也未返回
  const snap = await getSnapshot(port);
  assert.deepEqual(ids(snap.records), [1], '清空保存前必须仍显示此前记录');
  assert.deepEqual((await readStore(storeFile)).records.map((r) => r.id), [1], '文件仍为此前记录');
  assert.equal(clearDone, false, '清空成功响应必须等待删除结果保存');

  // 清空保存期间到达的新请求 B（在清空开始处理之后才完整接收）
  let bDone = false;
  const b = textRequest(port, 'GET', '/api/seq').then((v) => {
    bDone = true;
    return v;
  });

  // 放行清空保存：整库切换为空，清空返回成功；B 的提交保存 flush5 随即暂停
  await release(gateDir, 4);
  await waitMarker(gateDir, 4, 'finished');
  const clearRes = await clear;
  assert.equal(clearRes.status, 200);
  assert.equal(JSON.parse(clearRes.body).removed, 1);
  await waitFor(async () => ((await getSnapshot(port)).records.length === 0 ? true : null), 5000, '清空发布为空');
  assert.deepEqual((await readStore(storeFile)).records, []);

  await waitMarker(gateDir, 5, 'started');
  assert.deepEqual(ids((await getSnapshot(port)).records), [], 'B 保存前仍为空（不提前可见）');
  assert.equal(bDone, false, 'B 保存前不发送');

  await release(gateDir, 5);
  await waitMarker(gateDir, 5, 'finished');
  const bRes = await b;
  assert.equal(bRes.status, 201, '清空后续号请求取序列下一项（消费位置不受清空影响）');
  const store = await waitFor(
    async () => {
      const s = await readStore(storeFile);
      return s.records.length === 1 && s.records[0]?.delivery === 'sent' ? s : null;
    },
    5000,
    'B 落盘',
  );
  assert.deepEqual(store.records.map((r) => r.id), [2], '清空后请求续号为 2，且不被本次清空删掉');
  assert.ok(store.nextId >= 3, '编号进度保留');
});

test('保存等待期间到达的记录不因较早保存成功而提前可见；较早保存不发布较新阶段的数据', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const gateDir = path.join(dir, 'gate');
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  const server = await startGated(file, storeFile, gateDir);
  const port = server.port;
  t.after(server.close);

  // A 正常保存（flush2 提交、flush3 sent）
  await textRequest(port, 'GET', '/api/seq');
  await waitFor(async () => ((await readStore(storeFile)).records[0]?.delivery === 'sent' ? true : null), 5000, 'A sent');

  // flush：B（慢）提交=4，C 提交=5，B sent=6
  await hold(gateDir, 4);
  await hold(gateDir, 5);

  // B 的提交保存进入暂停
  const b = textRequest(port, 'GET', '/api/slow');
  b.catch(() => undefined);
  await waitMarker(gateDir, 4, 'started');

  // 保存等待期间又完整接收 C：C 的提交保存排在 B 之后（flush5）
  let cDone = false;
  const c = textRequest(port, 'GET', '/api/seq').then((v) => {
    cDone = true;
    return v;
  });

  // 放行较早的保存 flush4：它只发布自己冻结时包含的内容（A、B pending），
  // 绝不能把等待期间到达的 C 一起发布
  await release(gateDir, 4);
  await waitMarker(gateDir, 4, 'finished');
  await waitMarker(gateDir, 5, 'started'); // flush5（含 C）此时才开始且被暂停
  const snap = await getSnapshot(port);
  assert.deepEqual(ids(snap.records), [1, 2], '较早保存不得提前发布等待期间的 C');
  assert.equal(deliveriesOf(snap.records, 2), 'pending');
  assert.equal(cDone, false, 'C 在自己的保存成功前不发送');
  assert.deepEqual((await readStore(storeFile)).records.map((r) => r.id), [1, 2], '文件同样不含 C');

  // 放行 flush5：C 才出现；B 仍为 pending（后续 B sent 保存不会回退 C）
  await release(gateDir, 5);
  await waitMarker(gateDir, 5, 'finished');
  const cRes = await c;
  assert.equal(cRes.status, 201);
  await waitFor(
    async () => {
      const s = await readStore(storeFile);
      const b2 = s.records.find((r) => r.id === 2);
      return s.records.length === 3 && b2?.delivery === 'sent' ? s : null;
    },
    5000,
    'B sent 且 C 保留',
  );
  const finalStore = await readStore(storeFile);
  assert.deepEqual(finalStore.records.map((r) => r.id), [1, 2, 3], '后续保存不发布较旧状态：C 不回退、B 变 sent');
  await b;
});

test('保存失败一次：不发布失败变更、不发送未保存响应，文件保留最后成功内容，stderr 定位且非零退出', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const gateDir = path.join(dir, 'gate');
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  // flush：启动建库=1，A 提交=2，A sent=3，B 提交=4（强制失败一次）
  const server = await startGated(file, storeFile, gateDir, { CONTRACTLAB_TEST_SAVE_FAIL_ON_FLUSH: '4' });
  const port = server.port;

  // A 成功保存为 sent（flush2/3）
  const a = await textRequest(port, 'GET', '/api/seq');
  assert.equal(a.status, 200);
  await waitFor(async () => ((await readStore(storeFile)).records[0]?.delivery === 'sent' ? true : null), 5000, 'A sent 落盘');

  // B 的提交保存（flush4）被强制失败：不得发送、服务致命非零退出
  const blocked = textRequest(port, 'GET', '/api/seq');
  blocked.catch(() => undefined);
  const exited = await server.waitExit();
  assert.notEqual(exited.code, 0, '保存失败必须非零退出');
  await assert.rejects(blocked, '未保存成功的 B 不得发送计划响应');
  assert.match(server.stderr(), /保存失败/, 'stderr 应说明保存失败');
  assert.match(server.stderr(), new RegExp(path.basename(storeFile)), 'stderr 应定位记录文件');

  // 文件保留最后一次成功保存的内容（A sent），失败变更 B 不在其中
  const kept = await readStore(storeFile);
  assert.deepEqual(kept.records.map((r) => [r.id, r.delivery]), [[1, 'sent']], '失败变更不得写入/发布');

  // 重启恢复：只看到 A；新请求在保存进度上继续（id2 此前从未成功保存）
  const restarted = await startPersistentServer(file, storeFile);
  t.after(restarted.close);
  const snap = await getSnapshot(restarted.port);
  assert.deepEqual(ids(snap.records), [1]);
  // 编号继续递增：下一条为 2（B 此前从未成功保存，编号进度已推进但记录未发布）；
  // 恢复不重置业务序列，新服务从序列首项开始
  const again = await textRequest(restarted.port, 'GET', '/api/seq');
  assert.equal(again.status, 200, '恢复后业务序列从首项开始');
  await waitFor(
    async () => {
      const s = await readStore(storeFile);
      return s.records.length === 2 && s.records[1]?.id === 2 && s.records[1]?.delivery === 'sent' ? s : null;
    },
    5000,
    '重启后新请求保存',
  );
});

test('恢复：pending→interrupted 的转换用于重启后初始查询；sent 不回退；编号继续递增', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const gateDir = path.join(dir, 'gate');
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');

  // 第一段：A sent、B pending（用闸门保证 pending 已落盘但响应未发出即 SIGKILL）
  let server = await startGated(file, storeFile, gateDir);
  // flush：启动=1，A 提交=2，A sent=3，B 提交=4
  await hold(gateDir, 4);
  await textRequest(server.port, 'GET', '/api/seq'); // A
  await waitFor(async () => ((await readStore(storeFile)).records[0]?.delivery === 'sent' ? true : null), 5000, 'A sent');
  const inflight = textRequest(server.port, 'GET', '/api/slow'); // B
  inflight.catch(() => undefined);
  await waitMarker(gateDir, 4, 'started');
  await release(gateDir, 4);
  await waitMarker(gateDir, 4, 'finished'); // B 以 pending 成功保存
  await waitFor(async () => ((await readStore(storeFile)).records[1]?.delivery === 'pending' ? true : null), 5000, 'B pending');
  server.send('SIGKILL');
  await server.waitExit();
  await inflight.catch(() => undefined);

  // 重启后的“初始查询”即采用状态转换：B pending→interrupted，A sent 不回退
  server = await startPersistentServer(file, storeFile);
  t.after(server.close);
  const snap = await getSnapshot(server.port);
  assert.deepEqual(
    snap.records.map((r) => [r.id, r.delivery]),
    [[1, 'sent'], [2, 'interrupted']],
    '恢复后的初始查询必须采用 pending→interrupted 转换，sent 不回退',
  );
  // 恢复不重发历史响应：仅查询，不新增记录
  assert.deepEqual((await readStore(storeFile)).records.map((r) => r.id), [1, 2]);

  // 编号继续递增：下一条为 3（不复用、不重置）
  const next = await textRequest(server.port, 'GET', '/api/seq');
  assert.equal(next.status, 200);
  await waitFor(
    async () => {
      const s = await readStore(storeFile);
      return s.records.length === 3 && s.nextId === 4 ? s : null;
    },
    5000,
    '续号 3',
  );
  const stored = await readStore(storeFile);
  assert.deepEqual(stored.records.map((r) => r.id), [1, 2, 3]);
});

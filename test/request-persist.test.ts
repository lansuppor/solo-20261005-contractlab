// 请求记录持久化（serve --requests-file）回归测试
//
// 覆盖（均使用独立临时记录文件与端口 0）：
// - 文件不存在时建立空记录库；正常 SIGTERM 关闭后的完整恢复：原编号、接收顺序、
//   原始请求头、UTF-8/非法 UTF-8 无损正文、接收时版本、校验与分支结论、消费位置
//   与计划响应原样保留（不按当前配置重判）；新服务从版本 1、各序列首项开始；
//   恢复出的快照可直接交给 verify、replay（replay 全部 same）；
// - 强制终止（SIGKILL）后恢复：尚未确认的 pending 标为 interrupted（不能证明
//   客户端未收到），已确认的 sent 不回退；规范化结果监听前落盘，二次强杀仍为 interrupted；
// - 清空待发送记录：删除结果落盘后才成功，在途响应不取消；随后完成或重启记录都
//   不重现；清空后编号继续递增（不按剩余记录最大编号续号）；
// - reload 期间落盘等待不改变在途请求的旧版本与旧计划响应，重启后仍不重判；
// - 记录文件损坏（非法 JSON、顶层/字段/状态非法、编号不递增、正文无法无损还原）
//   在监听前拒绝启动、退出非零且原文件不变；
// - 运行中保存失败：清空不返回成功、未保存的新记录不发送计划响应、已保存状态保留、
//   stderr 定位文件、服务非零退出。

import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import {
  makeTempDir,
  startServer,
  startServerExpectFailure,
  writeConfig,
  writeText,
  runCli,
  type RunningServer,
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
          { status: 200, headers: { 'X-Slow': 'one' }, body: 'slow-one', delay: SLOW_DELAY },
          { status: 201, headers: {}, body: 'slow-two', delay: SLOW_DELAY },
        ],
      },
      {
        method: 'POST',
        path: '/api/echo',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [{ status: 200, headers: {}, body: 'echo-ok', delay: 0 }],
      },
      {
        // 无正文规则的 POST：任意正文都原样无损记录
        method: 'POST',
        path: '/api/open',
        responses: [{ status: 200, headers: {}, body: 'open-ok', delay: 0 }],
      },
    ],
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RequestOptions {
  readonly method?: string;
  readonly body?: Buffer | string;
  readonly headers?: Record<string, string>;
}

function send(port: number, requestPath: string, opts: RequestOptions = {}): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : Buffer.from(opts.body as string);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (body !== undefined && headers['Content-Length'] === undefined) {
      headers['Content-Length'] = String(body.byteLength);
    }
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: requestPath, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

// 允许连接层失败（用于强杀/致命关闭场景）：返回响应或错误
function sendSoft(port: number, requestPath: string, opts: RequestOptions = {}): Promise<
  { ok: true; status: number; body: string } | { ok: false }
> {
  return send(port, requestPath, opts).then(
    (r) => ({ ok: true as const, status: r.status, body: r.body }),
    () => ({ ok: false as const }),
  );
}

async function getRecords(port: number): Promise<readonly any[]> {
  const reply = await send(port, '/__contractlab/requests');
  assert.equal(reply.status, 200);
  const parsed = JSON.parse(reply.body) as { count: number; records: any[] };
  assert.equal(parsed.count, parsed.records.length);
  return parsed.records;
}

async function readStore(storeFile: string): Promise<{ nextId: number; records: any[] }> {
  return JSON.parse(await readFile(storeFile, 'utf8'));
}

// 轮询记录文件，直到出现 count 条记录（持久化为异步串行落盘）
async function waitStoreCount(storeFile: string, count: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const store = await readStore(storeFile);
    if (store.records.length === count) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`记录文件未在 ${timeoutMs}ms 内达到 ${count} 条，当前 ${store.records.length}`);
    }
    await sleep(10);
  }
}

function rawWrite(port: number, raw: Buffer): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(raw);
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

async function startWithStore(
  configFile: string,
  storeFile: string,
): Promise<RunningServer> {
  return startServer(configFile, 20_000, ['--requests-file', storeFile]);
}

test('文件不存在时建立空记录库；正常关闭后完整恢复；快照可用于 verify/replay（含无损正文）', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'requests.json'); // 尚不存在

  const server = await startWithStore(configFile, storeFile);
  t.after(() => server.close('SIGKILL'));
  const port = server.port;
  assert.ok(server.stdout().includes('request records'), '启动日志应说明记录文件');
  assert.ok(server.stdout().includes('0 restored'));

  // 监听前空记录库已建立
  const emptyStore = await readStore(storeFile);
  assert.equal(emptyStore.nextId, 1);
  assert.deepEqual(emptyStore.records, []);

  // 场景请求：序列三项 + 末项复用
  const r1 = await send(port, '/api/seq?a=1');
  assert.equal(r1.status, 200);
  const r2 = await send(port, '/api/seq');
  assert.equal(r2.status, 201);
  await send(port, '/api/seq'); // 202
  // 合格 POST（自定义头保留大小写）
  const postOk = await send(port, '/api/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'X-Case': 'keep' },
    body: '{"id":7}',
  });
  assert.equal(postOk.status, 200);
  assert.equal(postOk.body, 'echo-ok');
  // 无正文规则的 POST：含中文与空白的 UTF-8 正文原样无损记录
  const openBody = '{"note": "中文"} ';
  const open = await send(port, '/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: openBody,
  });
  assert.equal(open.status, 200);
  assert.equal(open.body, 'open-ok');
  // 非法 UTF-8 字节：400（parse），正文以 base64 无损记录
  const badBytes = Buffer.from([0x7b, 0xff, 0xfe, 0x80, 0x7d]);
  const badRaw = Buffer.concat([
    Buffer.from(
      ['POST /api/echo HTTP/1.1', 'Host: 127.0.0.1', 'Content-Type: application/json', `Content-Length: ${badBytes.byteLength}`, 'Connection: close', '', ''].join('\r\n'),
      'utf8',
    ),
    badBytes,
  ]);
  const badSocket = await rawWrite(port, badRaw);
  badSocket.resume();
  await new Promise<void>((resolve) => badSocket.on('close', resolve));
  // 404
  const nf = await send(port, '/api/missing?z=9');
  assert.equal(nf.status, 404);

  await waitStoreCount(storeFile, 7);

  // 正常信号关闭：退出 0，最终状态落盘
  const code = await server.close('SIGTERM');
  assert.equal(code, 0);

  // 文件中的记录：编号、顺序、计划响应、消费位置
  const store = await readStore(storeFile);
  assert.equal(store.nextId, 8);
  assert.deepEqual(store.records.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    store.records.map((r) => r.delivery),
    ['sent', 'sent', 'sent', 'sent', 'sent', 'sent', 'sent'],
  );
  assert.equal(store.records[0].request.target, '/api/seq?a=1');
  assert.equal(store.records[0].sequencePosition, 0);
  assert.equal(store.records[2].sequencePosition, 2);
  assert.equal(store.records[3].request.body.content, '{"id":7}');
  assert.equal(store.records[3].bodyValidationPassed, true);
  assert.equal(store.records[3].branchSelection.kind, 'fallback');
  assert.equal(store.records[3].plannedResponse.status, 200);
  assert.equal(store.records[3].plannedResponse.headers['X-Contractlab-Version'], '1');
  // 原始请求头保序保大小写
  assert.equal(
    store.records[3].request.rawHeaders[store.records[3].request.rawHeaders.indexOf('X-Case') + 1],
    'keep',
  );
  // 中文 UTF-8 文本无损
  const openRecord = store.records[4];
  assert.equal(openRecord.request.body.encoding, 'utf-8');
  assert.equal(openRecord.request.body.content, openBody);
  assert.equal(Buffer.byteLength(openRecord.request.body.content, 'utf8'), openRecord.request.bodyBytes);
  assert.equal(openRecord.bodyValidationPassed, null);
  // 非法 UTF-8：base64 无损 + 400 parse
  const badRecord = store.records[5];
  assert.equal(badRecord.request.body.encoding, 'base64');
  assert.ok(Buffer.from(badRecord.request.body.content, 'base64').equals(badBytes), '非法 UTF-8 字节须无损恢复');
  assert.equal(badRecord.bodyRejection.stage, 'parse');
  assert.equal(badRecord.plannedResponse.status, 400);
  assert.equal(store.records[6].matched, false);
  assert.equal(store.records[6].plannedResponse.status, 404);

  // 用同一记录文件重启：监听前完整恢复
  const server2 = await startWithStore(configFile, storeFile);
  t.after(() => server2.close('SIGKILL'));
  assert.ok(server2.stdout().includes('7 restored'));
  const port2 = server2.port;

  const restored = await getRecords(port2);
  assert.equal(restored.length, 7);
  assert.deepEqual(restored.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7]);
  // 结论字段原样保留，不按当前配置重判
  assert.equal(restored[5].bodyRejection.stage, 'parse');
  assert.equal(restored[5].configVersion, 1);
  assert.equal(restored[6].matched, false);
  assert.equal(restored[4].request.body.content, openBody, '恢复后中文正文仍无损');

  // 先保存“恢复后、新业务请求之前”的快照（7 条），交给 verify
  const snapshotReply = await send(port2, '/__contractlab/requests');
  const snapshotFile = await writeText(dir, 'snapshot.json', snapshotReply.body);
  const verify = await runCli(['verify', '--requests', snapshotFile, '--config', configFile]);
  assert.equal(verify.code, 1, '存在 400/404 记录时 verify 退出 1，但报告完整');
  const verifyReport = JSON.parse(verify.stdout);
  assert.equal(verifyReport.total, 7);
  const outcomes = Object.fromEntries(
    verifyReport.results.map((r: any) => [r.id, r.outcome]),
  );
  assert.equal(outcomes[1], 'no_body_check');
  assert.equal(outcomes[4], 'passed');
  assert.equal(outcomes[5], 'no_body_check');
  assert.equal(outcomes[6], 'rejected');
  assert.equal(outcomes[7], 'unmatched');

  // 再开一台序列在首项的新服务，把 7 条原始请求逐条 replay：状态与正文全部一致
  // （3 次 /api/seq 为 one/two/last，合格 echo 200、open 200、非法字节 400、404）
  await server2.close('SIGTERM');
  const server3 = await startWithStore(configFile, storeFile);
  t.after(() => server3.close('SIGKILL'));
  const replay = await runCli(['replay', '--requests', snapshotFile, '--port', String(server3.port), '--timeout', '10000']);
  assert.equal(replay.code, 0, `replay 应全部 same：${replay.stdout} ${replay.stderr}`);
  const replayReport = JSON.parse(replay.stdout);
  assert.equal(replayReport.total, 7);
  assert.equal(replayReport.same, 7);
  assert.equal(replayReport.different, 0);
  assert.equal(replayReport.failed, 0);

  // replay 的 7 次真实请求也被记录：编号继续为 8..14；再发一条 seq 为 15（不复用）
  const after = await send(server3.port, '/api/seq');
  assert.equal(after.headers['x-contractlab-version'], '1', '配置版本不恢复：从版本 1 开始');
  assert.equal(after.body, 'last', '3 次历史 seq 重放把序列带到末项，末项复用');
  const afterRecords = await getRecords(server3.port);
  assert.equal(afterRecords.length, 15);
  assert.equal(afterRecords[7].id, 8);
  assert.equal(afterRecords[14].id, 15, '编号在同一记录库中跨进程、跨清空持续递增');
});

test('强制终止后恢复：pending 标为 interrupted、sent 不回退；二次强杀结论不变', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'requests.json');

  const server = await startWithStore(configFile, storeFile);
  t.after(() => server.close('SIGKILL'));
  const port = server.port;

  await send(port, '/api/seq'); // id 1, sent
  // id 2: 延迟响应在途（不 await 响应，连接保持）
  const inflight = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/slow' });
  inflight.on('error', () => undefined); // 强杀后连接被断
  inflight.end();
  await waitStoreCount(storeFile, 2);
  let store = await readStore(storeFile);
  assert.deepEqual(store.records.map((r) => r.delivery), ['sent', 'pending']);

  // 强制终止：来不及保存最终状态
  const killed = await server.close('SIGKILL');
  assert.equal(killed, null);
  store = await readStore(storeFile);
  assert.deepEqual(store.records.map((r) => r.delivery), ['sent', 'pending'], '强杀不更新文件');

  // 重启：pending 恢复为 interrupted，sent 不回退；规范化结果监听前已落盘
  const server2 = await startWithStore(configFile, storeFile);
  t.after(() => server2.close('SIGKILL'));
  assert.ok(server2.stdout().includes('2 restored'));
  store = await readStore(storeFile);
  assert.deepEqual(store.records.map((r) => r.delivery), ['sent', 'interrupted']);
  const records = await getRecords(server2.port);
  assert.deepEqual(records.map((r) => r.delivery), ['sent', 'interrupted']);
  assert.equal(records[1].plannedResponse.body, 'slow-one', '计划响应原样恢复');

  // 再次强制终止（无新请求）：磁盘上结论不得变回 pending
  await server2.close('SIGKILL');
  store = await readStore(storeFile);
  assert.deepEqual(store.records.map((r) => r.delivery), ['sent', 'interrupted']);

  // 又一次重启：仍一致
  const server3 = await startWithStore(configFile, storeFile);
  t.after(() => server3.close('SIGKILL'));
  const records3 = await getRecords(server3.port);
  assert.deepEqual(records3.map((r) => r.delivery), ['sent', 'interrupted']);
});

test('正常关闭把待发送记录的最终状态保存为 interrupted', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'requests.json');

  const server = await startWithStore(configFile, storeFile);
  const port = server.port;
  const inflight = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/slow' });
  inflight.on('error', () => undefined);
  inflight.end();
  await waitStoreCount(storeFile, 1);
  assert.equal((await readStore(storeFile)).records[0].delivery, 'pending');

  const code = await server.close('SIGTERM');
  assert.equal(code, 0, '正常关闭退出 0');
  const store = await readStore(storeFile);
  assert.equal(store.records[0].delivery, 'interrupted', '最终状态已保存，重启无需补发');
  assert.equal(store.records[0].plannedResponse.body, 'slow-one');
});

test('清空待发送记录：删除结果落盘后才成功；在途响应不取消；完成或重启都不重现', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'requests.json');

  const server = await startWithStore(configFile, storeFile);
  const port = server.port;
  await send(port, '/api/seq'); // id 1
  const pending = send(port, '/api/slow'); // id 2, pending
  await waitStoreCount(storeFile, 2);

  const clearReply = await send(port, '/__contractlab/requests/clear', { method: 'POST' });
  assert.equal(clearReply.status, 200);
  const clearBody = JSON.parse(clearReply.body);
  assert.equal(clearBody.ok, true);
  assert.equal(clearBody.removed, 2);

  // 删除结果已落盘：记录为空，但编号进度保留
  let store = await readStore(storeFile);
  assert.equal(store.records.length, 0);
  assert.equal(store.nextId, 3);

  // 在途响应未被取消：客户端仍收到延迟响应
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body, 'slow-one');
  await sleep(100);
  assert.equal((await getRecords(port)).length, 0, '旧响应完成不得让记录重现');

  // 重启：记录仍为空；编号继续
  const code = await server.close('SIGTERM');
  assert.equal(code, 0);
  store = await readStore(storeFile);
  assert.equal(store.records.length, 0);

  const server2 = await startWithStore(configFile, storeFile);
  t.after(() => server2.close('SIGKILL'));
  assert.ok(server2.stdout().includes('0 restored'));
  assert.equal((await getRecords(server2.port)).length, 0);
  const next = await send(server2.port, '/api/seq');
  assert.equal(next.body, 'one', '序列从首项开始');
  const records = await getRecords(server2.port);
  assert.deepEqual(records.map((r) => r.id), [3], '清空后重启编号不复用');
});

test('清空后重启编号持续递增：不按剩余记录最大编号续号', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'requests.json');

  let server = await startWithStore(configFile, storeFile);
  await send(server.port, '/api/seq'); // id 1
  await waitStoreCount(storeFile, 1);
  await send(server.port, '/__contractlab/requests/clear', { method: 'POST' });
  assert.equal((await readStore(storeFile)).nextId, 2);
  await server.close('SIGTERM');

  // 重启后文件中没有任何记录：首条新记录必须是 2，而不是从 1 重新开始
  server = await startWithStore(configFile, storeFile);
  await send(server.port, '/api/seq');
  let records = await getRecords(server.port);
  assert.deepEqual(records.map((r) => r.id), [2]);
  await send(server.port, '/__contractlab/requests/clear', { method: 'POST' });
  assert.equal((await readStore(storeFile)).nextId, 3);
  await server.close('SIGTERM');

  server = await startWithStore(configFile, storeFile);
  t.after(() => server.close('SIGKILL'));
  await send(server.port, '/api/seq');
  records = await getRecords(server.port);
  assert.deepEqual(records.map((r) => r.id), [3], '清空两次并跨进程后仍不复用旧编号');
});

test('reload 期间落盘等待不改变在途请求的旧版本与旧计划；重启后不重判', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'requests.json');

  const server = await startWithStore(configFile, storeFile);
  const port = server.port;

  // 在途：v1 的延迟响应
  const inflight = send(port, '/api/slow?pin=1');
  await waitStoreCount(storeFile, 1);
  let store = await readStore(storeFile);
  assert.equal(store.records[0].configVersion, 1);
  assert.equal(store.records[0].plannedResponse.body, 'slow-one');

  // reload 为全新配置（同路径不同响应、无延迟）
  const v2 = {
    endpoints: [
      { method: 'GET', path: '/api/slow', responses: [{ status: 202, headers: {}, body: 'v2-body', delay: 0 }] },
    ],
  };
  await writeConfig(dir, 'scenes.json', v2);
  const reloaded = await send(port, '/__contractlab/reload', { method: 'POST' });
  assert.equal(JSON.parse(reloaded.body).version, 2);

  // 在途请求仍按旧版本与旧计划完成
  const oldRes = await inflight;
  assert.equal(oldRes.status, 200);
  assert.equal(oldRes.headers['x-contractlab-version'], '1');
  assert.equal(oldRes.body, 'slow-one');

  // 新请求用新版本
  const newRes = await send(port, '/api/slow');
  assert.equal(newRes.status, 202);
  assert.equal(newRes.headers['x-contractlab-version'], '2');

  // 文件中两条记录的结论各自钉在接收时版本
  await waitStoreCount(storeFile, 2);
  store = await readStore(storeFile);
  assert.equal(store.records[0].configVersion, 1);
  assert.equal(store.records[0].plannedResponse.body, 'slow-one');
  assert.equal(store.records[0].plannedResponse.headers['X-Contractlab-Version'], '1');
  assert.equal(store.records[1].configVersion, 2);
  assert.equal(store.records[1].plannedResponse.body, 'v2-body');

  // 用 v2 配置 + 旧记录文件重启：旧记录不按当前配置重判，仍显示 v1 的计划
  await server.close('SIGTERM');
  const server2 = await startWithStore(configFile, storeFile);
  t.after(() => server2.close('SIGKILL'));
  const records = await getRecords(server2.port);
  assert.equal(records[0].configVersion, 1);
  assert.equal(records[0].plannedResponse.body, 'slow-one');
  assert.equal(records[0].plannedResponse.status, 200);
  assert.equal(records[1].configVersion, 2);
});

test('手写的合法 interrupted 记录可恢复，且不补发', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'requests.json');

  const validStore = {
    kind: 'contractlab-requests',
    version: 1,
    nextId: 6,
    records: [
      {
        id: 5,
        receivedAt: '2026-01-02T03:04:05.678Z',
        request: {
          method: 'GET',
          target: '/api/seq?old=1',
          path: '/api/seq',
          rawHeaders: ['Host', '127.0.0.1:1', 'X-Keep', '原值'],
          bodyBytes: 0,
          body: { encoding: 'utf-8', content: '' },
        },
        configVersion: 3, // 历史版本，仅保存不恢复
        matched: true,
        endpoint: 'GET /api/seq',
        bodyValidationPassed: null,
        bodyRejection: null,
        branchSelection: { kind: 'fallback' },
        sequencePosition: 1,
        sequenceLength: 3,
        plannedResponse: {
          kind: 'scene',
          status: 201,
          headers: { 'X-Contractlab-Version': '3', 'X-Item': 'two' },
          body: 'two',
        },
        delivery: 'interrupted',
      },
    ],
  };
  await writeText(dir, 'requests.json', JSON.stringify(validStore));
  const server = await startWithStore(configFile, storeFile);
  t.after(() => server.close('SIGKILL'));
  assert.ok(server.stdout().includes('1 restored'));

  const records = await getRecords(server.port);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 5);
  assert.equal(records[0].delivery, 'interrupted');
  assert.equal(records[0].configVersion, 3);
  assert.deepEqual(records[0].request.rawHeaders, ['Host', '127.0.0.1:1', 'X-Keep', '原值']);
  // 编号进度恢复：下一条是 6
  const next = await send(server.port, '/api/seq');
  assert.equal(next.body, 'one', '序列从首项开始（业务位置不恢复）');
  const after = await getRecords(server.port);
  assert.deepEqual(after.map((r) => r.id), [5, 6]);
});

// ---------------------------------------------------------------------------
// 记录文件损坏：监听前拒绝启动、不改原文件
// ---------------------------------------------------------------------------

function minimalRecord(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    receivedAt: '2026-01-02T03:04:05.678Z',
    request: {
      method: 'GET',
      target: '/x',
      path: '/x',
      rawHeaders: [],
      bodyBytes: 0,
      body: { encoding: 'utf-8', content: '' },
    },
    configVersion: 1,
    matched: false,
    endpoint: null,
    bodyValidationPassed: null,
    bodyRejection: null,
    branchSelection: null,
    sequencePosition: null,
    sequenceLength: null,
    plannedResponse: { kind: 'framework', status: 404, headers: {}, body: 'not found\n' },
    delivery: 'sent',
    ...overrides,
  };
}

function storeJson(nextId: number, records: unknown[]): string {
  return JSON.stringify({ kind: 'contractlab-requests', version: 1, nextId, records });
}

async function expectStoreRejected(
  t: any,
  configFile: string,
  dir: string,
  name: string,
  content: string,
  diagnostics: readonly string[],
): Promise<void> {
  const storeFile = await writeText(dir, name, content);
  const before = await readFile(storeFile);
  const result = await startServerExpectFailure(configFile, ['--requests-file', storeFile]);
  assert.notEqual(result.code, 0, `${name}：必须非零退出`);
  assert.ok(!result.stdout.includes('listening'), `${name}：不得开始监听`);
  for (const fragment of [storeFile, ...diagnostics]) {
    assert.ok(result.stderr.includes(fragment), `${name}：stderr 应定位 "${fragment}"，实际：${result.stderr}`);
  }
  const after = await readFile(storeFile);
  assert.ok(before.equals(after), `${name}：原文件不得被修改`);
}

test('记录文件损坏：非法 JSON、结构与状态非法、编号不递增、正文不可还原均拒绝启动', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());

  await expectStoreRejected(t, configFile, dir, 'broken.json', '{ broken', ['不是合法 JSON']);
  await expectStoreRejected(t, configFile, dir, 'toplevel.json', '[]', ['顶层必须是 JSON 对象']);
  await expectStoreRejected(t, configFile, dir, 'kind.json', storeJson(1, []).replace('contractlab-requests', 'other'), ['kind']);
  await expectStoreRejected(
    t, configFile, dir, 'version.json',
    JSON.stringify({ kind: 'contractlab-requests', version: 9, nextId: 1, records: [] }),
    ['version'],
  );

  // 缺少计划响应的半截记录
  const halfRecord = minimalRecord(1);
  delete (halfRecord as { plannedResponse?: unknown }).plannedResponse;
  await expectStoreRejected(t, configFile, dir, 'half.json', storeJson(2, [halfRecord]), ['records[0].plannedResponse']);

  // 非法 delivery
  await expectStoreRejected(
    t, configFile, dir, 'delivery.json',
    storeJson(2, [minimalRecord(1, { delivery: 'queued' })]),
    ['records[0].delivery'],
  );

  // 编号未严格递增
  await expectStoreRejected(
    t, configFile, dir, 'ids.json',
    storeJson(4, [minimalRecord(2), minimalRecord(1)]),
    ['records[1].id'],
  );

  // 编号不小于 nextId
  await expectStoreRejected(
    t, configFile, dir, 'nextid.json',
    storeJson(3, [minimalRecord(5)]),
    ['records[0].id', 'nextId'],
  );

  // 正文无法无损还原：bodyBytes 不符
  const badLen = minimalRecord(1, {
    request: {
      method: 'GET',
      target: '/x',
      path: '/x',
      rawHeaders: [],
      bodyBytes: 9,
      body: { encoding: 'utf-8', content: 'ab' },
    },
  });
  await expectStoreRejected(t, configFile, dir, 'bodylen.json', storeJson(2, [badLen]), ['records[0].request.body', 'bodyBytes']);

  // 非法 base64
  const badB64 = minimalRecord(1, {
    request: {
      method: 'GET',
      target: '/x',
      path: '/x',
      rawHeaders: [],
      bodyBytes: 3,
      body: { encoding: 'base64', content: '@@@' },
    },
  });
  await expectStoreRejected(t, configFile, dir, 'b64.json', storeJson(2, [badB64]), ['records[0].request.body.content']);

  // path 与 target 不符
  const badPath = minimalRecord(1);
  (badPath.request as Record<string, unknown>).path = '/y';
  await expectStoreRejected(t, configFile, dir, 'path.json', storeJson(2, [badPath]), ['records[0].request.path']);

  // 消费位置与序列长度矛盾
  await expectStoreRejected(
    t, configFile, dir, 'seqpos.json',
    storeJson(2, [minimalRecord(1, { sequencePosition: 2, sequenceLength: 2 })]),
    ['records[0]'],
  );

  // 配置文件本身有效，但记录文件的父目录缺失：建立空库失败也拒绝启动
  const missingDir = path.join(dir, 'no-such-dir', 'requests.json');
  const result = await startServerExpectFailure(configFile, ['--requests-file', missingDir]);
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes(missingDir) || result.stderr.includes('no-such-dir'));
});

// ---------------------------------------------------------------------------
// 运行中保存失败：致命非零退出；清空不成功；未保存新记录不发送；已保存状态保留
// ---------------------------------------------------------------------------

test('运行中保存失败：未保存的新记录不发送、服务非零退出、此前状态保留、stderr 定位', { timeout: 60_000 }, async (t) => {
  if (process.getuid !== undefined && process.getuid() === 0) {
    t.skip('root 绕过目录写权限，跳过');
    return;
  }
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'requests.json');

  const server = await startWithStore(configFile, storeFile);
  await send(server.port, '/api/seq'); // 已成功保存一条
  await waitStoreCount(storeFile, 1);

  // 令记录文件所在目录不可写（临时文件创建失败；原子替换无法进行）
  await chmod(dir, 0o555);
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => undefined);
  });

  const reply = await sendSoft(server.port, '/api/seq');
  assert.equal(reply.ok, false, '未成功保存的新记录不得发送计划响应（连接被关闭）');

  const code = await server.waitExit(10_000);
  assert.notEqual(code, 0, '保存失败后服务必须非零退出');
  assert.ok(server.stderr().includes(storeFile), 'stderr 须定位记录文件');
  assert.ok(/保存失败/.test(server.stderr()), `stderr 须说明原因：${server.stderr()}`);

  await chmod(dir, 0o700);
  const store = await readStore(storeFile);
  assert.equal(store.records.length, 1, '此前已成功保存的状态保留；失败的新记录不在文件中');
  assert.equal(store.records[0].id, 1);
});

test('运行中保存失败时清空不返回成功；服务非零退出', { timeout: 60_000 }, async (t) => {
  if (process.getuid !== undefined && process.getuid() === 0) {
    t.skip('root 绕过目录写权限，跳过');
    return;
  }
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'requests.json');

  const server = await startWithStore(configFile, storeFile);
  await send(server.port, '/api/seq');
  await waitStoreCount(storeFile, 1);

  await chmod(dir, 0o555);
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => undefined);
  });

  // 清空的删除结果无法落盘：不得报成功（500 或连接被关闭均可）
  const reply = await sendSoft(server.port, '/__contractlab/requests/clear', { method: 'POST' });
  if (reply.ok) {
    assert.notEqual(reply.status, 200);
  }

  const code = await server.waitExit(10_000);
  assert.notEqual(code, 0);
  assert.ok(server.stderr().includes(storeFile));

  await chmod(dir, 0o700);
  const store = await readStore(storeFile);
  assert.equal(store.records.length, 1, '清空未确认：旧记录仍在文件中');
});

test('未启用 --requests-file 时保持进程内行为（不创建文件）', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', config());
  const wouldBeStore = path.join(dir, 'requests.json');

  const server = await startServer(configFile);
  t.after(() => server.close('SIGKILL'));
  const r = await send(server.port, '/api/seq');
  assert.equal(r.status, 200);
  const records = await getRecords(server.port);
  assert.equal(records.length, 1);
  await assert.rejects(readFile(wouldBeStore), '未启用持久化时不得创建记录文件');
  const note = JSON.parse((await send(server.port, '/__contractlab/requests')).body).note;
  assert.ok(note.includes('进程内存'));
});

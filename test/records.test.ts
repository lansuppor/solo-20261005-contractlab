// 本地请求记录的回归测试
//
// 覆盖：
//   1. 场景响应 / 正文拒绝 400 / 未匹配 404 各记录一次：编号递增、含查询串的
//      原始目标、请求头、原始正文、版本、消费位置、计划响应（含准确版本头）、
//      发送状态；末项复用记录相同位置；拒绝与 404 没有消费位置
//   2. 无效 UTF-8 正文以 base64 无损记录并说明编码
//   3. 延迟期间即可查到 pending；写出完成后 sent；清空移除全部记录（含待发送项）
//      但不取消响应，清空前已接收的请求完成后不重新出现，编号不复用
//   4. 成功与失败的重载都保留记录；在途记录保持接收时的版本与计划响应
//   5. 管理范围（/__contractlab 本身及前缀）内请求不记录、不消费序列
//   6. 写出完成前连接断开标记 interrupted；预留后断开仍保持消费
//
// 全部通过真实本机服务（端口 0）与真实 HTTP 请求验证，不依赖固定端口；
// 状态变化用轮询等待（有界超时），不依赖固定等待时长。

import assert from 'node:assert/strict';
import http from 'node:http';
import test, { type TestContext } from 'node:test';
import {
  makeTempDir,
  sendRequest,
  startServer,
  writeConfig,
  writeText,
  type RunningServer,
} from './helpers.ts';

interface RecordEntry {
  readonly id: number;
  readonly method: string;
  readonly target: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: { readonly encoding: string; readonly text?: string; readonly base64?: string };
  readonly version: number;
  readonly matched: boolean;
  readonly endpoint: string | null;
  readonly bodyCheck: { readonly result: string; readonly report?: unknown };
  readonly position: number | null;
  readonly response: {
    readonly status: number;
    readonly headers: { readonly [name: string]: string };
    readonly body: string;
  };
  readonly state: string;
}

async function getRecords(port: number): Promise<RecordEntry[]> {
  const res = await sendRequest(port, {
    method: 'GET',
    path: '/__contractlab/requests',
    headers: {},
    body: '',
  });
  assert.equal(res.status, 200);
  return (JSON.parse(res.body) as { records: RecordEntry[] }).records;
}

async function clearRecords(port: number): Promise<{ ok: boolean; cleared: number }> {
  const res = await sendRequest(port, {
    method: 'POST',
    path: '/__contractlab/requests/clear',
    headers: {},
    body: '',
  });
  assert.equal(res.status, 200);
  return JSON.parse(res.body) as { ok: boolean; cleared: number };
}

// 轮询直到条件满足（有界超时），用于等待发送状态等异步变化
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待条件超过 ${timeoutMs}ms 仍未满足`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitRecordState(
  port: number,
  id: number,
  state: string,
): Promise<RecordEntry> {
  return waitFor(async () => {
    const list = await getRecords(port);
    const rec = list.find((r) => r.id === id);
    return rec && rec.state === state ? rec : undefined;
  });
}

async function withServer(
  t: TestContext,
  config: unknown,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const dir = await makeTempDir(t);
  const configPath = await writeConfig(dir, 'scenes.json', config);
  const server: RunningServer = await startServer(configPath);
  t.after(() => server.close());
  await run(server.port);
}

test('场景响应、400、404 各记录一次；编号、位置、计划响应与状态正确', async (t) => {
  const config = {
    endpoints: [
      {
        method: 'GET',
        path: '/api/order',
        responses: [
          { status: 299, headers: {}, body: 'first', delay: 0 },
          { status: 288, headers: {}, body: 'second', delay: 0 },
        ],
      },
      {
        method: 'POST',
        path: '/api/echo',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'integer', required: true } },
        },
        responses: [{ status: 201, headers: {}, body: 'ok', delay: 0 }],
      },
    ],
  };
  await withServer(t, config, async (port) => {
    const get = (path: string) =>
      sendRequest(port, { method: 'GET', path, headers: {}, body: '' });

    const r1 = await get('/api/order?x=1'); // 查询串不参与匹配，但须记入目标
    assert.equal(r1.status, 299);
    const r2 = await get('/api/order');
    assert.equal(r2.status, 288);
    const r3 = await get('/api/order'); // 末项复用
    assert.equal(r3.status, 288);
    const r4 = await sendRequest(port, {
      method: 'POST',
      path: '/api/echo',
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":"oops"}',
    });
    assert.equal(r4.status, 400);
    const r5 = await sendRequest(port, {
      method: 'POST',
      path: '/api/echo',
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":7}',
    });
    assert.equal(r5.status, 201);
    const r6 = await get('/missing');
    assert.equal(r6.status, 404);

    const records = await getRecords(port);
    assert.deepEqual(records.map((r) => r.id), [1, 2, 3, 4, 5, 6]);

    const [rec1, rec2, rec3, rec4, rec5, rec6] = records as [
      RecordEntry, RecordEntry, RecordEntry, RecordEntry, RecordEntry, RecordEntry,
    ];

    // 场景响应：原始目标（含查询串）、请求头、版本、消费位置、计划响应、发送完成
    assert.equal(rec1.method, 'GET');
    assert.equal(rec1.target, '/api/order?x=1');
    assert.equal(rec1.matched, true);
    assert.equal(rec1.endpoint, 'GET /api/order');
    assert.equal(rec1.version, 1);
    assert.equal(rec1.position, 0);
    assert.equal(rec1.bodyCheck.result, 'none');
    assert.deepEqual(rec1.body, { encoding: 'utf-8', text: '' });
    assert.equal(rec1.response.status, 299);
    assert.equal(rec1.response.body, 'first');
    assert.equal(rec1.response.headers['X-Contractlab-Version'], '1');
    assert.equal(rec1.state, 'sent');
    // 请求头按 [名称, 值] 对记录，至少包含 host
    assert.ok(rec1.headers.some(([name]) => name.toLowerCase() === 'host'));

    assert.equal(rec2.position, 1);
    assert.equal(rec3.position, 1); // 末项复用记录相同位置
    assert.equal(rec3.response.body, 'second');

    // 正文拒绝 400：保留实际返回的差异报告，无消费位置
    assert.equal(rec4.matched, true);
    assert.equal(rec4.bodyCheck.result, 'rejected');
    const report = rec4.bodyCheck.report as { error: string; problems: unknown[] };
    assert.equal(report.error, 'invalid_request_body');
    assert.ok(Array.isArray(report.problems) && report.problems.length > 0);
    assert.equal(rec4.position, null);
    assert.equal(rec4.response.status, 400);
    assert.equal(rec4.response.headers['X-Contractlab-Version'], '1');
    assert.equal(
      (JSON.parse(rec4.response.body) as { error: string }).error,
      'invalid_request_body',
    );
    assert.deepEqual(rec4.body, { encoding: 'utf-8', text: '{"id":"oops"}' });

    // 校验通过：passed + 正常消费位置
    assert.equal(rec5.bodyCheck.result, 'passed');
    assert.equal(rec5.position, 0);
    assert.equal(rec5.response.status, 201);

    // 未匹配 404：无消费位置
    assert.equal(rec6.matched, false);
    assert.equal(rec6.endpoint, null);
    assert.equal(rec6.position, null);
    assert.equal(rec6.response.status, 404);
    assert.equal(rec6.response.body, 'not found\n');
    assert.equal(rec6.state, 'sent');
  });
});

test('无效 UTF-8 正文以 base64 无损记录', async (t) => {
  const config = {
    endpoints: [
      {
        method: 'POST',
        path: '/api/raw',
        responses: [{ status: 200, headers: {}, body: 'ok', delay: 0 }],
      },
    ],
  };
  await withServer(t, config, async (port) => {
    const bytes = Buffer.from([0xff, 0x41, 0xfe, 0x00, 0x80]);
    const status = await new Promise<number>((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/raw',
          headers: { 'Content-Type': 'application/octet-stream' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      r.on('error', reject);
      r.end(bytes);
    });
    assert.equal(status, 200);

    const records = await getRecords(port);
    assert.equal(records.length, 1);
    const rec = records[0] as RecordEntry;
    assert.equal(rec.body.encoding, 'base64');
    assert.ok(rec.body.base64 !== undefined);
    assert.deepEqual(Buffer.from(rec.body.base64 as string, 'base64'), bytes);
  });
});

test('延迟期间 pending、完成后 sent；清空不取消响应且不重现，编号不复用', async (t) => {
  const config = {
    endpoints: [
      {
        method: 'GET',
        path: '/api/slow',
        responses: [{ status: 209, headers: {}, body: 'slow', delay: 300 }],
      },
      {
        method: 'GET',
        path: '/api/fast',
        responses: [{ status: 200, headers: {}, body: 'fast', delay: 0 }],
      },
    ],
  };
  await withServer(t, config, async (port) => {
    const get = (path: string) =>
      sendRequest(port, { method: 'GET', path, headers: {}, body: '' });

    // 延迟期间即可查到：pending + 计划响应已确定
    const p1 = get('/api/slow');
    const pending1 = await waitFor(async () => {
      const list = await getRecords(port);
      return list.length === 1 && list[0]?.state === 'pending' ? list[0] : undefined;
    });
    assert.equal(pending1.response.status, 209);
    assert.equal(pending1.response.body, 'slow');
    assert.equal(pending1.position, 0);
    assert.equal((await p1).status, 209);
    await waitRecordState(port, 1, 'sent');

    // 清空：移除含待发送项的全部记录，但不取消在途响应
    const p2 = get('/api/slow');
    await waitFor(async () => {
      const list = await getRecords(port);
      return list.length === 2 && list[1]?.state === 'pending' ? true : undefined;
    });
    const cleared = await clearRecords(port);
    assert.deepEqual(cleared, { ok: true, cleared: 2 });
    assert.deepEqual(await getRecords(port), []);
    assert.equal((await p2).status, 209); // 响应不被取消

    // 清空前已完整接收的请求完成后不得重新出现
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await getRecords(port), []);

    // 清空后才完整接收的请求正常记录；编号不复用
    const r3 = await get('/api/fast');
    assert.equal(r3.status, 200);
    const records = await getRecords(port);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.id, 3);
    assert.equal(records[0]?.state, 'sent');
  });
});

test('成功与失败的重载都保留记录；记录保持接收时的版本与计划响应', async (t) => {
  const dir = await makeTempDir(t);
  const configPath = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'GET',
        path: '/api/a',
        responses: [{ status: 200, headers: {}, body: 'v1', delay: 0 }],
      },
    ],
  });
  const server = await startServer(configPath);
  t.after(() => server.close());
  const port = server.port;
  const get = (path: string) => sendRequest(port, { method: 'GET', path, headers: {}, body: '' });
  const reload = () =>
    sendRequest(port, { method: 'POST', path: '/__contractlab/reload', headers: {}, body: '' });

  await get('/api/a');

  // 成功重载：版本 +1，旧记录保留且版本快照不变
  await writeText(dir, 'scenes.json', `${JSON.stringify({
    endpoints: [
      {
        method: 'GET',
        path: '/api/a',
        responses: [{ status: 200, headers: {}, body: 'v2', delay: 0 }],
      },
    ],
  })}\n`);
  const ok = JSON.parse((await reload()).body) as { ok: boolean; version: number };
  assert.deepEqual(ok, { ok: true, version: 2 });
  await get('/api/a');

  // 失败重载：记录仍然保留
  await writeText(dir, 'scenes.json', '{not json');
  const failed = JSON.parse((await reload()).body) as { ok: boolean; version: number };
  assert.equal(failed.ok, false);
  assert.equal(failed.version, 2);

  const records = await getRecords(port);
  assert.deepEqual(records.map((r) => r.id), [1, 2]);
  const [rec1, rec2] = records as [RecordEntry, RecordEntry];
  assert.equal(rec1.version, 1);
  assert.equal(rec1.response.body, 'v1');
  assert.equal(rec1.response.headers['X-Contractlab-Version'], '1');
  assert.equal(rec2.version, 2);
  assert.equal(rec2.response.body, 'v2');
  assert.equal(rec2.response.headers['X-Contractlab-Version'], '2');
});

test('管理范围内的请求不记录、不消费业务序列', async (t) => {
  const config = {
    endpoints: [
      {
        method: 'GET',
        path: '/api/a',
        responses: [
          { status: 201, headers: {}, body: 'one', delay: 0 },
          { status: 202, headers: {}, body: 'two', delay: 0 },
        ],
      },
    ],
  };
  await withServer(t, config, async (port) => {
    const call = (method: string, path: string) =>
      sendRequest(port, { method, path, headers: {}, body: '' });

    await call('GET', '/__contractlab/health');
    await call('POST', '/__contractlab/reload');
    await call('GET', '/__contractlab/requests');
    await call('POST', '/__contractlab/requests/clear');
    await call('GET', '/__contractlab'); // 管理根本身也在管理范围内
    await call('GET', '/__contractlab/unknown'); // 前缀下未知路径：404 但不记录
    await call('POST', '/__contractlab/health'); // 方法不符：404 但不记录
    assert.deepEqual(await getRecords(port), []);

    // 管理请求没有消费业务序列：第一次业务请求仍取第 1 项
    const r1 = await call('GET', '/api/a');
    assert.equal(r1.status, 201);
    const records = await getRecords(port);
    assert.deepEqual(records.map((r) => r.id), [1]);
    assert.equal(records[0]?.position, 0);
  });
});

test('写出完成前连接断开标记 interrupted；预留后断开仍保持消费', async (t) => {
  const config = {
    endpoints: [
      {
        method: 'GET',
        path: '/api/slow',
        responses: [
          { status: 201, headers: {}, body: 'one', delay: 400 },
          { status: 202, headers: {}, body: 'two', delay: 0 },
        ],
      },
    ],
  };
  await withServer(t, config, async (port) => {
    // 发出请求后在延迟结束前断开连接
    await new Promise<void>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/slow' });
      r.on('error', () => undefined); // 主动断开导致的错误忽略
      r.end();
      setTimeout(() => {
        r.destroy();
        resolve();
      }, 50);
    });

    const rec = await waitRecordState(port, 1, 'interrupted');
    assert.equal(rec.position, 0); // 预留位置保留
    assert.equal(rec.response.status, 201);

    // 断开仍计为消费：下一请求取第 2 项
    const r2 = await sendRequest(port, {
      method: 'GET',
      path: '/api/slow',
      headers: {},
      body: '',
    });
    assert.equal(r2.status, 202);
    const records = await getRecords(port);
    assert.equal(records.length, 2);
    assert.equal(records[1]?.position, 1);
    assert.equal(records[1]?.state, 'sent');
  });
});

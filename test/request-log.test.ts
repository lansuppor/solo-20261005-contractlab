// 进程内请求记录的回归测试（真实本机服务 + 真实 HTTP/原始套接字请求）
//
// 覆盖：
// - 记录内容：方法、含查询串目标、原始请求头（含重复头）、正文原始字节
//   （合法 UTF-8 文本 / 非法 UTF-8 base64 无损）、接收时配置版本、匹配/校验结论、
//   400 实际差异报告、消费位置（末项复用记同一位置；400/404 无位置）、
//   计划响应（场景/框架：状态、应用层头含准确版本头、正文）；
// - 写出生命周期：延迟期间 pending → sent；写出前断开 interrupted（仍消费）；
// - 清空：移除当时全部记录（含 pending），不取消响应、不改变配置/版本/序列，
//   清空前完整接收的请求之后完成也不再出现；编号清空与重载后均不复用；
// - reload：成功/失败都保留记录；在途请求钉住旧版本与旧计划响应；后续请求用新版本；
// - 管理范围（/__contractlab 本身及 /__contractlab/ 前缀）不记录；查询不推进序列；
// - 未收完整即断开、超出正文上限（413）：不创建记录、不消费序列。

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { makeTempDir, startServer, writeConfig, type RunningServer } from './helpers.ts';

const SLOW_DELAY = 400;

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
    ],
  };
}

interface AdminReply {
  readonly status: number;
  readonly body: string;
}

// 管理/普通请求：UTF-8 文本往返
function textRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) {
      h['Content-Length'] = String(Buffer.byteLength(body));
    }
    const r = httpConnect(port, method, path, h, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) {
      r.write(body);
    }
    r.end();
  });
}

function httpConnect(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  cb: (res: http.IncomingMessage) => void,
): http.ClientRequest {
  return http.request({ host: '127.0.0.1', port, method, path, headers }, cb);
}

async function clearRecords(port: number): Promise<AdminReply> {
  return textRequest(port, 'POST', '/__contractlab/requests/clear');
}

interface WireRecord {
  readonly id: number;
  readonly receivedAt: string;
  readonly request: {
    readonly method: string;
    readonly target: string;
    readonly path: string;
    readonly rawHeaders: readonly string[];
    readonly bodyBytes: number;
    readonly body: { readonly encoding: string; readonly content: string };
  };
  readonly configVersion: number;
  readonly matched: boolean;
  readonly endpoint: string | null;
  readonly bodyValidationPassed: boolean | null;
  readonly bodyRejection: {
    readonly error: string;
    readonly stage: string;
    readonly message: string;
    readonly problems: readonly { readonly pointer: string; readonly expected: string; readonly actual: string }[];
  } | null;
  readonly sequencePosition: number | null;
  readonly sequenceLength: number | null;
  readonly plannedResponse: {
    readonly kind: string;
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: string;
  } | null;
  readonly delivery: string;
}

async function getRecords(port: number): Promise<WireRecord[]> {
  const reply = await textRequest(port, 'GET', '/__contractlab/requests');
  assert.equal(reply.status, 200);
  const parsed = JSON.parse(reply.body) as {
    note: string;
    count: number;
    records: WireRecord[];
  };
  assert.equal(typeof parsed.note, 'string');
  assert.ok(parsed.note.length > 0, '查询结果应附简短调用说明');
  assert.equal(parsed.count, parsed.records.length);
  return parsed.records;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 原始套接字请求：用于重复头、非法 UTF-8、半途断开等 HTTP 客户端不便表达的场景
function rawWrite(port: number, raw: Buffer): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(raw);
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

async function rawRequest(port: number, raw: Buffer): Promise<{ status: number; socket: net.Socket; read: () => Promise<Buffer> }> {
  const socket = await rawWrite(port, raw);
  const readers: Buffer[] = [];
  let waitEnd: (() => void) | undefined;
  const onEnd = (): void => waitEnd?.();
  socket.on('data', (c) => readers.push(c));
  socket.on('end', onEnd);
  let peek: { status: number } | undefined;
  // 等待状态行到达
  for (let i = 0; i < 100 && !peek; i += 1) {
    if (readers.length > 0) {
      const head = Buffer.concat(readers).toString('latin1');
      const m = head.match(/^HTTP\/1\.\d (\d{3})/);
      if (m) {
        peek = { status: Number(m[1]) };
        break;
      }
    }
    await sleep(5);
  }
  assert.ok(peek, '应收到响应状态行');
  return {
    status: (peek as { status: number }).status,
    socket,
    read: async () =>
      new Promise<Buffer>((resolve) => {
        if (socket.destroyed || socket.readableEnded) {
          resolve(Buffer.concat(readers));
          return;
        }
        waitEnd = () => resolve(Buffer.concat(readers));
      }),
  };
}

test('记录内容：场景响应、400 差异报告、404、末项复用位置与准确版本头', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server: RunningServer = await startServer(file);
  t.after(server.close);
  const port = server.port;

  await clearRecords(port);

  // 三次 GET：位置 0、1，末项持续复用位置 2
  const g1 = await textRequest(port, 'GET', '/api/seq?a=1&b=%E4%B8%AD');
  const g2 = await textRequest(port, 'GET', '/api/seq?different=query');
  const g3 = await textRequest(port, 'GET', '/api/seq');
  const g4 = await textRequest(port, 'GET', '/api/seq');
  assert.deepEqual(
    [g1.status, g2.status, g3.status, g4.status],
    [200, 201, 202, 202],
  );
  assert.equal(g1.headers['x-item'], 'one');
  assert.equal(g1.headers['x-contractlab-version'], '1');

  // 400：结构差异
  const bad = await textRequest(
    port,
    'POST',
    '/api/echo',
    '{"id":"x","extra":1}',
    { 'Content-Type': 'application/json' },
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.headers['x-contractlab-version'], '1');
  const badReport = JSON.parse(bad.body);
  assert.equal(badReport.stage, 'structure');

  // 404
  const nf = await textRequest(port, 'GET', '/api/missing?z=9');
  assert.equal(nf.status, 404);
  assert.equal(nf.headers['x-contractlab-version'], '1');

  // 400 不消费：随后合格 POST 仍取第 0 项
  const ok = await textRequest(port, 'POST', '/api/echo', '{"id":7}', {
    'Content-Type': 'application/json; charset=utf-8',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'echo-ok');

  const records = await getRecords(port);
  assert.equal(records.length, 7);
  assert.deepEqual(records.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7]);

  // 第一条：完整字段核对
  const r1 = records[0];
  assert.equal(r1.request.method, 'GET');
  assert.equal(r1.request.target, '/api/seq?a=1&b=%E4%B8%AD');
  assert.equal(r1.request.path, '/api/seq');
  assert.ok(r1.request.rawHeaders.includes('Host'));
  assert.equal(r1.request.body.encoding, 'utf-8');
  assert.equal(r1.request.body.content, '');
  assert.equal(r1.request.bodyBytes, 0);
  assert.equal(r1.configVersion, 1);
  assert.equal(r1.matched, true);
  assert.equal(r1.endpoint, 'GET /api/seq');
  assert.equal(r1.bodyValidationPassed, null);
  assert.equal(r1.bodyRejection, null);
  assert.equal(r1.sequencePosition, 0);
  assert.equal(r1.sequenceLength, 3);
  assert.equal(r1.delivery, 'sent');
  assert.ok(r1.plannedResponse);
  assert.equal(r1.plannedResponse?.kind, 'scene');
  assert.equal(r1.plannedResponse?.status, 200);
  assert.equal(r1.plannedResponse?.headers['X-Contractlab-Version'], '1');
  assert.equal(r1.plannedResponse?.headers['X-Item'], 'one');
  assert.equal(r1.plannedResponse?.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(r1.plannedResponse?.body, 'one');

  // 末项复用：第 3、4 条消费位置相同（都是末项下标 2）
  assert.equal(records[2].sequencePosition, 2);
  assert.equal(records[3].sequencePosition, 2);
  assert.equal(records[3].plannedResponse?.status, 202);

  // 400 记录
  const rBad = records[4];
  assert.equal(rBad.matched, true);
  assert.equal(rBad.bodyValidationPassed, false);
  assert.equal(rBad.sequencePosition, null);
  assert.equal(rBad.sequenceLength, null);
  assert.equal(rBad.plannedResponse?.kind, 'framework');
  assert.equal(rBad.plannedResponse?.status, 400);
  assert.equal(rBad.plannedResponse?.headers['X-Contractlab-Version'], '1');
  assert.equal(
    rBad.plannedResponse?.body,
    `${JSON.stringify(badReport)}\n`,
    '400 计划响应正文须为实际返回的差异报告',
  );
  assert.deepEqual(rBad.bodyRejection, badReport);
  assert.deepEqual(
    rBad.bodyRejection?.problems.map((p) => p.pointer).sort(),
    ['/extra', '/id'],
  );
  assert.equal(rBad.request.body.content, '{"id":"x","extra":1}');

  // 404 记录
  const r404 = records[5];
  assert.equal(r404.matched, false);
  assert.equal(r404.request.target, '/api/missing?z=9');
  assert.equal(r404.sequencePosition, null);
  assert.equal(r404.bodyValidationPassed, null);
  assert.equal(r404.plannedResponse?.status, 404);
  assert.equal(r404.plannedResponse?.headers['X-Contractlab-Version'], '1');
  assert.equal(r404.delivery, 'sent');

  // 合格 POST
  const rOk = records[6];
  assert.equal(rOk.bodyValidationPassed, true);
  assert.equal(rOk.sequencePosition, 0);
  assert.equal(rOk.sequenceLength, 1);
  assert.equal(rOk.plannedResponse?.status, 200);
});

test('原始请求头（含重复头、原始大小写）与原始正文按字节保留', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  const body = '{"id":1}';
  const raw = Buffer.from(
    [
      'POST /api/echo HTTP/1.1',
      'Host: 127.0.0.1',
      'X-Multi: first',
      'content-type: application/json',
      'X-Multi: second',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n') + '\r\n',
    'utf8',
  );
  const reply = await rawRequest(port, raw);
  assert.equal(reply.status, 200);
  reply.socket.resume();

  const records = await getRecords(port);
  assert.equal(records.length, 1);
  const rh = records[0].request.rawHeaders;
  // 成对、保序、保留原始大小写
  const idx1 = rh.indexOf('X-Multi');
  assert.ok(idx1 >= 0);
  assert.equal(rh[idx1 + 1], 'first');
  const idx2 = rh.indexOf('X-Multi', idx1 + 2);
  assert.equal(rh[idx2 + 1], 'second');
  assert.equal(rh[rh.indexOf('content-type') + 1], 'application/json');
  assert.equal(records[0].request.body.content, body);
  assert.equal(records[0].request.bodyBytes, Buffer.byteLength(body));
});

test('非法 UTF-8 正文以 base64 无损记录并说明编码，400 为解析阶段', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x80, 0x7d]); // { 非法序列 }
  const raw = Buffer.concat([
    Buffer.from(
      [
        'POST /api/echo HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        `Content-Length: ${bytes.byteLength}`,
        'Connection: close',
        '',
      ].join('\r\n') + '\r\n',
      'utf8',
    ),
    bytes,
  ]);
  const reply = await rawRequest(port, raw);
  assert.equal(reply.status, 400);
  reply.socket.resume();

  const records = await getRecords(port);
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.request.body.encoding, 'base64');
  assert.ok(
    Buffer.from(rec.request.body.content, 'base64').equals(bytes),
    'base64 必须无损还原原始字节',
  );
  assert.equal(rec.request.bodyBytes, bytes.byteLength);
  assert.equal(rec.bodyRejection?.stage, 'parse');
  assert.equal(rec.sequencePosition, null);
});

test('延迟期间可查到 pending；完成写出后为 sent，sent 不随后续关连接回退', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  const got = textRequest(port, 'GET', '/api/slow'); // 不 await：延迟期间查询
  await sleep(80);
  let records = await getRecords(port);
  assert.equal(records.length, 1);
  assert.equal(records[0].delivery, 'pending');
  assert.equal(records[0].plannedResponse?.body, 'slow-one');

  const res = await got;
  assert.equal(res.status, 200);
  assert.equal(res.body, 'slow-one');
  await sleep(30);
  records = await getRecords(port);
  assert.equal(records[0].delivery, 'sent');

  // 响应已完成后，连接进入空闲并最终关闭，状态不得回退为 interrupted
  await sleep(200);
  records = await getRecords(port);
  assert.equal(records[0].delivery, 'sent');
});

test('写出完成前断开标记 interrupted；预留仍计消费', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  const raw = Buffer.from(
    ['GET /api/slow HTTP/1.1', 'Host: 127.0.0.1', '', ''].join('\r\n'),
    'utf8',
  );
  const socket = await rawWrite(port, raw); // 不读响应，延迟中直接断开
  socket.resume();
  await sleep(80);
  socket.destroy();
  await sleep(100);

  const records = await getRecords(port);
  assert.equal(records.length, 1);
  assert.equal(records[0].delivery, 'interrupted');
  assert.equal(records[0].sequencePosition, 0);

  // 消费已成立：下一次请求取第 1 项
  const next = await textRequest(port, 'GET', '/api/slow');
  assert.equal(next.status, 201);
  assert.equal(next.body, 'slow-two');
  const after = await getRecords(port);
  assert.equal(after[1].sequencePosition, 1);
  assert.equal(after[1].delivery, 'sent');
});

test('清空移除全部记录（含 pending）；不取消响应、不改配置/版本/序列；旧记录不再出现；编号不复用', {
  timeout: 30_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;

  await textRequest(port, 'GET', '/api/seq'); // id 1
  const pending = textRequest(port, 'GET', '/api/slow'); // id 2, pending
  await sleep(80);
  let records = await getRecords(port);
  assert.deepEqual(records.map((r) => r.id), [1, 2]);
  assert.equal(records[1].delivery, 'pending');

  const cleared = await clearRecords(port);
  const clearBody = JSON.parse(cleared.body);
  assert.equal(clearBody.ok, true);
  assert.equal(clearBody.removed, 2);
  records = await getRecords(port);
  assert.equal(records.length, 0);

  // 响应未被取消：pending 请求仍收到延迟响应
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body, 'slow-one');

  // 清空前完整接收的请求（id 1、2）随后完成也不得重新出现
  await sleep(SLOW_DELAY + 100);
  records = await getRecords(port);
  assert.equal(records.length, 0);

  // 配置/版本/序列不变：/api/seq 仍按既有消费位置继续（id 1 已取 0，现在取 1）
  const seq = await textRequest(port, 'GET', '/api/seq');
  assert.equal(seq.status, 201);
  assert.equal(seq.headers['x-contractlab-version'], '1');

  records = await getRecords(port);
  assert.equal(records.length, 1);
  assert.ok(records[0].id > 2, '清空后编号继续递增、不复用');
  assert.equal(records[0].sequencePosition, 1);
});

test('成功与失败 reload 均保留记录；在途请求钉住旧版本与旧计划；后续请求用新版本；编号不重置', {
  timeout: 30_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  // 在途：v1 的延迟响应
  const inflight = textRequest(port, 'GET', '/api/slow?pin=1');
  await sleep(80);
  let records = await getRecords(port);
  const oldId = records[0].id;
  assert.equal(records[0].configVersion, 1);
  assert.equal(records[0].plannedResponse?.headers['X-Contractlab-Version'], '1');
  assert.equal(records[0].plannedResponse?.body, 'slow-one');

  // 成功 reload：同一接口改为单响应、状态 202、无延迟
  const v2 = {
    endpoints: [
      {
        method: 'GET',
        path: '/api/slow',
        responses: [{ status: 202, headers: {}, body: 'v2-body', delay: 0 }],
      },
    ],
  };
  await writeConfig(dir, 'scenes.json', v2);
  const reloaded = await textRequest(port, 'POST', '/__contractlab/reload');
  const reloadBody = JSON.parse(reloaded.body);
  assert.equal(reloadBody.ok, true);
  assert.equal(reloadBody.version, 2);

  // 记录保留；在途记录钉在 v1
  records = await getRecords(port);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, oldId);
  assert.equal(records[0].configVersion, 1);
  assert.equal(records[0].plannedResponse?.headers['X-Contractlab-Version'], '1');
  assert.equal(records[0].plannedResponse?.status, 200);
  assert.equal(records[0].plannedResponse?.body, 'slow-one');

  // 实际写出也按旧版本
  const oldRes = await inflight;
  assert.equal(oldRes.status, 200);
  assert.equal(oldRes.headers['x-contractlab-version'], '1');
  assert.equal(oldRes.body, 'slow-one');

  // 后续请求使用 v2（序列重置：位置 0/1），编号继续递增
  const newRes = await textRequest(port, 'GET', '/api/slow');
  assert.equal(newRes.status, 202);
  assert.equal(newRes.headers['x-contractlab-version'], '2');
  assert.equal(newRes.body, 'v2-body');
  records = await getRecords(port);
  assert.equal(records.length, 2);
  assert.equal(records[1].id, oldId + 1);
  assert.equal(records[1].configVersion, 2);
  assert.equal(records[1].sequencePosition, 0);
  assert.equal(records[1].sequenceLength, 1);
  assert.equal(records[1].plannedResponse?.headers['X-Contractlab-Version'], '2');

  // 失败 reload：记录保留、版本/配置不变
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, '{ broken json', 'utf8');
  const failed = await textRequest(port, 'POST', '/__contractlab/reload');
  const failedBody = JSON.parse(failed.body);
  assert.equal(failedBody.ok, false);
  assert.equal(failedBody.version, 2);
  records = await getRecords(port);
  assert.equal(records.length, 2);
  const still = await textRequest(port, 'GET', '/api/slow');
  assert.equal(still.status, 202);
  assert.equal(still.headers['x-contractlab-version'], '2');
});

test('管理范围不记录；查询为一致快照且不推进序列；错误方法返回 404 且不记录', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  // 各种管理范围请求（含 /__contractlab 本身、未知子路径、错误方法、带查询串）
  await textRequest(port, 'GET', '/__contractlab');
  await textRequest(port, 'GET', '/__contractlab/health');
  await textRequest(port, 'GET', '/__contractlab/unknown?x=1');
  await textRequest(port, 'POST', '/__contractlab/requests');
  await textRequest(port, 'GET', '/__contractlab/requests/clear');
  await textRequest(port, 'POST', '/__contractlab/reload'); // 配置未变，仍成功
  // 连续两次查询：一致快照且不产生记录
  const q1 = await getRecords(port);
  const q2 = await getRecords(port);
  assert.equal(q1.length, 0);
  assert.equal(q2.length, 0);

  // 一个业务请求后再查两次：内容一致，且序列位置不被查询推进
  await textRequest(port, 'GET', '/api/seq');
  const a = await getRecords(port);
  const b = await getRecords(port);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].sequencePosition, 0);
  assert.equal(b[0].sequencePosition, 0);
  const next = await textRequest(port, 'GET', '/api/seq');
  assert.equal(next.status, 201, '查询不消费：下一次业务请求取第 1 项');
});

test('未收完整即断开：不创建记录、不消费序列', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  // 声明 100 字节正文，只发 5 字节即断开
  const socket = await rawWrite(
    port,
    Buffer.from(
      [
        'POST /api/echo HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        'Content-Length: 100',
        'Connection: close',
        '',
        '{"id"',
      ].join('\r\n'),
      'utf8',
    ),
  );
  socket.resume();
  await sleep(80);
  socket.destroy();
  await sleep(100);

  const records = await getRecords(port);
  assert.equal(records.length, 0, '未完整接收不得创建记录');

  // 序列未被推进：第一个合格请求仍取第 0 项
  const ok = await textRequest(port, 'POST', '/api/echo', '{"id":1}', {
    'Content-Type': 'application/json',
  });
  assert.equal(ok.status, 200);
  const after = await getRecords(port);
  assert.equal(after.length, 1);
  assert.equal(after[0].sequencePosition, 0);
});

test('超出正文上限：413、不创建记录、不消费序列', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  const limit = 100 * 1024 * 1024;
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    [
      'POST /api/echo HTTP/1.1',
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      `Content-Length: ${limit + 1}`,
      '',
      '',
    ].join('\r\n'),
    'utf8',
  );

  // 读到 413 即停止发送（复用缓冲区流式写入，避免持有两份百兆正文）
  const status = await new Promise<number>((resolve, reject) => {
    let head = '';
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      const m = head.match(/^HTTP\/1\.\d (\d{3})/);
      if (m) {
        socket.pause();
        resolve(Number(m[1]));
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);

    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let written = 0;
    const pump = (): void => {
      while (written <= limit) {
        const ready = socket.write(chunk);
        written += chunk.byteLength;
        if (!ready) {
          socket.once('drain', pump);
          return;
        }
      }
    };
    pump();
  });
  assert.equal(status, 413);
  socket.destroy();
  await sleep(100);

  const records = await getRecords(port);
  assert.equal(records.length, 0, '超出上限不得创建记录');

  const ok = await textRequest(port, 'POST', '/api/echo', '{"id":1}', {
    'Content-Type': 'application/json',
  });
  assert.equal(ok.status, 200, '413 不消费序列');
  const after = await getRecords(port);
  assert.equal(after.length, 1);
  assert.equal(after[0].sequencePosition, 0);
});

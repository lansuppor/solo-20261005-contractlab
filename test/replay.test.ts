// 本机请求重放与响应差异报告（replay 子命令）的回归测试
//
// 覆盖：
// - 由真实本机服务产生 GET /__contractlab/requests 快照，重放到加载相同配置的
//   另一台真实服务：全部相同、退出 0（含场景 500、400 差异报告、404、查询串）；
// - 重放到加载不同配置的真实服务：状态/正文差异被逐条指出，退出 1；
// - 通信失败：端口无监听（连接失败）、静默服务器（总超时到期，持续连接不延长）、
//   响应中途断开（部分响应不算完整），均记 failed、关闭连接后继续后续记录；
// - 发送字节核对（原始捕获服务器）：业务头大小写/重复/顺序保留，Host、Expect、
//   逐跳与分帧头（含 Connection 指名的头）被剥落，Host 与 Content-Length 按
//   目标与实际字节数重建，请求目标保留查询串与百分号编码，正文（含 BOM）无损；
//   Content-Length、chunked、连接关闭界定三种完整响应形式都可识别；
//   pending / interrupted 记录同样重放；
// - 输入失败（非 GET/POST、管理范围路径、非法目标、计划响应缺失/非法、孤立
//   代理项、不可发送的头名称/值、非法端口/超时参数）：退出 2、stderr 指明
//   文件与字段、stdout 为空且不发任何请求。

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test, { type TestContext } from 'node:test';
import {
  makeTempDir,
  runCli,
  startServer,
  writeConfig,
  writeText,
  type CliResult,
} from './helpers.ts';

// ---------------------------------------------------------------------------
// 场景配置
// ---------------------------------------------------------------------------

function configA(): unknown {
  return {
    endpoints: [
      {
        method: 'GET',
        path: '/api/seq',
        responses: [{ status: 200, headers: {}, body: 'seq-ok', delay: 0 }],
      },
      {
        method: 'POST',
        path: '/api/order',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [{ status: 500, headers: {}, body: 'order-boom', delay: 0 }],
      },
      {
        method: 'POST',
        path: '/api/echo',
        responses: [{ status: 201, headers: {}, body: 'echo-ok', delay: 0 }],
      },
    ],
  };
}

// 场景 B：/api/order 规则改严（id 变 string）、删除 /api/echo、/api/seq 改响应
function configB(): unknown {
  return {
    endpoints: [
      {
        method: 'GET',
        path: '/api/seq',
        responses: [{ status: 200, headers: {}, body: 'seq-changed', delay: 0 }],
      },
      {
        method: 'POST',
        path: '/api/order',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'string', required: true } },
          additionalProperties: true,
        },
        responses: [{ status: 200, headers: {}, body: 'order-ok', delay: 0 }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 原始请求收发（用于生成真实快照）
// ---------------------------------------------------------------------------

function rawJson(method: string, target: string, body: string): Buffer {
  const lines = [
    `${method} ${target} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    '',
  ];
  return Buffer.concat([Buffer.from(lines.join('\r\n'), 'utf8'), Buffer.from(body, 'utf8')]);
}

function rawExchange(port: number, raw: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('end', () => {
      const head = Buffer.concat(chunks).toString('latin1');
      const m = head.match(/^HTTP\/1\.\d (\d{3})/);
      if (m) {
        resolve(Number(m[1]));
      } else {
        reject(new Error(`未收到完整响应状态行：${head.slice(0, 120)}`));
      }
    });
    socket.on('error', reject);
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error('原始请求 10s 内未完成（疑似卡住）'));
    });
  });
}

function httpGetBody(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (data += d));
      res.on('end', () => resolve(data));
    });
    r.on('error', reject);
    r.setTimeout(10_000, () => r.destroy(new Error(`GET ${path} 超时`)));
  });
}

// ---------------------------------------------------------------------------
// 原始捕获服务器：逐连接接收完整请求，把请求字节交给处理器换取响应字节
// ---------------------------------------------------------------------------

interface CaptureServer {
  readonly port: number;
  // 已收到的完整请求原始字节（按到达顺序）
  readonly requests: Buffer[];
  // 建立过的连接数（含未发完整请求的）
  readonly connections: () => number;
  readonly close: () => Promise<void>;
}

// handler 返回响应字节；返回 null 表示永不响应（用于超时用例）；
// 返回 'close' 表示立即断开
async function startCaptureServer(
  t: TestContext,
  handler: (request: Buffer) => Buffer | null | 'close',
): Promise<CaptureServer> {
  const requests: Buffer[] = [];
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let responded = false;
    socket.on('data', (chunk: Buffer) => {
      if (responded) {
        return;
      }
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      // 按 Content-Length 判断请求是否收完整（本测试只发固定长度请求）
      const headEnd = buffer.indexOf('\r\n\r\n');
      if (headEnd < 0) {
        return;
      }
      const head = buffer.toString('latin1', 0, headEnd);
      const m = /content-length:\s*(\d+)/i.exec(head);
      const need = headEnd + 4 + (m ? Number(m[1]) : 0);
      if (buffer.length < need) {
        return;
      }
      responded = true;
      requests.push(buffer.subarray(0, need));
      const response = handler(buffer.subarray(0, need));
      if (response === null) {
        return; // 永不响应：保持连接，等客户端超时
      }
      if (response === 'close') {
        socket.destroy();
        return;
      }
      socket.end(response);
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
    await once(server, 'close').catch(() => undefined);
  };
  t.after(close);
  return { port, requests, connections: () => connections, close };
}

// ---------------------------------------------------------------------------
// 快照构造与运行
// ---------------------------------------------------------------------------

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

interface ReplayReport {
  readonly total: number;
  readonly same: number;
  readonly different: number;
  readonly failed: number;
  readonly results: readonly {
    readonly id: number;
    readonly outcome: string;
    readonly differences?: readonly string[];
    readonly planned?: { readonly status: number; readonly body: string };
    readonly response?: {
      readonly status: number;
      readonly body: { readonly encoding: string; readonly content: string };
    };
    readonly reason?: string;
  }[];
}

function runReplay(requests: string, port: number, timeout = 5_000): Promise<CliResult> {
  return runCli(['replay', '--requests', requests, '--port', String(port), '--timeout', String(timeout)]);
}

// 由真实本机服务产生一批请求的快照文件
async function generateSnapshot(t: TestContext, dir: string): Promise<string> {
  const configFile = await writeConfig(dir, 'scenes-a.json', configA());
  const server = await startServer(configFile);
  t.after(server.close);

  const exchanges: [Buffer, number][] = [
    [rawJson('GET', '/api/seq?a=1&b=%E4%B8%AD', ''), 200],
    [rawJson('POST', '/api/order', '{"id":1}'), 500], // 场景 500 也按内容比较
    [rawJson('POST', '/api/order', '{"id":"x","extra":1}'), 400],
    [rawJson('POST', '/api/echo', 'hello'), 201],
    [rawJson('GET', '/api/missing', ''), 404],
  ];
  for (const [raw, expected] of exchanges) {
    const status = await rawExchange(server.port, raw);
    assert.equal(status, expected, '生成快照时的在线状态码');
  }

  const snapshotText = await httpGetBody(server.port, '/__contractlab/requests');
  const snapshot = JSON.parse(snapshotText) as { count: number };
  assert.equal(snapshot.count, exchanges.length);
  return writeText(dir, 'snapshot.json', snapshotText);
}

// 手工快照的基础记录（只含重建与重放所需字段，其余字段不被信任）
function baseRecord(): Record<string, unknown> {
  return {
    id: 1,
    request: {
      method: 'GET',
      target: '/api/seq?x=1',
      path: '/api/seq',
      rawHeaders: ['Host', '127.0.0.1'],
      bodyBytes: 0,
      body: { encoding: 'utf-8', content: '' },
    },
    plannedResponse: { kind: 'scene', status: 200, headers: {}, body: 'seq-ok' },
    delivery: 'sent',
  };
}

function baseSnapshot(): Record<string, unknown> {
  return { note: 'base', count: 1, records: [baseRecord()] };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('真实快照重放到相同配置服务：全部相同退出 0，逐条保留原编号与无损响应', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const snapshotFile = await generateSnapshot(t, dir);

  // 另一台加载相同配置的真实服务（序列从头开始，响应逐项一致）
  const replayConfig = await writeConfig(dir, 'scenes-a2.json', configA());
  const server = await startServer(replayConfig);
  t.after(server.close);

  const result = await runReplay(snapshotFile, server.port);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0, `全部相同应退出 0：${result.stderr}`);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.total, 5);
  assert.equal(report.same, 5);
  assert.equal(report.different, 0);
  assert.equal(report.failed, 0);
  assert.deepEqual(
    report.results.map((r) => r.id),
    [1, 2, 3, 4, 5],
    '按输入顺序保留原编号',
  );
  assert.ok(
    report.results.every((r) => r.outcome === 'same'),
    '全部记录相同',
  );
  // 完整响应保留状态及无损正文（场景 500、400 差异报告、404 都按内容比较）
  assert.equal(report.results[1].response?.status, 500);
  assert.equal(report.results[1].response?.body.content, 'order-boom');
  assert.equal(report.results[2].response?.status, 400);
  assert.match(report.results[2].response?.body.content ?? '', /invalid_request_body/);
  assert.equal(report.results[4].response?.status, 404);
});

test('重放到不同配置服务：状态/正文差异逐条指出，退出 1', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const snapshotFile = await generateSnapshot(t, dir);

  const replayConfig = await writeConfig(dir, 'scenes-b.json', configB());
  const server = await startServer(replayConfig);
  t.after(server.close);

  const result = await runReplay(snapshotFile, server.port);
  assert.equal(result.code, 1, '存在差异应退出 1');
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.total, 5);
  assert.equal(report.failed, 0);
  assert.equal(report.same, 1); // 仅 404 与计划一致
  assert.equal(report.different, 4);

  // GET /api/seq：状态相同、正文不同（seq-ok -> seq-changed）
  assert.equal(report.results[0].outcome, 'different');
  assert.deepEqual(report.results[0].differences, ['body']);
  assert.equal(report.results[0].planned?.body, 'seq-ok');
  assert.equal(report.results[0].response?.body.content, 'seq-changed');

  // POST /api/order 合格请求：计划 500，实际 400（规则变严），状态与正文都不同
  assert.equal(report.results[1].outcome, 'different');
  assert.deepEqual(report.results[1].differences, ['status', 'body']);
  assert.equal(report.results[1].planned?.status, 500);
  assert.equal(report.results[1].response?.status, 400);

  // POST /api/order 原 400 请求：新规则下通过，计划 400，实际 200
  assert.equal(report.results[2].outcome, 'different');
  assert.deepEqual(report.results[2].differences, ['status', 'body']);
  assert.equal(report.results[2].planned?.status, 400);
  assert.equal(report.results[2].response?.status, 200);
  assert.equal(report.results[2].response?.body.content, 'order-ok');

  // POST /api/echo：接口已删除，计划 201，实际 404
  assert.equal(report.results[3].outcome, 'different');
  assert.deepEqual(report.results[3].differences, ['status', 'body']);
  assert.equal(report.results[3].response?.status, 404);

  // 404 在新配置下逐字节一致
  assert.equal(report.results[4].outcome, 'same');
});

test('通信失败：无监听、静默超时、中途断开都记 failed 并继续后续记录', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);

  // 拿一个确定无人监听的端口：先监听再关闭
  const probe = await startCaptureServer(t, () => null);
  const closedPort = probe.port;
  await probe.close();

  // 三条记录分别发往：无监听端口（连接失败）、静默服务器（超时）、
  // 中途断开服务器（部分响应不算完整）
  const silent = await startCaptureServer(t, () => null);
  const partial = await startCaptureServer(t, () =>
    Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort', 'latin1'),
  );

  const makeSnap = async (name: string): Promise<string> =>
    writeText(dir, name, JSON.stringify(baseSnapshot()));

  // 连接失败
  const refused = await runReplay(await makeSnap('refused.json'), closedPort, 2_000);
  assert.equal(refused.code, 1);
  const refusedReport = JSON.parse(refused.stdout) as ReplayReport;
  assert.equal(refusedReport.failed, 1);
  assert.equal(refusedReport.results[0].outcome, 'failed');
  assert.match(refusedReport.results[0].reason ?? '', /失败/);

  // 静默服务器：总超时到期（300ms 内连接一直开着也不延长）
  const slow = await runReplay(await makeSnap('slow.json'), silent.port, 300);
  assert.equal(slow.code, 1);
  const slowReport = JSON.parse(slow.stdout) as ReplayReport;
  assert.equal(slowReport.failed, 1);
  assert.match(slowReport.results[0].reason ?? '', /超时/);

  // 响应中途断开：部分响应不算完整
  const cut = await runReplay(await makeSnap('cut.json'), partial.port, 2_000);
  assert.equal(cut.code, 1);
  const cutReport = JSON.parse(cut.stdout) as ReplayReport;
  assert.equal(cutReport.failed, 1);
  assert.match(cutReport.results[0].reason ?? '', /断开/);

  // 失败不阻断后续记录：两条记录都发往无监听端口，逐条各记一次失败
  const two = baseSnapshot();
  const second = baseRecord();
  second.id = 2;
  (two.records as unknown[]).push(second);
  two.count = 2;
  const twoFile = await writeText(dir, 'two.json', JSON.stringify(two));
  const twoResult = await runReplay(twoFile, closedPort, 2_000);
  assert.equal(twoResult.code, 1);
  const twoReport = JSON.parse(twoResult.stdout) as ReplayReport;
  assert.equal(twoReport.total, 2);
  assert.equal(twoReport.failed, 2);
  assert.deepEqual(
    twoReport.results.map((r) => r.id),
    [1, 2],
  );
});

test('发送字节核对：业务头保序保大小写、传输头剥落并重建、目标与正文无损', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);

  const bodyWithBom = Buffer.concat([BOM, Buffer.from('{"id":1}', 'utf8')]);
  const postRecord = {
    id: 7,
    request: {
      method: 'POST',
      target: '/api/echo?q=%E4%B8%AD&x=1',
      path: '/api/echo',
      rawHeaders: [
        'Host', 'old.example:1234',
        'Content-Length', '999',
        'Connection', 'X-Debug, keep-alive',
        'X-Debug', 'must-be-removed',
        'Expect', '100-continue',
        'Transfer-Encoding', 'chunked',
        'Keep-Alive', 'timeout=5',
        'Content-Type', 'application/json',
        'X-Custom', 'One',
        'x-custom', 'two',
      ],
      bodyBytes: bodyWithBom.byteLength,
      body: { encoding: 'utf-8', content: '\uFEFF{"id":1}' },
    },
    plannedResponse: { kind: 'scene', status: 201, headers: {}, body: 'planned-body' },
    // interrupted 记录同样重放
    delivery: 'interrupted',
  };
  const getRecord = {
    id: 3,
    request: {
      method: 'GET',
      target: '/api/seq',
      path: '/api/seq',
      rawHeaders: ['Host', 'old.example'],
      bodyBytes: 0,
      body: { encoding: 'utf-8', content: '' },
    },
    plannedResponse: { kind: 'scene', status: 200, headers: {}, body: 'pong' },
    // pending 记录同样重放
    delivery: 'pending',
  };
  const snapshot = { count: 2, records: [postRecord, getRecord] };
  const snapshotFile = await writeText(dir, 'capture.json', JSON.stringify(snapshot));

  // 捕获服务器：POST 用连接关闭界定正文，GET 用 chunked，覆盖两种完整形式
  const server = await startCaptureServer(t, (request) => {
    const head = request.toString('latin1', 0, request.indexOf('\r\n'));
    if (head.startsWith('POST ')) {
      return Buffer.from('HTTP/1.1 201 Created\r\n\r\nplanned-body', 'latin1');
    }
    return Buffer.from(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\npong\r\n0\r\n\r\n',
      'latin1',
    );
  });

  const result = await runReplay(snapshotFile, server.port);
  assert.equal(result.code, 0, `全部相同应退出 0：${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.same, 2);
  assert.deepEqual(
    report.results.map((r) => r.id),
    [7, 3],
    '按输入顺序保留原编号',
  );

  assert.equal(server.requests.length, 2, '两条记录各发送一次');
  const sent = server.requests[0].toString('latin1');
  const [headText] = sent.split('\r\n\r\n');
  const lines = headText.split('\r\n');

  // 请求行：目标原样保留查询串与百分号编码，不归一化
  assert.equal(lines[0], 'POST /api/echo?q=%E4%B8%AD&x=1 HTTP/1.1');
  // Host 按目标重建，Content-Length 按实际字节数重建
  assert.ok(lines.includes(`Host: 127.0.0.1:${server.port}`), `Host 重建：${headText}`);
  assert.ok(
    lines.includes(`Content-Length: ${bodyWithBom.byteLength}`),
    `Content-Length 重建：${headText}`,
  );
  // 原 Host/Content-Length/Expect/逐跳与分帧头、Connection 指名的头都被剥落
  assert.ok(!lines.includes('Host: old.example:1234'), '原 Host 被剥落');
  assert.ok(!lines.includes('Content-Length: 999'), '原 Content-Length 被剥落');
  assert.ok(!headText.includes('X-Debug'), 'Connection 指名的头被剥落');
  assert.ok(!headText.includes('Expect'), 'Expect 被剥落');
  assert.ok(!headText.includes('Transfer-Encoding'), 'Transfer-Encoding 被剥落');
  assert.ok(!headText.includes('Keep-Alive'), 'Keep-Alive 被剥落');
  assert.ok(!lines.includes('Connection: X-Debug, keep-alive'), '原 Connection 被剥落');
  // 业务头大小写、重复项与顺序保留
  const customAt = lines.indexOf('X-Custom: One');
  const customLowerAt = lines.indexOf('x-custom: two');
  assert.ok(customAt > 0 && customLowerAt === customAt + 1, `业务头保序保大小写：${headText}`);
  assert.ok(lines.includes('Content-Type: application/json'));
  // 正文无损：BOM 与 JSON 原文逐字节一致
  const sentBody = server.requests[0].subarray(server.requests[0].indexOf('\r\n\r\n') + 4);
  assert.deepEqual(sentBody, bodyWithBom, '正文（含 BOM）逐字节无损');

  // GET 记录：chunked 响应被正确解析为完整响应
  assert.equal(report.results[1].response?.status, 200);
  assert.equal(report.results[1].response?.body.content, 'pong');
});

test('输入失败：非法记录与参数均退出 2、stdout 为空且不发任何请求', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const server = await startCaptureServer(t, () =>
    Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n', 'latin1'),
  );

  const corrupt = (
    mutate: (snap: Record<string, unknown>, rec: Record<string, unknown>) => void,
  ): Record<string, unknown> => {
    const snap = baseSnapshot();
    mutate(snap, (snap.records as unknown[])[0] as Record<string, unknown>);
    return snap;
  };
  const withRequest = (rec: Record<string, unknown>, patch: Record<string, unknown>): void => {
    rec.request = { ...(rec.request as Record<string, unknown>), ...patch };
  };

  const cases: { name: string; snapshot: unknown; expect: RegExp }[] = [
    {
      name: '非 GET/POST 方法',
      snapshot: corrupt((_s, r) => withRequest(r, { method: 'PUT' })),
      expect: /records\[0\]\.request\.method/,
    },
    {
      name: 'target 不以 / 开头',
      snapshot: corrupt((_s, r) =>
        withRequest(r, { target: 'http://x/api/seq', path: 'http://x/api/seq' }),
      ),
      expect: /records\[0\]\.request\.target/,
    },
    {
      name: 'target 含非法字符',
      snapshot: corrupt((_s, r) => withRequest(r, { target: '/api/s eq', path: '/api/s eq' })),
      expect: /records\[0\]\.request\.target/,
    },
    {
      name: '管理范围子路径禁止重放',
      snapshot: corrupt((_s, r) =>
        withRequest(r, { target: '/__contractlab/health', path: '/__contractlab/health' }),
      ),
      expect: /records\[0\]\.request\.path.*管理/,
    },
    {
      name: '管理入口本身禁止重放',
      snapshot: corrupt((_s, r) =>
        withRequest(r, { target: '/__contractlab', path: '/__contractlab' }),
      ),
      expect: /records\[0\]\.request\.path.*管理/,
    },
    {
      name: '缺少 plannedResponse',
      snapshot: corrupt((_s, r) => {
        delete r.plannedResponse;
      }),
      expect: /records\[0\]\.plannedResponse/,
    },
    {
      name: '计划状态越界（100）',
      snapshot: corrupt((_s, r) => {
        r.plannedResponse = { kind: 'scene', status: 100, headers: {}, body: '' };
      }),
      expect: /plannedResponse\.status/,
    },
    {
      name: '计划状态越界（600）',
      snapshot: corrupt((_s, r) => {
        r.plannedResponse = { kind: 'scene', status: 600, headers: {}, body: '' };
      }),
      expect: /plannedResponse\.status/,
    },
    {
      name: '计划正文非文本',
      snapshot: corrupt((_s, r) => {
        r.plannedResponse = { kind: 'scene', status: 200, headers: {}, body: 42 };
      }),
      expect: /plannedResponse\.body/,
    },
    {
      name: 'utf-8 正文含孤立代理项（替换后长度吻合仍拒绝）',
      snapshot: corrupt((_s, r) =>
        withRequest(r, {
          bodyBytes: 3,
          body: { encoding: 'utf-8', content: '\uD800' },
        }),
      ),
      expect: /孤立代理/,
    },
    {
      name: '头名称不可发送',
      snapshot: corrupt((_s, r) =>
        withRequest(r, { rawHeaders: ['Host', '127.0.0.1', 'Bad Name', 'x'] }),
      ),
      expect: /rawHeaders\[2\]/,
    },
    {
      name: '头值含不可发送字符',
      snapshot: corrupt((_s, r) =>
        withRequest(r, { rawHeaders: ['Host', '127.0.0.1', 'X-Ok', 'a\nb'] }),
      ),
      expect: /rawHeaders\[3\]/,
    },
  ];

  for (const c of cases) {
    const file = await writeText(dir, `bad-${cases.indexOf(c)}.json`, JSON.stringify(c.snapshot));
    const before = server.connections();
    const result = await runReplay(file, server.port);
    assert.equal(result.code, 2, `用例「${c.name}」应退出 2`);
    assert.equal(result.stdout, '', `用例「${c.name}」stdout 必须为空`);
    assert.ok(result.stderr.includes(file), `用例「${c.name}」stderr 应指明文件：${result.stderr}`);
    assert.match(result.stderr, c.expect, `用例「${c.name}」stderr 应指明字段`);
    assert.equal(server.connections(), before, `用例「${c.name}」不得建立任何连接`);
  }

  // 快照文件缺失 / 非 JSON
  const missing = await runReplay(`${dir}/no-such.json`, server.port);
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /no-such\.json/);

  // 参数失败：端口非零范围、超时非正整数、缺参
  const okFile = await writeText(dir, 'ok.json', JSON.stringify(baseSnapshot()));
  const argCases: { args: string[]; expect: RegExp }[] = [
    { args: ['replay', '-r', okFile, '-p', '0', '-t', '100'], expect: /端口/ },
    { args: ['replay', '-r', okFile, '-p', '65536', '-t', '100'], expect: /端口/ },
    { args: ['replay', '-r', okFile, '-p', 'abc', '-t', '100'], expect: /端口/ },
    { args: ['replay', '-r', okFile, '-p', String(server.port), '-t', '0'], expect: /超时/ },
    { args: ['replay', '-r', okFile, '-p', String(server.port), '-t', '1.5'], expect: /超时/ },
    { args: ['replay', '-p', String(server.port), '-t', '100'], expect: /--requests/ },
    { args: ['replay', '-r', okFile, '-t', '100'], expect: /--port/ },
    { args: ['replay', '-r', okFile, '-p', String(server.port)], expect: /--timeout/ },
  ];
  for (const c of argCases) {
    const before = server.connections();
    const result = await runCli(c.args);
    assert.equal(result.code, 2, `参数 ${c.args.join(' ')} 应退出 2`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, c.expect);
    assert.equal(server.connections(), before, '参数失败不得建立任何连接');
  }
});

test('空快照退出 0；Connection 指名的非法头被剥落后不阻断重放', {
  timeout: 30_000,
}, async (t) => {
  const dir = await makeTempDir(t);

  const emptyFile = await writeText(
    dir,
    'empty.json',
    JSON.stringify({ note: '空快照', count: 0, records: [] }),
  );
  // 空快照不需要任何监听：发往确定关闭的端口也退出 0
  const probe = await startCaptureServer(t, () => null);
  const closedPort = probe.port;
  await probe.close();
  const empty = await runReplay(emptyFile, closedPort);
  assert.equal(empty.code, 0);
  const emptyReport = JSON.parse(empty.stdout) as ReplayReport;
  assert.equal(emptyReport.total, 0);
  assert.equal(emptyReport.same, 0);
  assert.deepEqual(emptyReport.results, []);

  // 被剥落头（Connection 指名）的非法名称不参与可发送性校验
  const snap = baseSnapshot();
  const rec = (snap.records as unknown[])[0] as Record<string, unknown>;
  rec.request = {
    ...(rec.request as Record<string, unknown>),
    rawHeaders: ['Host', '127.0.0.1', 'Connection', 'Bad Name', 'Bad Name', 'x'],
  };
  const file = await writeText(dir, 'stripped.json', JSON.stringify(snap));
  const server = await startCaptureServer(t, () =>
    Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nseq-ok', 'latin1'),
  );
  const result = await runReplay(file, server.port);
  assert.equal(result.code, 0, `被剥落的头不阻断重放：${result.stderr}`);
  const sent = server.requests[0].toString('latin1');
  assert.ok(!sent.includes('Bad Name'), 'Connection 指名的头被剥落');
});

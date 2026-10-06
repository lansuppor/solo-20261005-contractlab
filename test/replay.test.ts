// 本机请求重放与响应差异报告（replay 子命令）的回归测试
//
// 覆盖：
// - 真实快照重放到相同配置的真实本机服务：全部相同退出 0，逐条保留原编号，
//   完整响应保留状态与无损正文；400/404/500 同样按内容比较；
// - 差异检测：状态码不同 / 正文原始字节不同分别指出，退出 1；
// - 重放请求构造：业务头保序、保大小写、保重复项；剥离 Host/Expect/逐跳与
//   分帧头（含 Connection 指名的头）；按目标与实际字节数重建 Host 与
//   Content-Length；target 原样发送（查询串与百分号编码保留）；正文无损
//   （BOM 与非法 UTF-8 字节原样到达）；逐条串行（前一条结束才发下一条）；
// - 通信失败：连接拒绝、总超时（持续来数据不延长）、响应中途断开，均记失败、
//   关闭连接后继续后续记录，退出 1；不跟随重定向（302 按内容比较）；
// - 输入校验：方法非 GET/POST、管理入口路径、非法 target、缺失/非法计划响应、
//   孤立代理项（替换后长度吻合也拒绝）、不可发送的头名称/值、参数非法——
//   退出 2、stderr 定位文件与字段、stdout 为空且不发任何请求；
// - 空快照退出 0。

import assert from 'node:assert/strict';
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
// 场景配置与原始请求工具
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
        path: '/api/echo',
        responses: [{ status: 201, headers: {}, body: 'echo-ok', delay: 0 }],
      },
      {
        method: 'POST',
        path: '/api/order',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [{ status: 200, headers: {}, body: 'order-ok', delay: 0 }],
      },
    ],
  };
}

// 与 A 相比：/api/seq 正文变化、/api/echo 状态变化（正文不变）、/api/order 不变
function configC(): unknown {
  return {
    endpoints: [
      {
        method: 'GET',
        path: '/api/seq',
        responses: [{ status: 200, headers: {}, body: 'seq-CHANGED', delay: 0 }],
      },
      {
        method: 'POST',
        path: '/api/echo',
        responses: [{ status: 202, headers: {}, body: 'echo-ok', delay: 0 }],
      },
      {
        method: 'POST',
        path: '/api/order',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [{ status: 200, headers: {}, body: 'order-ok', delay: 0 }],
      },
    ],
  };
}

function rawRequest(
  method: string,
  target: string,
  headers: readonly [string, string][],
  body: Buffer,
): Buffer {
  const lines = [`${method} ${target} HTTP/1.1`, 'Host: 127.0.0.1'];
  for (const [name, value] of headers) {
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Content-Length: ${body.byteLength}`, 'Connection: close', '', '');
  return Buffer.concat([Buffer.from(lines.join('\r\n'), 'utf8'), body]);
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
// 快照构造与 replay 调用
// ---------------------------------------------------------------------------

interface ReplayReport {
  readonly total: number;
  readonly same: number;
  readonly different: number;
  readonly failed: number;
  readonly results: readonly {
    readonly id: number;
    readonly outcome: string;
    readonly differences?: { status: boolean; body: boolean };
    readonly planned?: { status: number; body: { encoding: string; content: string } };
    readonly response?: { status: number; body: { encoding: string; content: string } };
    readonly reason?: string;
  }[];
}

function runReplay(requests: string, port: number, timeoutMs: number): Promise<CliResult> {
  return runCli([
    'replay',
    '--requests',
    requests,
    '--port',
    String(port),
    '--timeout',
    String(timeoutMs),
  ]);
}

function makeRecord(
  id: number,
  patch?: {
    method?: string;
    target?: string;
    path?: string;
    rawHeaders?: string[];
    bodyBytes?: number;
    body?: { encoding: string; content: string };
    plannedResponse?: unknown;
  },
): Record<string, unknown> {
  const target = patch?.target ?? '/api/echo';
  const body = patch?.body ?? { encoding: 'utf-8', content: '' };
  return {
    id,
    receivedAt: '2026-10-06T00:00:00.000Z',
    request: {
      method: patch?.method ?? 'GET',
      target,
      path: patch?.path ?? target.split('?')[0],
      rawHeaders: patch?.rawHeaders ?? ['Host', '127.0.0.1:9999'],
      bodyBytes: patch?.bodyBytes ?? 0,
      body,
    },
    configVersion: 1,
    matched: true,
    endpoint: null,
    bodyValidationPassed: null,
    bodyRejection: null,
    sequencePosition: null,
    sequenceLength: null,
    plannedResponse: patch?.plannedResponse ?? { kind: 'scene', status: 200, headers: {}, body: 'ok' },
    delivery: 'sent',
  };
}

function makeSnapshot(records: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ note: 'replay 测试快照', count: records.length, records });
}

// 取一个当前空闲的端口（打开后立即关闭，之后无人监听）
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('真实快照重放到相同配置：全部相同退出 0，编号与无损正文保留，400/404 按内容比较', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes-a.json', configA());

  // 用真实服务产生快照：含查询串与百分号编码、BOM + 非法 UTF-8 正文、
  // 一次 400 正文拒绝、一次 404 未匹配
  const producer = await startServer(configFile);
  t.after(producer.close);
  const invalidBody = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([0xff, 0xfe, 0x80]),
  ]);
  const requests: { raw: Buffer; online: number }[] = [
    { raw: rawRequest('GET', '/api/seq?a=1&b=%E4%B8%AD', [], Buffer.alloc(0)), online: 200 },
    { raw: rawRequest('POST', '/api/echo', [], invalidBody), online: 201 },
    {
      raw: rawRequest(
        'POST',
        '/api/order',
        [['Content-Type', 'application/json']],
        Buffer.from('{"id":"x"}', 'utf8'),
      ),
      online: 400,
    },
    { raw: rawRequest('GET', '/missing', [], Buffer.alloc(0)), online: 404 },
  ];
  for (const r of requests) {
    assert.equal(await rawExchange(producer.port, r.raw), r.online);
  }
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    await httpGetBody(producer.port, '/__contractlab/requests'),
  );

  // 重放到加载相同配置的另一台真实服务
  const target = await startServer(configFile);
  t.after(target.close);
  const result = await runReplay(snapshotFile, target.port, 10_000);
  assert.equal(result.code, 0, `全部相同应退出 0：${result.stderr}`);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.total, 4);
  assert.equal(report.same, 4);
  assert.equal(report.different, 0);
  assert.equal(report.failed, 0);
  assert.deepEqual(
    report.results.map((r) => r.id),
    [1, 2, 3, 4],
    '按输入顺序保留原编号',
  );
  assert.deepEqual(
    report.results.map((r) => r.outcome),
    ['same', 'same', 'same', 'same'],
  );
  // 完整响应保留状态与无损正文（400 框架响应与 404 同样按内容比较）
  assert.deepEqual(
    report.results.map((r) => r.response?.status),
    [200, 201, 400, 404],
  );
  assert.equal(report.results[0].response?.body.content, 'seq-ok');
  assert.equal(report.results[1].response?.body.content, 'echo-ok');
  const rejection = JSON.parse(
    report.results[2].response?.body.content ?? '',
  ) as { error?: string };
  assert.equal(rejection.error, 'invalid_request_body');
  assert.equal(report.results[3].response?.body.content, 'not found\n');

  // 正文无损：目标服务记录到的 POST /api/echo 正文与原始字节完全一致
  const targetSnapshot = JSON.parse(
    await httpGetBody(target.port, '/__contractlab/requests'),
  ) as {
    records: { request: { bodyBytes: number; body: { encoding: string; content: string } } }[];
  };
  const echoed = targetSnapshot.records[1].request;
  assert.equal(echoed.body.encoding, 'base64');
  assert.equal(echoed.bodyBytes, invalidBody.byteLength);
  assert.equal(
    Buffer.from(echoed.body.content, 'base64').toString('hex'),
    invalidBody.toString('hex'),
    'BOM 与非法 UTF-8 字节必须无损到达目标',
  );
});

test('差异检测：状态码/正文不同分别指出，附计划与实际响应，退出 1', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const producer = await startServer(await writeConfig(dir, 'scenes-a.json', configA()));
  t.after(producer.close);
  await rawExchange(producer.port, rawRequest('GET', '/api/seq', [], Buffer.alloc(0)));
  await rawExchange(
    producer.port,
    rawRequest('POST', '/api/echo', [], Buffer.from('hello', 'utf8')),
  );
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    await httpGetBody(producer.port, '/__contractlab/requests'),
  );

  const target = await startServer(await writeConfig(dir, 'scenes-c.json', configC()));
  t.after(target.close);
  const result = await runReplay(snapshotFile, target.port, 10_000);
  assert.equal(result.code, 1, '存在差异应退出 1');
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.total, 2);
  assert.equal(report.same, 0);
  assert.equal(report.different, 2);
  assert.equal(report.failed, 0);

  // /api/seq：仅正文不同
  assert.equal(report.results[0].outcome, 'different');
  assert.deepEqual(report.results[0].differences, { status: false, body: true });
  assert.equal(report.results[0].planned?.status, 200);
  assert.equal(report.results[0].planned?.body.content, 'seq-ok');
  assert.equal(report.results[0].response?.status, 200);
  assert.equal(report.results[0].response?.body.content, 'seq-CHANGED');

  // /api/echo：仅状态码不同
  assert.equal(report.results[1].outcome, 'different');
  assert.deepEqual(report.results[1].differences, { status: true, body: false });
  assert.equal(report.results[1].planned?.status, 201);
  assert.equal(report.results[1].response?.status, 202);
  assert.equal(report.results[1].response?.body.content, 'echo-ok');
});

test('重放请求构造：业务头保序保大小写含重复、剥离逐跳/分帧与 Connection 指名头、重建 Host/Content-Length、target 原样、正文无损、逐条串行', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);

  // 捕获型目标服务：记录每次请求的方法、url、原始头与原始正文字节，并跟踪并发数
  interface Captured {
    method: string;
    url: string;
    rawHeaders: string[];
    body: Buffer;
  }
  const captured: Captured[] = [];
  let active = 0;
  let maxActive = 0;
  const echo = http.createServer((req, res) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured.push({
        method: String(req.method),
        url: String(req.url),
        rawHeaders: [...req.rawHeaders],
        body: Buffer.concat(chunks),
      });
      res.on('finish', () => {
        active -= 1;
      });
      if (req.url === '/api/post') {
        res.writeHead(201, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('created中文');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
      }
    });
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  t.after(() => echo.close());
  const address = echo.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const bomPlusInvalid = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([0xff, 0xfe]),
  ]);
  // 编号故意乱序：结果必须按输入顺序保留原编号
  const snapshot = makeSnapshot([
    makeRecord(7, {
      target: '/api/echo?x=%41%42&y=1',
      rawHeaders: [
        'Host', '127.0.0.1:9999',
        'X-Custom', 'a',
        'Connection', 'X-Hop, keep-alive',
        'X-Hop', '1',
        'x-custom', 'b',
        'Expect', '100-continue',
        'Keep-Alive', 'timeout=5',
        'Transfer-Encoding', 'chunked',
        'Content-Length', '5',
      ],
    }),
    makeRecord(3, {
      method: 'POST',
      target: '/api/post',
      rawHeaders: ['Host', '127.0.0.1:9999', 'Content-Type', 'application/octet-stream'],
      bodyBytes: bomPlusInvalid.byteLength,
      body: { encoding: 'base64', content: bomPlusInvalid.toString('base64') },
      plannedResponse: { kind: 'scene', status: 201, headers: {}, body: 'created中文' },
    }),
  ]);
  const snapshotFile = await writeText(dir, 'snapshot.json', snapshot);
  const result = await runReplay(snapshotFile, port, 10_000);
  assert.equal(result.code, 0, `应全部相同：${result.stdout}`);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.deepEqual(
    report.results.map((r) => r.id),
    [7, 3],
    '按输入顺序保留原编号',
  );
  assert.equal(report.same, 2);
  // 计划正文按 UTF-8 编码比较（含非 ASCII）
  assert.equal(report.results[1].response?.body.content, 'created中文');

  assert.equal(captured.length, 2);
  assert.equal(maxActive, 1, '前一条结束才发下一条（不并发）');

  // 第一条：target 原样（查询串与百分号编码保留，不归一化）
  assert.equal(captured[0].method, 'GET');
  assert.equal(captured[0].url, '/api/echo?x=%41%42&y=1');
  const h1 = captured[0].rawHeaders;
  // 业务头保序、保大小写、保重复项，且在重建头之前
  assert.deepEqual(h1.slice(0, 4), ['X-Custom', 'a', 'x-custom', 'b']);
  // 剥离：Host/Expect/Connection/Keep-Alive/Content-Length/Transfer-Encoding 原值不出现，
  // Connection 指名的 X-Hop 也被剥离
  const names1: string[] = [];
  for (let j = 0; j + 1 < h1.length; j += 2) {
    names1.push(h1[j].toLowerCase());
  }
  for (const stripped of ['expect', 'keep-alive', 'transfer-encoding', 'x-hop']) {
    assert.ok(!names1.includes(stripped), `应剥离 ${stripped}`);
  }
  // 重建：Host 按目标、Content-Length 按实际字节数（GET 空正文为 0）
  const valueOf = (headers: readonly string[], name: string): string | undefined => {
    for (let j = 0; j + 1 < headers.length; j += 2) {
      if (headers[j].toLowerCase() === name) {
        return headers[j + 1];
      }
    }
    return undefined;
  };
  assert.equal(valueOf(h1, 'host'), `127.0.0.1:${port}`);
  assert.equal(valueOf(h1, 'content-length'), '0');
  assert.equal(captured[0].body.byteLength, 0);

  // 第二条：正文无损（BOM + 非法 UTF-8 字节原样到达），Content-Length 按实际字节数
  assert.equal(captured[1].method, 'POST');
  assert.equal(captured[1].url, '/api/post');
  assert.equal(captured[1].body.toString('hex'), bomPlusInvalid.toString('hex'));
  assert.equal(valueOf(captured[1].rawHeaders, 'content-length'), String(bomPlusInvalid.byteLength));
  assert.equal(valueOf(captured[1].rawHeaders, 'content-type'), 'application/octet-stream');
});

test('通信失败：连接拒绝记失败并继续后续记录，退出 1', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const port = await freePort(); // 无人监听
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([makeRecord(1), makeRecord(2)]),
  );
  const result = await runReplay(snapshotFile, port, 5_000);
  assert.equal(result.code, 1, '通信失败应退出 1');
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.total, 2);
  assert.equal(report.failed, 2, '失败后关闭连接并继续后续记录');
  assert.equal(report.same, 0);
  assert.equal(report.results[0].outcome, 'failed');
  assert.match(report.results[0].reason ?? '', /通信失败|ECONNREFUSED/);
  assert.equal(report.results[1].outcome, 'failed');
});

test('通信失败：总超时覆盖完整收发，持续来数据不延长', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  // 目标：收到请求后立即给响应头，随后每 50ms 滴 1 字节正文（永不结束）
  const dripper = net.createServer((socket) => {
    let head = Buffer.alloc(0);
    let started = false;
    socket.on('data', (c: Buffer) => {
      if (started) {
        return;
      }
      head = Buffer.concat([head, c]);
      if (head.includes('\r\n\r\n')) {
        started = true;
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n');
        const drip = setInterval(() => socket.write('x'), 50);
        socket.on('close', () => clearInterval(drip));
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => dripper.listen(0, '127.0.0.1', resolve));
  t.after(() => dripper.close());
  const address = dripper.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const snapshotFile = await writeText(dir, 'snapshot.json', makeSnapshot([makeRecord(1)]));
  const startedAt = Date.now();
  const result = await runReplay(snapshotFile, port, 300);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.failed, 1);
  assert.match(report.results[0].reason ?? '', /超时/);
  assert.ok(
    elapsed < 4_000,
    `持续来数据不得延长总超时（若被延长将滴满 1000 字节约 50s），实际 ${elapsed}ms`,
  );
});

test('通信失败：响应中途断开记失败（部分响应不算完整）', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const cutter = net.createServer((socket) => {
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial');
      socket.destroy();
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => cutter.listen(0, '127.0.0.1', resolve));
  t.after(() => cutter.close());
  const address = cutter.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const snapshotFile = await writeText(dir, 'snapshot.json', makeSnapshot([makeRecord(1)]));
  const result = await runReplay(snapshotFile, port, 5_000);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.failed, 1);
  assert.match(report.results[0].reason ?? '', /中途断开/);
});

test('不跟随重定向：302 按内容比较记为差异', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const redirector = http.createServer((_req, res) => {
    res.writeHead(302, { Location: '/api/echo' });
    res.end('redirect');
  });
  await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  t.after(() => redirector.close());
  const address = redirector.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const snapshotFile = await writeText(dir, 'snapshot.json', makeSnapshot([makeRecord(1)]));
  const result = await runReplay(snapshotFile, port, 5_000);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.different, 1);
  assert.deepEqual(report.results[0].differences, { status: true, body: true });
  assert.equal(report.results[0].response?.status, 302, '不跟随重定向，按 302 本身比较');
});

test('输入校验失败：退出 2、stderr 定位、stdout 为空、不发任何请求', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);

  // 计数型目标：任何校验失败都不得有请求到达
  let hits = 0;
  const counter = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  await new Promise<void>((resolve) => counter.listen(0, '127.0.0.1', resolve));
  t.after(() => counter.close());
  const address = counter.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const cases: { name: string; snapshot: string; expect: RegExp }[] = [
    {
      name: '方法非 GET/POST',
      snapshot: makeSnapshot([makeRecord(1, { method: 'PUT' })]),
      expect: /records\[0\]\.request\.method.*GET\/POST/,
    },
    {
      name: '管理入口本身',
      snapshot: makeSnapshot([makeRecord(1, { target: '/__contractlab' })]),
      expect: /records\[0\]\.request\.target.*管理入口/,
    },
    {
      name: '管理入口前缀',
      snapshot: makeSnapshot([makeRecord(1, { target: '/__contractlab/requests?x=1' })]),
      expect: /records\[0\]\.request\.target.*管理入口/,
    },
    {
      name: 'target 不以 / 开头',
      snapshot: makeSnapshot([makeRecord(1, { target: 'api/echo', path: 'api/echo' })]),
      expect: /records\[0\]\.request\.target.*"\/" 开头/,
    },
    {
      name: 'target 含空白',
      snapshot: makeSnapshot([makeRecord(1, { target: '/api/e cho', path: '/api/e cho' })]),
      expect: /records\[0\]\.request\.target.*空白或控制字符/,
    },
    {
      name: '缺少 plannedResponse',
      snapshot: (() => {
        const rec = makeRecord(1);
        delete rec.plannedResponse;
        return makeSnapshot([rec]);
      })(),
      expect: /records\[0\]\.plannedResponse/,
    },
    {
      name: '计划状态越界（199）',
      snapshot: makeSnapshot([makeRecord(1, { plannedResponse: { status: 199, body: 'ok' } })]),
      expect: /records\[0\]\.plannedResponse\.status/,
    },
    {
      name: '计划状态越界（600）',
      snapshot: makeSnapshot([makeRecord(1, { plannedResponse: { status: 600, body: 'ok' } })]),
      expect: /records\[0\]\.plannedResponse\.status/,
    },
    {
      name: '计划正文非文本',
      snapshot: makeSnapshot([makeRecord(1, { plannedResponse: { status: 200, body: 1 } })]),
      expect: /records\[0\]\.plannedResponse\.body/,
    },
    {
      name: '计划正文含孤立代理项',
      snapshot: makeSnapshot([
        makeRecord(1, { plannedResponse: { status: 200, body: 'ok\uD800' } }),
      ]),
      expect: /records\[0\]\.plannedResponse\.body.*孤立代理项/,
    },
    {
      name: 'utf-8 正文含孤立代理项（替换后长度吻合也拒绝）',
      snapshot: makeSnapshot([
        makeRecord(1, {
          bodyBytes: 3, // U+FFFD 的 UTF-8 长度：孤立代理项替换后恰好吻合
          body: { encoding: 'utf-8', content: '\uD800' },
        }),
      ]),
      expect: /records\[0\]\.request\.body\.content.*孤立代理项/,
    },
    {
      name: '头名称不可发送',
      snapshot: makeSnapshot([makeRecord(1, { rawHeaders: ['Bad Name', 'x'] })]),
      expect: /records\[0\]\.request\.rawHeaders\[0\].*头名称/,
    },
    {
      name: '头值含换行',
      snapshot: makeSnapshot([makeRecord(1, { rawHeaders: ['X-A', 'line1\nline2'] })]),
      expect: /records\[0\]\.request\.rawHeaders\[1\].*控制字符/,
    },
    {
      name: '头值超出 Latin-1',
      snapshot: makeSnapshot([makeRecord(1, { rawHeaders: ['X-A', '中文'] })]),
      expect: /records\[0\]\.request\.rawHeaders\[1\].*Latin-1/,
    },
    {
      name: '前一条合法、后一条非法：整份拒绝，一条都不发',
      snapshot: makeSnapshot([makeRecord(1), makeRecord(2, { method: 'DELETE' })]),
      expect: /records\[1\]\.request\.method/,
    },
  ];

  for (const c of cases) {
    const file = await writeText(dir, `bad-${cases.indexOf(c)}.json`, c.snapshot);
    const result = await runReplay(file, port, 5_000);
    assert.equal(result.code, 2, `用例「${c.name}」应退出 2`);
    assert.equal(result.stdout, '', `用例「${c.name}」stdout 必须为空`);
    assert.ok(result.stderr.includes(file), `用例「${c.name}」stderr 应指明文件：${result.stderr}`);
    assert.match(result.stderr, c.expect, `用例「${c.name}」stderr 应定位字段`);
  }
  assert.equal(hits, 0, '校验失败时不得发出任何请求');

  // 快照文件缺失
  const missing = await runReplay(`${dir}/no-such.json`, port, 5_000);
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /no-such\.json/);

  // 参数失败：端口非有效非零、超时非正整数（快照文件本身合法）
  const okFile = await writeText(dir, 'ok.json', makeSnapshot([makeRecord(1)]));
  const badArgs: { args: string[]; expect: RegExp }[] = [
    { args: ['replay', '-r', okFile, '-p', '0', '-t', '100'], expect: /非零端口/ },
    { args: ['replay', '-r', okFile, '-p', '65536', '-t', '100'], expect: /非零端口/ },
    { args: ['replay', '-r', okFile, '-p', 'abc', '-t', '100'], expect: /端口必须是整数/ },
    { args: ['replay', '-r', okFile, '-p', String(port), '-t', '0'], expect: /正整数毫秒/ },
    { args: ['replay', '-r', okFile, '-p', String(port), '-t', '-5'], expect: /正整数毫秒/ },
    { args: ['replay', '-r', okFile, '-p', String(port)], expect: /缺少必填参数 --timeout/ },
    { args: ['replay', '-p', String(port), '-t', '100'], expect: /缺少必填参数 --requests/ },
  ];
  for (const c of badArgs) {
    const result = await runCli(c.args);
    assert.equal(result.code, 2, `参数 ${c.args.join(' ')} 应退出 2`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, c.expect);
  }
  assert.equal(hits, 0, '参数失败时不得发出任何请求');
});

test('空快照退出 0，报告总数为 0', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const emptyFile = await writeText(
    dir,
    'empty.json',
    JSON.stringify({ note: '空快照', count: 0, records: [] }),
  );
  const port = await freePort(); // 不需要目标：空快照不发送任何请求
  const result = await runReplay(emptyFile, port, 1_000);
  assert.equal(result.code, 0, `空快照应退出 0：${result.stderr}`);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.total, 0);
  assert.equal(report.same, 0);
  assert.equal(report.different, 0);
  assert.equal(report.failed, 0);
  assert.deepEqual(report.results, []);
});

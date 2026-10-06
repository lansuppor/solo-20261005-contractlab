// 离线批量请求校验（verify）的回归测试
//
// 快照由真实本机服务产生（GET /__contractlab/requests 的完整 JSON），
// 再对照场景文件离线重判；并把相同原始请求发到加载目标配置的真实服务，
// 核对在线接受/拒绝结论与离线判定一致。覆盖：
// - 逐条重判：未匹配 / 无需正文校验 / 校验通过 / 正文拒绝四类结论、计数与
//   退出码；待发送（pending）、已发送（sent）、中断（interrupted）记录均可处理；
//   场景配置的 500 不算请求拒绝；
// - 规则变化：同一快照对照新规则结论翻转（不信任原校验结果），并与真实服务一致；
// - 重复 Content-Type 头取在线顺序第一项；
// - 非法 UTF-8（base64 还原）属于请求解析拒绝（退出 1），不是输入文件错误；
// - 开头 BOM 与空白无损保留（bodyBytes 核对通过、内容原样、JSON 不重写）；
// - 输入失败：读取/JSON/计数不符/重复编号/头不成对/非法编码/长度不符（已丢字节
//   不猜补）/path 不符/缺字段/场景非法——退出 2、stderr 指明文件与位置、
//   stdout 无部分报告。

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  makeTempDir,
  runCli,
  sceneResponse,
  startServer,
  writeConfig,
  type CliResult,
} from './helpers.ts';

const SLOW_DELAY = 600;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function runVerify(requestsFile: string, configFile: string): Promise<CliResult> {
  return runCli(['verify', '--requests', requestsFile, '--config', configFile]);
}

// ---------------------------------------------------------------------------
// 原始 HTTP 请求（net 层）：精确控制方法、目标、重复头与原始字节正文
// ---------------------------------------------------------------------------

function buildRaw(
  method: string,
  target: string,
  headers: readonly (readonly [string, string])[],
  body: Buffer,
): Buffer {
  const lines = [`${method} ${target} HTTP/1.1`, 'Host: 127.0.0.1'];
  for (const [name, value] of headers) {
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Content-Length: ${body.byteLength}`, 'Connection: close', '', '');
  return Buffer.concat([Buffer.from(lines.join('\r\n'), 'utf8'), body]);
}

interface RawReply {
  readonly status: number;
  readonly raw: Buffer;
}

function rawExchange(port: number, raw: Buffer, timeoutMs = 10_000): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`原始请求 ${timeoutMs}ms 内未完成（疑似卡住）`));
    }, timeoutMs);
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      const all = Buffer.concat(chunks);
      const m = all.toString('latin1').match(/^HTTP\/1\.\d (\d{3})/);
      resolve({ status: m ? Number(m[1]) : 0, raw: all });
    });
  });
}

// GET /__contractlab/requests 的完整响应正文（即快照文件内容）
function fetchSnapshot(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = http.get(
      { host: '127.0.0.1', port, path: '/__contractlab/requests' },
      (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (d: string) => (body += d));
        res.on('end', () => {
          assert.equal(res.statusCode, 200, '查询请求记录应返回 200');
          resolve(body);
        });
      },
    );
    r.on('error', reject);
  });
}

async function writeSnapshot(dir: string, name: string, text: string): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, text, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// 报告形状
// ---------------------------------------------------------------------------

interface VerifyRecordReport {
  readonly id: number;
  readonly outcome: 'unmatched' | 'accepted' | 'rejected';
  readonly bodyCheck?: 'not-required' | 'passed';
  readonly rejection?: {
    readonly error: string;
    readonly stage: 'parse' | 'structure';
    readonly message: string;
    readonly problems: readonly { readonly pointer: string; readonly expected: string; readonly actual: string }[];
  };
}

interface VerifyReport {
  readonly total: number;
  readonly unmatched: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly records: readonly VerifyRecordReport[];
}

function parseReport(result: CliResult): VerifyReport {
  const report = JSON.parse(result.stdout) as VerifyReport;
  assert.equal(
    report.total,
    report.records.length,
    '总数应等于逐条结果数',
  );
  assert.equal(
    report.total,
    report.unmatched + report.accepted + report.rejected,
    '总数应等于 未匹配 + 通过 + 拒绝',
  );
  return report;
}

function byId(report: VerifyReport, id: number): VerifyRecordReport {
  const rec = report.records.find((r) => r.id === id);
  assert.ok(rec, `报告中应包含记录 #${id}`);
  return rec as VerifyRecordReport;
}

// ---------------------------------------------------------------------------
// 端到端：真实快照 -> 离线重判 -> 规则变化 -> 真实服务交叉核对
// ---------------------------------------------------------------------------

const ORDER_RULE_A = {
  type: 'object',
  fields: { id: { type: 'integer', required: true } },
  additionalProperties: false,
};

// 规则变化：id 由 integer 收紧为 string、允许未声明字段
const ORDER_RULE_B = {
  type: 'object',
  fields: { id: { type: 'string', required: true } },
  additionalProperties: true,
};

function configWithOrderRule(rule: unknown): unknown {
  return {
    endpoints: [
      { method: 'GET', path: '/api/info', responses: [sceneResponse()] },
      {
        method: 'GET',
        path: '/api/boom',
        responses: [{ status: 500, headers: {}, body: 'boom', delay: 0 }],
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
        path: '/api/order',
        requestBody: rule,
        responses: [sceneResponse()],
      },
      { method: 'POST', path: '/api/free', responses: [sceneResponse()] },
    ],
  };
}

const JSON_CT: readonly [string, string][] = [['Content-Type', 'application/json']];

test('端到端：真实快照离线重判；规则变化结论翻转并与真实服务一致', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const fileA = await writeConfig(dir, 'a.json', configWithOrderRule(ORDER_RULE_A));
  const serverA = await startServer(fileA);
  t.after(serverA.close);
  const port = serverA.port;

  // 逐条发出原始请求并记录在线结论（id 按完整接收顺序 1..11）
  const send = (
    method: string,
    target: string,
    headers: readonly (readonly [string, string])[],
    body: string,
  ): Promise<RawReply> => rawExchange(port, buildRaw(method, target, headers, Buffer.from(body, 'utf8')));

  const r1 = await send('POST', '/api/order', [['content-type', 'Application/JSON; charset=utf-8']], '{"id":1}');
  assert.equal(r1.status, 299, '头名称与媒体类型均忽略大小写、允许参数');
  const r2 = await send('POST', '/api/order', JSON_CT, '{"id":"x","extra":1}');
  assert.equal(r2.status, 400);
  const r3 = await send('POST', '/api/order', [['Content-Type', 'text/plain']], '{"id":1}');
  assert.equal(r3.status, 400);
  const r4 = await send('POST', '/api/order', JSON_CT, '{bad');
  assert.equal(r4.status, 400);
  const r5 = await send('GET', '/api/info?x=1&y=%E4%B8%AD', [], '');
  assert.equal(r5.status, 299);
  const r6 = await send('GET', '/api/boom', [], '');
  assert.equal(r6.status, 500, '场景配置的 500 是在线响应，不影响离线接受结论');
  const r7 = await send('POST', '/api/free', [], 'not json at all');
  assert.equal(r7.status, 299, '无正文规则的接口不解析正文');
  const r8 = await send('GET', '/api/missing', [], '');
  assert.equal(r8.status, 404);
  const r9 = await send('PUT', '/api/info', [], '');
  assert.equal(r9.status, 404);

  // #10：延迟期间查询 -> pending；#11：写出前断开 -> interrupted
  const pending = rawExchange(port, buildRaw('GET', '/api/slow', [], Buffer.alloc(0)));
  await sleep(80);
  const slowSocket = net.connect(port, '127.0.0.1', () => {
    slowSocket.write(buildRaw('GET', '/api/slow', [], Buffer.alloc(0)));
  });
  slowSocket.resume();
  await sleep(80);
  slowSocket.destroy();
  await sleep(150);

  const snapshotText = await fetchSnapshot(port);
  const snapshotFile = await writeSnapshot(dir, 'snapshot.json', snapshotText);

  const pendingReply = await pending;
  assert.equal(pendingReply.status, 200);

  const snapshot = JSON.parse(snapshotText) as {
    count: number;
    records: {
      id: number;
      delivery: string;
      bodyValidationPassed: boolean | null;
      request: { method: string; target: string };
    }[];
  };
  assert.equal(snapshot.count, 11);
  assert.deepEqual(snapshot.records.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(snapshot.records[9].delivery, 'pending', '延迟期间应查到待发送记录');
  assert.equal(snapshot.records[10].delivery, 'interrupted', '写出前断开应记为中断');
  assert.equal(snapshot.records[1].bodyValidationPassed, false, '原记录结论（将被离线重判推翻）');

  // ---- 对照配置 A 离线重判 ----
  const resultA = await runVerify(snapshotFile, fileA);
  assert.equal(resultA.code, 1, `存在正文拒绝应退出 1\nstderr:\n${resultA.stderr}`);
  assert.equal(resultA.stderr, '', '成功出报告时 stderr 应为空');
  const reportA = parseReport(resultA);
  assert.equal(reportA.total, 11);
  assert.equal(reportA.rejected, 3);
  assert.equal(reportA.unmatched, 2);
  assert.equal(reportA.accepted, 6);
  assert.deepEqual(
    reportA.records.map((r) => r.id),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    '按输入顺序保留原编号',
  );

  assert.deepEqual(byId(reportA, 1), { id: 1, outcome: 'accepted', bodyCheck: 'passed' });
  const rej2 = byId(reportA, 2);
  assert.equal(rej2.outcome, 'rejected');
  assert.equal(rej2.rejection?.error, 'invalid_request_body');
  assert.equal(rej2.rejection?.stage, 'structure');
  assert.deepEqual(
    rej2.rejection?.problems.map((p) => `${p.pointer}|${p.expected}|${p.actual}`).sort(),
    ['/extra|未声明的字段（不允许）|number', '/id|integer|string'],
    '正文拒绝复用结构差异报告，列全 RFC 6901 指针、期望与实际值',
  );
  const rej3 = byId(reportA, 3);
  assert.equal(rej3.outcome, 'rejected');
  assert.equal(rej3.rejection?.stage, 'parse');
  assert.match(rej3.rejection?.message ?? '', /媒体类型/);
  const rej4 = byId(reportA, 4);
  assert.equal(rej4.outcome, 'rejected');
  assert.equal(rej4.rejection?.stage, 'parse');
  assert.match(rej4.rejection?.message ?? '', /JSON/);

  assert.deepEqual(byId(reportA, 5), { id: 5, outcome: 'accepted', bodyCheck: 'not-required' });
  assert.deepEqual(byId(reportA, 6), { id: 6, outcome: 'accepted', bodyCheck: 'not-required' },
    '场景配置的 500 不算请求拒绝');
  assert.deepEqual(byId(reportA, 7), { id: 7, outcome: 'accepted', bodyCheck: 'not-required' });
  assert.deepEqual(byId(reportA, 8), { id: 8, outcome: 'unmatched' });
  assert.deepEqual(byId(reportA, 9), { id: 9, outcome: 'unmatched' }, '非 GET/POST 为未匹配');
  assert.deepEqual(byId(reportA, 10), { id: 10, outcome: 'accepted', bodyCheck: 'not-required' },
    '待发送记录同样处理');
  assert.deepEqual(byId(reportA, 11), { id: 11, outcome: 'accepted', bodyCheck: 'not-required' },
    '中断记录同样处理');

  // ---- 规则变化：同一快照对照配置 B 结论翻转（不信任原校验结果） ----
  const fileB = await writeConfig(dir, 'b.json', configWithOrderRule(ORDER_RULE_B));
  const resultB = await runVerify(snapshotFile, fileB);
  assert.equal(resultB.code, 1, '配置 B 下仍存在正文拒绝');
  const reportB = parseReport(resultB);
  assert.equal(byId(reportB, 1).outcome, 'rejected', '原校验通过的 {"id":1} 在新规则下应被拒绝');
  assert.equal(byId(reportB, 1).rejection?.stage, 'structure');
  assert.deepEqual(byId(reportB, 2), { id: 2, outcome: 'accepted', bodyCheck: 'passed' },
    '原校验拒绝的 {"id":"x","extra":1} 在新规则下应被接受');
  assert.equal(byId(reportB, 3).outcome, 'rejected', '媒体类型检查不受规则变化影响');
  assert.equal(byId(reportB, 4).outcome, 'rejected');

  // ---- 交叉核对：相同原始请求发到加载配置 B 的真实服务 ----
  const serverB = await startServer(fileB);
  t.after(serverB.close);
  const replay1 = await rawExchange(
    serverB.port,
    buildRaw('POST', '/api/order', JSON_CT, Buffer.from('{"id":1}', 'utf8')),
  );
  assert.equal(replay1.status, 400, '离线判拒绝的请求，真实服务同样拒绝');
  const replay2 = await rawExchange(
    serverB.port,
    buildRaw('POST', '/api/order', JSON_CT, Buffer.from('{"id":"x","extra":1}', 'utf8')),
  );
  assert.equal(replay2.status, 299, '离线判接受的请求，真实服务同样接受');
});

// ---------------------------------------------------------------------------
// 重复 Content-Type 头：取在线顺序第一项
// ---------------------------------------------------------------------------

test('重复 Content-Type 头采用在线顺序第一项', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = {
    endpoints: [
      {
        method: 'POST',
        path: '/api/echo',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
    ],
  };
  const file = await writeConfig(dir, 'scenes.json', config);
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;

  const body = Buffer.from('{"id":1}', 'utf8');
  // 第一项合法、第二项非法 -> 离线应接受（无论在线如何合并重复头）；
  // 头名称大小写混合，覆盖名称不分大小写
  await rawExchange(
    port,
    buildRaw('POST', '/api/echo', [
      ['content-type', 'application/json'],
      ['Content-Type', 'text/plain'],
    ], body),
  );
  // 第一项非法、第二项合法 -> 离线应拒绝
  await rawExchange(
    port,
    buildRaw('POST', '/api/echo', [
      ['Content-Type', 'text/plain'],
      ['Content-Type', 'application/json'],
    ], body),
  );

  const snapshotText = await fetchSnapshot(port);
  const snapshot = JSON.parse(snapshotText) as {
    records: { id: number; request: { rawHeaders: string[] } }[];
  };
  const rh1 = snapshot.records[0].request.rawHeaders;
  const ctAt: string[] = [];
  for (let i = 0; i + 1 < rh1.length; i += 2) {
    if (rh1[i].toLowerCase() === 'content-type') {
      ctAt.push(rh1[i + 1]);
    }
  }
  assert.deepEqual(ctAt, ['application/json', 'text/plain'], '快照应保序保留重复头');

  const snapshotFile = await writeSnapshot(dir, 'snapshot.json', snapshotText);
  const result = await runVerify(snapshotFile, file);
  assert.equal(result.code, 1);
  const report = parseReport(result);
  assert.deepEqual(byId(report, 1), { id: 1, outcome: 'accepted', bodyCheck: 'passed' },
    '重复头取在线顺序第一项：第一项 application/json 应通过');
  const rej = byId(report, 2);
  assert.equal(rej.outcome, 'rejected', '第一项 text/plain 应按媒体类型不符拒绝');
  assert.equal(rej.rejection?.stage, 'parse');
  assert.match(rej.rejection?.message ?? '', /媒体类型/);
});

// ---------------------------------------------------------------------------
// 非法 UTF-8：base64 还原后是请求解析拒绝，不是输入文件错误
// ---------------------------------------------------------------------------

test('非法 UTF-8（base64 正文）属于请求解析拒绝而非输入失败', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = {
    endpoints: [
      {
        method: 'POST',
        path: '/api/echo',
        requestBody: { type: 'object', fields: {}, additionalProperties: true },
        responses: [sceneResponse()],
      },
    ],
  };
  const file = await writeConfig(dir, 'scenes.json', config);
  const server = await startServer(file);
  t.after(server.close);

  const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x80, 0x7d]); // { 非法序列 }
  const reply = await rawExchange(
    server.port,
    buildRaw('POST', '/api/echo', JSON_CT, bytes),
  );
  assert.equal(reply.status, 400);

  const snapshotText = await fetchSnapshot(server.port);
  const snapshot = JSON.parse(snapshotText) as {
    records: { request: { body: { encoding: string; content: string }; bodyBytes: number } }[];
  };
  assert.equal(snapshot.records[0].request.body.encoding, 'base64');
  assert.ok(
    Buffer.from(snapshot.records[0].request.body.content, 'base64').equals(bytes),
    'base64 必须无损还原原始字节',
  );

  const snapshotFile = await writeSnapshot(dir, 'snapshot.json', snapshotText);
  const result = await runVerify(snapshotFile, file);
  assert.equal(result.code, 1, '非法 UTF-8 是请求解析拒绝（退出 1），不是输入文件错误（退出 2）');
  const report = parseReport(result);
  const rej = byId(report, 1);
  assert.equal(rej.outcome, 'rejected');
  assert.equal(rej.rejection?.stage, 'parse');
  assert.match(rej.rejection?.message ?? '', /UTF-8/);
});

// ---------------------------------------------------------------------------
// 开头 BOM 与空白：无损保留、JSON 不重写
// ---------------------------------------------------------------------------

test('开头 BOM 与空白在快照中原样保留，离线重判通过', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = {
    endpoints: [
      {
        method: 'POST',
        path: '/api/echo',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
    ],
  };
  const file = await writeConfig(dir, 'scenes.json', config);
  const server = await startServer(file);
  t.after(server.close);

  const bomBody = '\uFEFF{"id":1}';
  const spacedBody = '  \r\n {"id":1} \n';
  const r1 = await rawExchange(
    server.port,
    buildRaw('POST', '/api/echo', JSON_CT, Buffer.from(bomBody, 'utf8')),
  );
  assert.equal(r1.status, 299);
  const r2 = await rawExchange(
    server.port,
    buildRaw('POST', '/api/echo', JSON_CT, Buffer.from(spacedBody, 'utf8')),
  );
  assert.equal(r2.status, 299);

  const snapshotText = await fetchSnapshot(server.port);
  const snapshot = JSON.parse(snapshotText) as {
    records: { request: { body: { encoding: string; content: string }; bodyBytes: number } }[];
  };
  const [rec1, rec2] = snapshot.records;
  assert.equal(rec1.request.body.encoding, 'utf-8');
  assert.equal(rec1.request.body.content, bomBody, '开头 BOM 必须原样保留，不得剥离或重写');
  assert.equal(rec1.request.bodyBytes, Buffer.byteLength(bomBody, 'utf8'), 'bodyBytes 含 BOM 三字节');
  assert.ok(
    Buffer.from(rec1.request.body.content, 'utf8').equals(Buffer.from(bomBody, 'utf8')),
    'utf-8 记录必须能无损还原原始字节',
  );
  assert.equal(rec2.request.body.content, spacedBody, '前后空白原样保留，JSON 不重写');

  const snapshotFile = await writeSnapshot(dir, 'snapshot.json', snapshotText);
  const result = await runVerify(snapshotFile, file);
  assert.equal(result.code, 0, `全部接受应退出 0\nstderr:\n${result.stderr}`);
  const report = parseReport(result);
  assert.deepEqual(byId(report, 1), { id: 1, outcome: 'accepted', bodyCheck: 'passed' });
  assert.deepEqual(byId(report, 2), { id: 2, outcome: 'accepted', bodyCheck: 'passed' });
});

// ---------------------------------------------------------------------------
// 空快照、全部接受、输入顺序与原编号
// ---------------------------------------------------------------------------

test('空快照退出 0；全部接受退出 0；按输入顺序保留原编号', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = {
    endpoints: [
      { method: 'GET', path: '/api/info', responses: [sceneResponse()] },
    ],
  };
  const file = await writeConfig(dir, 'scenes.json', config);

  const emptyFile = await writeSnapshot(
    dir,
    'empty.json',
    `${JSON.stringify({ note: 'n', count: 0, records: [] }, null, 2)}\n`,
  );
  const emptyResult = await runVerify(emptyFile, file);
  assert.equal(emptyResult.code, 0, `空快照应退出 0\nstderr:\n${emptyResult.stderr}`);
  const emptyReport = parseReport(emptyResult);
  assert.equal(emptyReport.total, 0);
  assert.deepEqual(emptyReport.records, []);

  const record = (id: number): unknown => ({
    id,
    receivedAt: '2026-10-06T00:00:00.000Z',
    request: {
      method: 'GET',
      target: '/api/info?x=1',
      path: '/api/info',
      rawHeaders: ['Host', '127.0.0.1'],
      bodyBytes: 0,
      body: { encoding: 'utf-8', content: '' },
    },
    configVersion: 3,
    matched: true,
    endpoint: 'GET /api/info',
    bodyValidationPassed: null,
    bodyRejection: null,
    sequencePosition: 0,
    sequenceLength: 1,
    plannedResponse: null,
    delivery: 'sent',
  });
  // 编号不按顺序也不连续：报告必须按输入顺序保留原编号
  const snapFile = await writeSnapshot(
    dir,
    'snap.json',
    JSON.stringify({ note: 'n', count: 3, records: [record(5), record(2), record(9)] }),
  );
  const result = await runVerify(snapFile, file);
  assert.equal(result.code, 0, '全部接受应退出 0');
  const report = parseReport(result);
  assert.deepEqual(report.records.map((r) => r.id), [5, 2, 9]);
  assert.equal(report.accepted, 3);
  assert.equal(report.unmatched, 0);
  assert.equal(report.rejected, 0);
});

// ---------------------------------------------------------------------------
// 输入失败：退出 2、stderr 指明文件与位置、stdout 无部分报告
// ---------------------------------------------------------------------------

function validRecord(id: number): Record<string, unknown> {
  return {
    id,
    receivedAt: '2026-10-06T00:00:00.000Z',
    request: {
      method: 'GET',
      target: '/api/info',
      path: '/api/info',
      rawHeaders: ['Host', '127.0.0.1'],
      bodyBytes: 0,
      body: { encoding: 'utf-8', content: '' },
    },
    configVersion: 1,
    matched: true,
    endpoint: 'GET /api/info',
    bodyValidationPassed: null,
    bodyRejection: null,
    sequencePosition: 0,
    sequenceLength: 1,
    plannedResponse: null,
    delivery: 'sent',
  };
}

function snapshotOf(records: unknown[], count?: number): string {
  return JSON.stringify({ note: 'n', count: count ?? records.length, records });
}

test('输入失败：各类快照问题退出 2、stderr 可定位、stdout 无部分报告', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'GET', path: '/api/info', responses: [sceneResponse()] }],
  });

  const mutated = (mutate: (snap: { count: number; records: Record<string, unknown>[] }) => void): string => {
    const snap = { note: 'n', count: 1, records: [validRecord(1)] };
    mutate(snap as never);
    return JSON.stringify(snap);
  };

  const cases: readonly { name: string; text: string; pattern: RegExp }[] = [
    {
      name: '计数不符',
      text: snapshotOf([validRecord(1)], 2),
      pattern: /计数不符/,
    },
    {
      name: '重复编号',
      text: snapshotOf([validRecord(1), validRecord(1)]),
      pattern: /records\[1\]\.id.*重复/,
    },
    {
      name: '编号类型错误',
      text: mutated((s) => {
        s.records[0].id = '1';
      }),
      pattern: /records\[0\]\.id/,
    },
    {
      name: '头数组不成对',
      text: mutated((s) => {
        (s.records[0].request as Record<string, unknown>).rawHeaders = ['Host'];
      }),
      pattern: /records\[0\]\.request\.rawHeaders/,
    },
    {
      name: '非法编码',
      text: mutated((s) => {
        (s.records[0].request as Record<string, unknown>).body = { encoding: 'utf-16', content: '' };
      }),
      pattern: /records\[0\]\.request\.body\.encoding/,
    },
    {
      name: '非法 base64 内容',
      text: mutated((s) => {
        (s.records[0].request as Record<string, unknown>).body = { encoding: 'base64', content: '***' };
      }),
      pattern: /base64/,
    },
    {
      name: '正文长度不符（已丢字节不猜补）',
      text: mutated((s) => {
        const req = s.records[0].request as Record<string, unknown>;
        req.bodyBytes = 3; // BOM 已丢：content 里没有，长度却对不上
        req.body = { encoding: 'utf-8', content: '' };
      }),
      pattern: /长度不符/,
    },
    {
      name: 'path 与 target 不符',
      text: mutated((s) => {
        const req = s.records[0].request as Record<string, unknown>;
        req.target = '/api/info?x=1';
        req.path = '/api/other';
      }),
      pattern: /records\[0\]\.request\.path/,
    },
    {
      name: '缺少重建所需字段',
      text: mutated((s) => {
        delete (s.records[0].request as Record<string, unknown>).body;
      }),
      pattern: /records\[0\]\.request\.body/,
    },
    {
      name: 'records 非数组',
      text: JSON.stringify({ note: 'n', count: 0, records: {} }),
      pattern: /records/,
    },
  ];

  for (const c of cases) {
    const snapshotFile = await writeSnapshot(dir, `bad-${cases.indexOf(c)}.json`, c.text);
    const result = await runVerify(snapshotFile, configFile);
    assert.equal(result.code, 2, `${c.name}：应退出 2，实际 ${result.code}\nstdout:\n${result.stdout}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 不得出现部分报告`);
    assert.ok(result.stderr.includes(snapshotFile), `${c.name}：stderr 应指明快照文件：\n${result.stderr}`);
    assert.ok(c.pattern.test(result.stderr), `${c.name}：stderr 应给出可定位位置（${c.pattern}）：\n${result.stderr}`);
  }
});

test('输入失败：读取失败、JSON 解析失败、场景非法、双文件同时失败', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'GET', path: '/api/info', responses: [sceneResponse()] }],
  });
  const goodSnapshot = await writeSnapshot(dir, 'good.json', snapshotOf([validRecord(1)]));

  // 快照文件不存在
  const missing = path.join(dir, 'missing.json');
  const r1 = await runVerify(missing, configFile);
  assert.equal(r1.code, 2);
  assert.equal(r1.stdout, '');
  assert.ok(r1.stderr.includes(missing), `stderr 应指明缺失文件：\n${r1.stderr}`);

  // 快照不是合法 JSON
  const badJson = await writeSnapshot(dir, 'bad.json', '{ "count": ');
  const r2 = await runVerify(badJson, configFile);
  assert.equal(r2.code, 2);
  assert.equal(r2.stdout, '');
  assert.ok(r2.stderr.includes(badJson));
  assert.ok(/JSON/i.test(r2.stderr), `stderr 应说明是 JSON 解析问题：\n${r2.stderr}`);

  // 场景配置非法（严格校验与 serve 相同）
  const badConfig = await writeConfig(dir, 'bad-config.json', {
    endpoints: [{ method: 'GET', path: '/api/info', responses: [sceneResponse()], oops: 1 }],
  });
  const r3 = await runVerify(goodSnapshot, badConfig);
  assert.equal(r3.code, 2);
  assert.equal(r3.stdout, '');
  assert.ok(r3.stderr.includes(badConfig), `stderr 应指明场景文件：\n${r3.stderr}`);
  assert.ok(r3.stderr.includes('endpoints[0]'), `stderr 应给出配置内位置：\n${r3.stderr}`);

  // 两份文件都失败：同时定位，stdout 仍为空
  const r4 = await runVerify(missing, badConfig);
  assert.equal(r4.code, 2);
  assert.equal(r4.stdout, '');
  assert.ok(r4.stderr.includes(missing), `stderr 应定位快照文件：\n${r4.stderr}`);
  assert.ok(r4.stderr.includes(badConfig), `stderr 应定位场景文件：\n${r4.stderr}`);
});

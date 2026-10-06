// 离线批量请求校验（verify 子命令）的回归测试
//
// 覆盖：
// - 由真实本机服务产生 GET /__contractlab/requests 快照（真实 HTTP/原始套接字
//   请求，含重复媒体类型头、非法 UTF-8、BOM、无正文规则接口、404、非 GET/POST），
//   用 verify 对照同一场景重新判定，并把相同原始请求字节回放到加载目标配置的
//   另一台真实服务，逐条核对在线/离线接受结论一致（场景 500 不算请求拒绝）；
// - 规则变化：同一快照对照修改过 requestBody / 删除接口的新场景，结论随之翻转；
// - 记录无损性：BOM 与空白保留在记录正文中，bodyBytes 与还原长度一致；
// - 退出码：空快照 / 全部接受退出 0，存在请求拒绝退出 1；
// - 输入失败（缺字段、类型错误、计数不符、重复编号、头数组不成对、path 与
//   target 不符、非法编码、长度不符、场景非法、文件缺失）：退出 2、stderr
//   指明文件与位置、stdout 无任何部分报告。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

// 目标场景 A：/api/order 的唯一响应是 500——被接受的请求照样拿到 500，
// 用以证明“场景配置的 500 不算请求拒绝”。
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
          fields: {
            id: { type: 'integer', required: true },
            note: { type: 'string' },
          },
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

// 场景 B：id 改为 string 必填、允许未声明字段、删除 /api/echo —— 规则变化
function configB(): unknown {
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
          fields: { id: { type: 'string', required: true } },
          additionalProperties: true,
        },
        responses: [{ status: 200, headers: {}, body: 'order-ok', delay: 0 }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 原始请求构造与收发
// ---------------------------------------------------------------------------

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

function rawJson(
  method: string,
  target: string,
  headers: readonly [string, string][],
  body: string,
): Buffer {
  return rawRequest(method, target, headers, Buffer.from(body, 'utf8'));
}

// 发送原始字节并读取响应状态码（请求带 Connection: close，响应结束即连接结束）
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
// 共用请求用例：同一批原始请求既用于生成快照，也用于向目标配置服务回放
// ---------------------------------------------------------------------------

interface Case {
  readonly name: string;
  readonly raw: Buffer;
  // 在线（场景 A）预期状态码
  readonly onlineA: number;
  // 离线（场景 A）预期结论
  readonly outcomeA: string;
  // 离线（场景 B）预期结论
  readonly outcomeB: string;
  // 在线（场景 B）预期状态码
  readonly onlineB: number;
}

const JSON_CT: [string, string] = ['Content-Type', 'application/json'];
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function buildCases(): Case[] {
  return [
    {
      name: '合格 JSON（场景响应为 500 也算接受）',
      raw: rawJson('POST', '/api/order', [JSON_CT], '{"id":1}'),
      onlineA: 500,
      outcomeA: 'passed',
      outcomeB: 'rejected', // id 变为 string 必填
      onlineB: 400,
    },
    {
      name: '结构差异（类型错 + 未声明字段）',
      raw: rawJson('POST', '/api/order', [JSON_CT], '{"id":"x","extra":1}'),
      onlineA: 400,
      outcomeA: 'rejected',
      outcomeB: 'passed', // id 为 string 且允许额外字段
      onlineB: 200,
    },
    {
      name: '媒体类型不符',
      raw: rawJson('POST', '/api/order', [['Content-Type', 'text/plain']], '{"id":1}'),
      onlineA: 400,
      outcomeA: 'rejected',
      outcomeB: 'rejected',
      onlineB: 400,
    },
    {
      name: '重复媒体类型头取在线顺序第一项',
      raw: rawJson(
        'POST',
        '/api/order',
        [
          ['Content-Type', 'application/json; charset=utf-8'],
          ['Content-Type', 'text/plain'],
        ],
        '{"id":2}',
      ),
      onlineA: 500,
      outcomeA: 'passed',
      outcomeB: 'rejected',
      onlineB: 400,
    },
    {
      name: '非法 UTF-8 正文（base64 记录，属请求解析拒绝而非输入错误）',
      raw: rawRequest(
        'POST',
        '/api/order',
        [JSON_CT],
        Buffer.from([0x7b, 0xff, 0xfe, 0x80, 0x7d]),
      ),
      onlineA: 400,
      outcomeA: 'rejected',
      outcomeB: 'rejected',
      onlineB: 400,
    },
    {
      name: '开头 BOM + 合法 JSON（媒体类型忽略大小写）',
      raw: rawRequest(
        'POST',
        '/api/order',
        [['Content-Type', 'Application/JSON']],
        Buffer.concat([BOM, Buffer.from('{"id":3}', 'utf8')]),
      ),
      onlineA: 500,
      outcomeA: 'passed',
      outcomeB: 'rejected',
      onlineB: 400,
    },
    {
      name: 'GET 带查询串（无需正文校验）',
      raw: rawJson('GET', '/api/seq?a=1&b=%E4%B8%AD', [], ''),
      onlineA: 200,
      outcomeA: 'no_body_check',
      outcomeB: 'no_body_check',
      onlineB: 200,
    },
    {
      name: '无正文规则接口不解析正文',
      raw: rawJson('POST', '/api/echo', [], 'not json at all'),
      onlineA: 201,
      outcomeA: 'no_body_check',
      outcomeB: 'unmatched', // 场景 B 删除了该接口
      onlineB: 404,
    },
    {
      name: '未匹配路径',
      raw: rawJson('GET', '/api/missing', [], ''),
      onlineA: 404,
      outcomeA: 'unmatched',
      outcomeB: 'unmatched',
      onlineB: 404,
    },
    {
      name: '非 GET/POST 方法为未匹配',
      raw: rawJson('PUT', '/api/seq', [], ''),
      onlineA: 404,
      outcomeA: 'unmatched',
      outcomeB: 'unmatched',
      onlineB: 404,
    },
  ];
}

// 由真实本机服务生成一批请求的快照文件；返回快照路径与用例
async function generateSnapshot(
  t: TestContext,
  dir: string,
  cases: readonly Case[],
): Promise<string> {
  const configFile = await writeConfig(dir, 'scenes-a.json', configA());
  const server = await startServer(configFile);
  t.after(server.close);

  for (const c of cases) {
    const status = await rawExchange(server.port, c.raw);
    assert.equal(status, c.onlineA, `用例「${c.name}」在线（场景 A）状态码`);
  }

  const snapshotText = await httpGetBody(server.port, '/__contractlab/requests');
  const snapshot = JSON.parse(snapshotText) as { count: number; records: unknown[] };
  assert.equal(snapshot.count, cases.length);
  assert.equal(snapshot.records.length, cases.length);
  return writeText(dir, 'snapshot.json', snapshotText);
}

function runVerify(requests: string, config: string): Promise<CliResult> {
  return runCli(['verify', '--requests', requests, '--config', config]);
}

interface VerifyReport {
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly results: readonly {
    readonly id: number;
    readonly outcome: string;
    readonly endpoint: string | null;
    readonly rejection?: {
      readonly stage: string;
      readonly message: string;
      readonly problems: readonly {
        readonly pointer: string;
        readonly expected: string;
        readonly actual: string;
      }[];
    };
  }[];
}

// 在线状态码 -> 结论类别（400=正文拒绝，404=未匹配，其余=接受）
function onlineCategory(status: number): string {
  if (status === 400) {
    return 'rejected';
  }
  if (status === 404) {
    return 'unmatched';
  }
  return 'accepted';
}

function offlineCategory(outcome: string): string {
  return outcome === 'passed' || outcome === 'no_body_check' ? 'accepted' : outcome;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('真实快照逐条重判：结论与回放核对一致；重复头/非法 UTF-8/BOM/500 语义正确', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const cases = buildCases();
  const snapshotFile = await generateSnapshot(t, dir, cases);
  const configFile = await writeConfig(dir, 'scenes-a.json', configA());

  // 记录无损性：BOM 保留在 utf-8 文本中且长度一致；非法 UTF-8 用 base64
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8')) as {
    records: {
      request: { bodyBytes: number; body: { encoding: string; content: string } };
    }[];
  };
  const bomRec = snapshot.records[5];
  assert.equal(bomRec.request.body.encoding, 'utf-8');
  assert.ok(
    bomRec.request.body.content.startsWith('\uFEFF'),
    '开头 BOM 必须保留在记录正文中（无损）',
  );
  assert.equal(
    bomRec.request.bodyBytes,
    Buffer.byteLength(bomRec.request.body.content, 'utf8'),
    'bodyBytes 必须与记录正文还原长度一致',
  );
  assert.equal(snapshot.records[4].request.body.encoding, 'base64');

  const result = await runVerify(snapshotFile, configFile);
  assert.equal(result.code, 1, '存在请求拒绝应退出 1');
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout) as VerifyReport;
  assert.equal(report.total, cases.length);
  assert.equal(report.accepted, 5);
  assert.equal(report.rejected, 5);
  assert.deepEqual(
    report.results.map((r) => r.id),
    cases.map((_, i) => i + 1),
    '按输入顺序保留原编号',
  );
  assert.deepEqual(
    report.results.map((r) => r.outcome),
    cases.map((c) => c.outcomeA),
  );

  // 命中接口的记录带 endpoint；未匹配为 null
  assert.equal(report.results[0].endpoint, 'POST /api/order');
  assert.equal(report.results[8].endpoint, null);
  assert.equal(report.results[9].endpoint, null);

  // 正文拒绝复用解析/结构差异报告：指针、期望与实际值齐全
  const structure = report.results[1].rejection;
  assert.equal(structure?.stage, 'structure');
  assert.deepEqual(structure?.problems, [
    { pointer: '/id', expected: 'integer', actual: 'string' },
    { pointer: '/extra', expected: '未声明的字段（不允许）', actual: 'number' },
  ]);
  const media = report.results[2].rejection;
  assert.equal(media?.stage, 'parse');
  assert.match(media?.message ?? '', /媒体类型不符/);
  const utf8 = report.results[4].rejection;
  assert.equal(utf8?.stage, 'parse');
  assert.match(utf8?.message ?? '', /UTF-8/);

  // 回放核对：把相同原始请求发到加载场景 A 的另一台真实服务，
  // 在线接受结论必须与离线逐条一致
  const replay = await startServer(configFile);
  t.after(replay.close);
  for (let i = 0; i < cases.length; i += 1) {
    const status = await rawExchange(replay.port, cases[i].raw);
    assert.equal(
      onlineCategory(status),
      offlineCategory(report.results[i].outcome),
      `用例「${cases[i].name}」在线/离线结论不一致（在线状态 ${status}）`,
    );
  }
});


test('规则变化：同一快照对照新场景，结论随之翻转，并与新服务回放一致', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const cases = buildCases();
  const snapshotFile = await generateSnapshot(t, dir, cases);
  const configBFile = await writeConfig(dir, 'scenes-b.json', configB());

  const result = await runVerify(snapshotFile, configBFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as VerifyReport;
  assert.equal(report.total, cases.length);
  assert.equal(report.accepted, 2);
  assert.equal(report.rejected, 8);
  assert.deepEqual(
    report.results.map((r) => r.outcome),
    cases.map((c) => c.outcomeB),
  );
  // 翻转为拒绝的记录给出结构差异报告
  const flipped = report.results[0].rejection;
  assert.equal(flipped?.stage, 'structure');
  assert.deepEqual(flipped?.problems, [
    { pointer: '/id', expected: 'string', actual: 'number' },
  ]);
  // 被删除的接口变为未匹配
  assert.equal(report.results[7].outcome, 'unmatched');
  assert.equal(report.results[7].endpoint, null);

  // 回放核对：相同原始请求发到加载场景 B 的真实服务
  const replayConfig = await writeConfig(dir, 'scenes-b2.json', configB());
  const replay = await startServer(replayConfig);
  t.after(replay.close);
  for (let i = 0; i < cases.length; i += 1) {
    const status = await rawExchange(replay.port, cases[i].raw);
    assert.equal(status, cases[i].onlineB, `用例「${cases[i].name}」在线（场景 B）状态码`);
    assert.equal(
      onlineCategory(status),
      offlineCategory(report.results[i].outcome),
      `用例「${cases[i].name}」在线/离线结论不一致（在线状态 ${status}）`,
    );
  }
});

test('空快照退出 0；全部接受（含 base64 正文、乱序编号）退出 0', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes-a.json', configA());

  const emptyFile = await writeText(
    dir,
    'empty.json',
    JSON.stringify({ note: '空快照', count: 0, records: [] }),
  );
  const emptyResult = await runVerify(emptyFile, configFile);
  assert.equal(emptyResult.code, 0);
  const emptyReport = JSON.parse(emptyResult.stdout) as VerifyReport;
  assert.equal(emptyReport.total, 0);
  assert.equal(emptyReport.accepted, 0);
  assert.equal(emptyReport.rejected, 0);
  assert.deepEqual(emptyReport.results, []);

  // 手工快照：只含重建所需字段（其余字段不被要求），编号不按序、base64 正文
  const okBody = Buffer.from('{"id":1}', 'utf8');
  const snapshot = {
    count: 3,
    records: [
      {
        id: 9,
        request: {
          method: 'GET',
          target: '/api/seq?x=1',
          path: '/api/seq',
          rawHeaders: ['Host', '127.0.0.1'],
          bodyBytes: 0,
          body: { encoding: 'utf-8', content: '' },
        },
      },
      {
        id: 4,
        request: {
          method: 'POST',
          target: '/api/order',
          path: '/api/order',
          rawHeaders: ['content-type', 'application/json; charset=utf-8'],
          bodyBytes: okBody.byteLength,
          body: { encoding: 'base64', content: okBody.toString('base64') },
        },
      },
      {
        id: 7,
        request: {
          method: 'POST',
          target: '/api/echo',
          path: '/api/echo',
          rawHeaders: [],
          bodyBytes: 3,
          body: { encoding: 'utf-8', content: 'abc' },
        },
      },
    ],
  };
  const okFile = await writeText(dir, 'ok.json', JSON.stringify(snapshot));
  const okResult = await runVerify(okFile, configFile);
  assert.equal(okResult.code, 0, `全部接受应退出 0：${okResult.stderr}`);
  const okReport = JSON.parse(okResult.stdout) as VerifyReport;
  assert.equal(okReport.total, 3);
  assert.equal(okReport.accepted, 3);
  assert.equal(okReport.rejected, 0);
  assert.deepEqual(
    okReport.results.map((r) => r.id),
    [9, 4, 7],
    '按输入顺序保留原编号',
  );
  assert.deepEqual(
    okReport.results.map((r) => r.outcome),
    ['no_body_check', 'passed', 'no_body_check'],
  );
});

test('输入失败：快照损坏、场景非法、文件缺失均退出 2 且无部分报告', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes-a.json', configA());

  const baseRecord = (): Record<string, unknown> => ({
    id: 1,
    request: {
      method: 'GET',
      target: '/api/seq?x=1',
      path: '/api/seq',
      rawHeaders: ['Host', '127.0.0.1'],
      bodyBytes: 0,
      body: { encoding: 'utf-8', content: '' },
    },
  });
  const baseSnapshot = (): Record<string, unknown> => ({
    note: 'base',
    count: 1,
    records: [baseRecord()],
  });

  const corrupt = (
    mutate: (snap: Record<string, unknown>, rec: Record<string, unknown>) => void,
  ): Record<string, unknown> => {
    const snap = baseSnapshot();
    mutate(snap, (snap.records as unknown[])[0] as Record<string, unknown>);
    return snap;
  };
  const withRequest = (
    rec: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): void => {
    rec.request = { ...(rec.request as Record<string, unknown>), ...patch };
  };

  const cases: { name: string; snapshot: unknown; expect: RegExp }[] = [
    {
      name: 'count 与记录数不符',
      snapshot: corrupt((s) => {
        s.count = 2;
      }),
      expect: /count/,
    },
    {
      name: '编号重复',
      snapshot: { count: 2, records: [baseRecord(), baseRecord()] },
      expect: /records\[1\]\.id.*重复/,
    },
    {
      name: 'id 类型错误',
      snapshot: corrupt((_s, r) => {
        r.id = '1';
      }),
      expect: /records\[0\]\.id/,
    },
    {
      name: '缺少 request',
      snapshot: corrupt((_s, r) => {
        delete r.request;
      }),
      expect: /records\[0\]\.request/,
    },
    {
      name: '头数组不成对',
      snapshot: corrupt((_s, r) => withRequest(r, { rawHeaders: ['Host'] })),
      expect: /rawHeaders.*成对/,
    },
    {
      name: '头元素非字符串',
      snapshot: corrupt((_s, r) => withRequest(r, { rawHeaders: [1, 'x'] })),
      expect: /rawHeaders\[0\]/,
    },
    {
      name: 'path 与 target 不符',
      snapshot: corrupt((_s, r) => withRequest(r, { path: '/api/other' })),
      expect: /path.*不符/,
    },
    {
      name: '非法编码',
      snapshot: corrupt((_s, r) =>
        withRequest(r, { body: { encoding: 'utf8', content: '' } }),
      ),
      expect: /encoding/,
    },
    {
      name: 'base64 内容非法',
      snapshot: corrupt((_s, r) =>
        withRequest(r, { bodyBytes: 3, body: { encoding: 'base64', content: '###' } }),
      ),
      expect: /base64/,
    },
    {
      name: 'base64 还原长度与 bodyBytes 不符',
      snapshot: corrupt((_s, r) =>
        withRequest(r, {
          bodyBytes: 99,
          body: { encoding: 'base64', content: Buffer.from('{"id":1}').toString('base64') },
        }),
      ),
      expect: /不符/,
    },
    {
      name: 'utf-8 还原长度与 bodyBytes 不符（已丢字节不猜补）',
      snapshot: corrupt((_s, r) =>
        withRequest(r, { bodyBytes: 100, body: { encoding: 'utf-8', content: '{"id":1}' } }),
      ),
      expect: /不符/,
    },
    {
      name: 'utf-8 含孤立代理项（替换后长度吻合仍拒绝）',
      snapshot: corrupt((_s, r) =>
        withRequest(r, {
          bodyBytes: 3,
          body: { encoding: 'utf-8', content: '\uD800' },
        }),
      ),
      expect: /孤立代理/,
    },
    {
      name: 'records 非数组',
      snapshot: { count: 0, records: {} },
      expect: /records/,
    },
  ];

  for (const c of cases) {
    const file = await writeText(dir, `bad-${cases.indexOf(c)}.json`, JSON.stringify(c.snapshot));
    const result = await runVerify(file, configFile);
    assert.equal(result.code, 2, `用例「${c.name}」应退出 2`);
    assert.equal(result.stdout, '', `用例「${c.name}」不得输出部分报告`);
    assert.ok(result.stderr.includes(file), `用例「${c.name}」stderr 应指明文件：${result.stderr}`);
    assert.match(result.stderr, c.expect, `用例「${c.name}」stderr 应指明位置`);
  }

  // 快照不是合法 JSON
  const notJson = await writeText(dir, 'not-json.json', '{ broken');
  const notJsonResult = await runVerify(notJson, configFile);
  assert.equal(notJsonResult.code, 2);
  assert.equal(notJsonResult.stdout, '');
  assert.match(notJsonResult.stderr, /不是合法 JSON/);

  // 快照文件缺失
  const missingResult = await runVerify(`${dir}/no-such.json`, configFile);
  assert.equal(missingResult.code, 2);
  assert.equal(missingResult.stdout, '');
  assert.match(missingResult.stderr, /no-such\.json/);

  // 场景配置非法（未知字段）：严格校验，退出 2
  const badConfig = await writeText(
    dir,
    'bad-config.json',
    JSON.stringify({ endpoints: [{ method: 'GET', path: '/a', responses: [], bogus: 1 }] }),
  );
  const okSnapshot = await writeText(dir, 'ok-snap.json', JSON.stringify(baseSnapshot()));
  const badConfigResult = await runVerify(okSnapshot, badConfig);
  assert.equal(badConfigResult.code, 2);
  assert.equal(badConfigResult.stdout, '');
  assert.ok(
    badConfigResult.stderr.includes(badConfig),
    `stderr 应指明场景文件：${badConfigResult.stderr}`,
  );

  // 两份输入都失败：两处错误都报告，stdout 仍为空
  const bothBad = await runVerify(notJson, badConfig);
  assert.equal(bothBad.code, 2);
  assert.equal(bothBad.stdout, '');
  assert.ok(bothBad.stderr.includes(notJson), 'stderr 应包含快照文件错误');
  assert.ok(bothBad.stderr.includes(badConfig), 'stderr 应包含场景文件错误');
});

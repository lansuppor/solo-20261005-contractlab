// 可选 JSON 语义比较（replay --strategy）的回归测试
//
// 覆盖：
// - 混合接口：策略按“方法 + 去掉查询串后的字面路径”选中的接口改用 JSON 语义
//   比较（忽略排版与键顺序），未选中的接口仍按字节比较；
// - JSON 差异明细：RFC 6901 指针、计划/实际值、明确缺失标记、数组多出/缺失
//   元素在下标处报告且不另报长度、节点缺失或类型不同只报该节点；
//   状态码始终精确比较；
// - 忽略指针：数组项不移位、根（""）、空字段名、__proto__、~0/~1 转义、
//   重复与父子重叠不改变结果、祖先类型不同仍报告；
// - 标量语义：数字按解析数值比较（0 与 -0 等价、1e2 与 100）、不做类型转换；
// - 实际完整响应非 JSON / 非 UTF-8：记正文差异、说明原因并继续后续记录；
// - 输入失败：非法策略（非 JSON、重复接口、非法指针、未知字段、空 endpoints）、
//   所选记录计划正文非 JSON / 空 / 双 BOM、忽略规则不豁免解析——
//   退出 2、stderr 定位文件与字段、stdout 为空且零请求；
//   未选中记录的计划正文不解析（对照）。

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  makeTempDir,
  runCli,
  startServer,
  writeConfig,
  writeText,
  type CliResult,
} from './helpers.ts';

// ---------------------------------------------------------------------------
// 快照 / 策略构造与 replay 调用
// ---------------------------------------------------------------------------

interface ReplayReport {
  readonly requestsFile: string;
  readonly strategyFile?: string;
  readonly total: number;
  readonly same: number;
  readonly different: number;
  readonly failed: number;
  readonly results: readonly {
    readonly id: number;
    readonly outcome: string;
    readonly differences?: { status: boolean; body: boolean };
    readonly bodyDifferences?: readonly unknown[];
    readonly planned?: { status: number; body: { encoding: string; content: string } };
    readonly response?: { status: number; body: { encoding: string; content: string } };
    readonly reason?: string;
  }[];
}

function makeRecord(
  id: number,
  patch?: {
    method?: string;
    target?: string;
    plannedBody?: string;
    plannedStatus?: number;
  },
): Record<string, unknown> {
  const target = patch?.target ?? '/api/json';
  return {
    id,
    receivedAt: '2026-10-06T00:00:00.000Z',
    request: {
      method: patch?.method ?? 'GET',
      target,
      path: target.split('?')[0],
      rawHeaders: ['Host', '127.0.0.1:9999'],
      bodyBytes: 0,
      body: { encoding: 'utf-8', content: '' },
    },
    configVersion: 1,
    matched: true,
    endpoint: null,
    bodyValidationPassed: null,
    bodyRejection: null,
    sequencePosition: null,
    sequenceLength: null,
    plannedResponse: {
      kind: 'scene',
      status: patch?.plannedStatus ?? 200,
      headers: {},
      body: patch?.plannedBody ?? '{}',
    },
    delivery: 'sent',
  };
}

function makeSnapshot(records: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ note: 'replay JSON 语义比较测试快照', count: records.length, records });
}

async function runReplayWithStrategy(
  snapshotFile: string,
  port: number,
  strategyFile: string,
): Promise<CliResult> {
  return runCli([
    'replay',
    '--requests',
    snapshotFile,
    '--port',
    String(port),
    '--timeout',
    '10000',
    '--strategy',
    strategyFile,
  ]);
}

// 简单目标服务：按路径给固定响应（body 可为任意字节），并记录到达的请求
async function startTarget(
  t: import('node:test').TestContext,
  routes: Readonly<Record<string, { status?: number; body: string | Buffer }>>,
): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(String(req.url));
    req.resume();
    req.on('end', () => {
      const route = routes[String(req.url)] ?? { status: 404, body: 'not found' };
      res.writeHead(route.status ?? 200);
      res.end(route.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, hits };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('混合接口：策略选中的接口按 JSON 语义比较（排版与键顺序无关），未选中接口仍按字节比较', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'GET',
        path: '/api/json',
        responses: [{ status: 200, headers: {}, body: '{"b":2,"a":1}', delay: 0 }],
      },
      {
        method: 'GET',
        path: '/api/raw',
        responses: [{ status: 200, headers: {}, body: '{ "x": 1 }', delay: 0 }],
      },
    ],
  });
  const target = await startServer(configFile);
  t.after(target.close);

  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      // JSON 模式：键顺序与排版不同，语义相同；查询串不参与策略选择
      makeRecord(1, { target: '/api/json?ts=123&x=%41', plannedBody: '{\n  "a": 1,\n  "b": 2\n}' }),
      // 字节模式：仅排版不同也算差异
      makeRecord(2, { target: '/api/raw', plannedBody: '{"x":1}' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/json' }] }),
  );

  const result = await runReplayWithStrategy(snapshotFile, target.port, strategyFile);
  assert.equal(result.code, 1, `字节接口有差异应退出 1：${result.stderr}`);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.strategyFile, strategyFile, '报告应记录所用策略文件');
  assert.equal(report.total, 2);
  assert.equal(report.same, 1);
  assert.equal(report.different, 1);

  // JSON 语义比较：键顺序与排版不影响结论；完整响应保留无损正文
  assert.equal(report.results[0].outcome, 'same');
  assert.equal(report.results[0].response?.body.content, '{"b":2,"a":1}');

  // 未选中的接口仍按字节比较：仅排版不同即差异，且无 JSON 差异明细
  assert.equal(report.results[1].outcome, 'different');
  assert.deepEqual(report.results[1].differences, { status: false, body: true });
  assert.equal(report.results[1].planned?.body.content, '{"x":1}');
  assert.equal(report.results[1].response?.body.content, '{ "x": 1 }');
  assert.ok(
    !('bodyDifferences' in report.results[1]),
    '字节比较模式不得出现 bodyDifferences',
  );
});

test('JSON 差异明细：指针、计划/实际值、明确缺失、数组不另报长度、类型不同只报该节点；状态码始终精确比较', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'GET',
        path: '/api/order',
        responses: [
          {
            status: 200,
            headers: {},
            body: '{"id":2,"name":42,"tags":["a"],"extra":true}',
            delay: 0,
          },
        ],
      },
      {
        method: 'GET',
        path: '/api/status',
        responses: [{ status: 201, headers: {}, body: '{"ok":true}', delay: 0 }],
      },
    ],
  });
  const target = await startServer(configFile);
  t.after(target.close);

  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, {
        target: '/api/order',
        plannedBody: '{"id":1,"name":"x","tags":["a","b"],"note":null}',
      }),
      // 状态码不同、正文语义相同（仅排版差异）
      makeRecord(2, { target: '/api/status', plannedStatus: 200, plannedBody: '{ "ok" : true }' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    JSON.stringify({
      endpoints: [
        { method: 'GET', path: '/api/order' },
        { method: 'GET', path: '/api/status' },
      ],
    }),
  );

  const result = await runReplayWithStrategy(snapshotFile, target.port, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.different, 2);

  // 全部独立差异：标量值、类型不同（只报该节点）、数组缺失元素在下标处报告
  // （不另报长度）、缺失与 null 不同、未声明的额外字段指向其自身
  assert.equal(report.results[0].outcome, 'different');
  assert.deepEqual(report.results[0].differences, { status: false, body: true });
  assert.deepEqual(report.results[0].bodyDifferences, [
    { pointer: '/id', planned: 1, actual: 2 },
    { pointer: '/name', planned: 'x', actual: 42 },
    { pointer: '/tags/1', planned: 'b', actual: 'missing' },
    { pointer: '/note', planned: null, actual: 'missing' },
    { pointer: '/extra', planned: 'missing', actual: true },
  ]);
  // 差异项保留计划与实际正文的无损表示
  assert.equal(
    report.results[0].planned?.body.content,
    '{"id":1,"name":"x","tags":["a","b"],"note":null}',
  );
  assert.equal(
    report.results[0].response?.body.content,
    '{"id":2,"name":42,"tags":["a"],"extra":true}',
  );

  // 状态码始终精确比较；正文语义相同则 body 不为差异项，明细为空
  assert.equal(report.results[1].outcome, 'different');
  assert.deepEqual(report.results[1].differences, { status: true, body: false });
  assert.deepEqual(report.results[1].bodyDifferences, []);
  assert.equal(report.results[1].planned?.status, 200);
  assert.equal(report.results[1].response?.status, 201);
});

test('忽略指针：数组项不移位、根、空字段名、__proto__、~0/~1 转义、重复与父子重叠不改变结果、祖先类型不同仍报告', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'GET',
        path: '/api/item',
        responses: [
          {
            status: 200,
            headers: {},
            body: '{"items":[1,99,3],"meta":{"ts":123},"a/b":1,"c~d":2,"__proto__":3,"":4,"id":5}',
            delay: 0,
          },
        ],
      },
      {
        method: 'GET',
        path: '/api/shift',
        responses: [{ status: 200, headers: {}, body: '{"items":[1,3]}', delay: 0 }],
      },
      {
        method: 'GET',
        path: '/api/anc',
        responses: [{ status: 200, headers: {}, body: '{"a":"str"}', delay: 0 }],
      },
      {
        method: 'GET',
        path: '/api/root',
        responses: [{ status: 200, headers: {}, body: '{"x":1}', delay: 0 }],
      },
    ],
  });
  const target = await startServer(configFile);
  t.after(target.close);

  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      // 特殊字段与转义：空字段名（指针 "/"）、__proto__、含 "/" 与 "~" 的字段名；
      // 忽略项含重复（/items/1 两次）与父子重叠（/meta 与 /meta/ts），不改变结果
      makeRecord(1, {
        target: '/api/item',
        plannedBody:
          '{"items":[1,2,3],"meta":{"ts":0},"a/b":9,"c~d":9,"__proto__":9,"":9,"id":5}',
      }),
      // 忽略 /items/1 不删除数组项、不移动下标：计划的 3 仍在下标 2 报告缺失
      makeRecord(2, { target: '/api/shift', plannedBody: '{"items":[1,2,3]}' }),
      // 祖先类型不同仍报告：忽略 /a/b 不掩盖 /a 本身的类型差异
      makeRecord(3, { target: '/api/anc', plannedBody: '{"a":{"b":1}}' }),
      // 根忽略（""）：两侧类型完全不同也无差异（但两侧仍须可解析）
      makeRecord(4, { target: '/api/root', plannedBody: '[1,2]' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    JSON.stringify({
      endpoints: [
        {
          method: 'GET',
          path: '/api/item',
          ignore: [
            '/items/1',
            '/meta',
            '/meta/ts',
            '/a~1b',
            '/c~0d',
            '/__proto__',
            '/',
            '/items/1',
          ],
        },
        { method: 'GET', path: '/api/shift', ignore: ['/items/1'] },
        { method: 'GET', path: '/api/anc', ignore: ['/a/b'] },
        { method: 'GET', path: '/api/root', ignore: [''] },
      ],
    }),
  );

  const result = await runReplayWithStrategy(snapshotFile, target.port, strategyFile);
  assert.equal(result.code, 1, `应只有 shift 与 anc 两条差异：${result.stdout}`);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.deepEqual(
    report.results.map((r) => r.outcome),
    ['same', 'different', 'different', 'same'],
  );

  // 忽略数组项不移位：唯一差异是下标 2 处的缺失元素
  assert.deepEqual(report.results[1].bodyDifferences, [
    { pointer: '/items/2', planned: 3, actual: 'missing' },
  ]);

  // 祖先类型不同仍报告：只报 /a 一个节点
  assert.deepEqual(report.results[2].bodyDifferences, [
    { pointer: '/a', planned: { b: 1 }, actual: 'str' },
  ]);
});

test('标量语义：数字按解析数值比较（0 与 -0 等价、1e2 与 100 相等），不做类型转换', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'GET',
        path: '/api/num',
        responses: [
          { status: 200, headers: {}, body: '{"zero":-0,"big":100,"half":0.5}', delay: 0 },
        ],
      },
      {
        method: 'GET',
        path: '/api/type',
        responses: [{ status: 200, headers: {}, body: '{"n":1}', delay: 0 }],
      },
    ],
  });
  const target = await startServer(configFile);
  t.after(target.close);

  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/num', plannedBody: '{"zero":0,"big":1e2,"half":0.5}' }),
      makeRecord(2, { target: '/api/type', plannedBody: '{"n":"1"}' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    JSON.stringify({
      endpoints: [
        { method: 'GET', path: '/api/num' },
        { method: 'GET', path: '/api/type' },
      ],
    }),
  );

  const result = await runReplayWithStrategy(snapshotFile, target.port, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.results[0].outcome, 'same', '0 与 -0 等价、1e2 与 100 按解析数值相等');
  assert.equal(report.results[1].outcome, 'different');
  assert.deepEqual(report.results[1].bodyDifferences, [
    { pointer: '/n', planned: '1', actual: 1 },
  ]);
});

test('实际响应非 JSON / 非 UTF-8：记正文差异、说明原因并继续后续记录', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    '/api/json': { body: 'not-json{{' },
    '/api/bin': { body: Buffer.from([0xff, 0xfe, 0x80]) },
    '/api/ok': { body: '{"k":1}' },
  });

  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/json', plannedBody: '{"a":1}' }),
      makeRecord(2, { target: '/api/bin', plannedBody: '{"a":1}' }),
      makeRecord(3, { target: '/api/ok', plannedBody: '{"k":1}' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    JSON.stringify({
      endpoints: [
        { method: 'GET', path: '/api/json' },
        { method: 'GET', path: '/api/bin' },
        { method: 'GET', path: '/api/ok' },
      ],
    }),
  );

  const result = await runReplayWithStrategy(snapshotFile, target.port, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as ReplayReport;
  assert.equal(report.total, 3);
  assert.equal(report.different, 2);
  assert.equal(report.same, 1);
  assert.equal(report.failed, 0, '解析失败不是通信失败');

  const first = report.results[0].bodyDifferences?.[0] as { message?: string };
  assert.match(first.message ?? '', /不是合法 JSON/);
  const second = report.results[1].bodyDifferences?.[0] as { message?: string };
  assert.match(second.message ?? '', /不是合法 UTF-8/);
  assert.equal(report.results[2].outcome, 'same');
  assert.deepEqual(target.hits, ['/api/json', '/api/bin', '/api/ok'], '解析失败后继续后续记录');
});

test('输入失败：非法策略与非法所选计划正文退出 2、stderr 定位、stdout 为空、零请求；未选中记录的计划正文不解析', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  // 计数型目标：任何输入失败都不得有请求到达；对照用例固定回 "not-json"
  const target = await startTarget(t, {
    '/api/json': { body: '{}' },
    '/api/raw': { body: 'not-json' },
  });

  const okSnapshot = await writeText(
    dir,
    'ok.json',
    makeSnapshot([makeRecord(1, { target: '/api/json', plannedBody: '{}' })]),
  );
  const okStrategy = await writeText(
    dir,
    'strategy-ok.json',
    JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/json' }] }),
  );

  const cases: { name: string; strategy: string; snapshot: string; expect: RegExp }[] = [];

  // 策略文件本身的失败形态
  const badStrategyJson = await writeText(dir, 'bad-json.json', 'not-json{');
  cases.push({
    name: '策略不是合法 JSON',
    strategy: badStrategyJson,
    snapshot: okSnapshot,
    expect: /比较策略文件 .* 不是合法 JSON/,
  });
  const dupStrategy = await writeText(
    dir,
    'dup.json',
    JSON.stringify({
      endpoints: [
        { method: 'GET', path: '/api/json' },
        { method: 'GET', path: '/api/json' },
      ],
    }),
  );
  cases.push({ name: '重复接口', strategy: dupStrategy, snapshot: okSnapshot, expect: /重复/ });
  const badPointer = await writeText(
    dir,
    'bad-pointer.json',
    JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/json', ignore: ['/a~2'] }] }),
  );
  cases.push({
    name: '非法忽略指针',
    strategy: badPointer,
    snapshot: okSnapshot,
    expect: /endpoints\[0\]\.ignore\[0\].*非法转义/,
  });
  const unknownField = await writeText(
    dir,
    'unknown.json',
    JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/json', mode: 'json' }] }),
  );
  cases.push({
    name: '策略未知字段',
    strategy: unknownField,
    snapshot: okSnapshot,
    expect: /未知字段/,
  });
  const emptyEndpoints = await writeText(dir, 'empty.json', JSON.stringify({ endpoints: [] }));
  cases.push({
    name: '空 endpoints',
    strategy: emptyEndpoints,
    snapshot: okSnapshot,
    expect: /非空数组/,
  });

  // 所选记录计划正文的失败形态（定位到快照文件与字段）
  const notJsonBody = await writeText(
    dir,
    'body-not-json.json',
    makeSnapshot([makeRecord(1, { target: '/api/json', plannedBody: 'not-json' })]),
  );
  cases.push({
    name: '计划正文非 JSON',
    strategy: okStrategy,
    snapshot: notJsonBody,
    expect: /records\[0\]\.plannedResponse\.body/,
  });
  const emptyBody = await writeText(
    dir,
    'body-empty.json',
    makeSnapshot([makeRecord(1, { target: '/api/json', plannedBody: '' })]),
  );
  cases.push({
    name: '计划正文为空',
    strategy: okStrategy,
    snapshot: emptyBody,
    expect: /records\[0\]\.plannedResponse\.body.*空正文/,
  });
  const doubleBom = await writeText(
    dir,
    'body-double-bom.json',
    makeSnapshot([makeRecord(1, { target: '/api/json', plannedBody: '\uFEFF\uFEFF{}' })]),
  );
  cases.push({
    name: '计划正文双 BOM（仅可剥离单个）',
    strategy: okStrategy,
    snapshot: doubleBom,
    expect: /records\[0\]\.plannedResponse\.body/,
  });
  // 忽略规则不豁免解析：即使忽略根指针，非法计划正文仍整份拒绝
  const rootIgnore = await writeText(
    dir,
    'root-ignore.json',
    JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/json', ignore: [''] }] }),
  );
  cases.push({
    name: '忽略根指针不豁免解析',
    strategy: rootIgnore,
    snapshot: notJsonBody,
    expect: /records\[0\]\.plannedResponse\.body/,
  });

  for (const [index, c] of cases.entries()) {
    const result = await runReplayWithStrategy(c.snapshot, target.port, c.strategy);
    assert.equal(result.code, 2, `用例「${c.name}」应退出 2：${result.stdout}`);
    assert.equal(result.stdout, '', `用例「${c.name}」stdout 必须为空`);
    assert.match(result.stderr, c.expect, `用例「${c.name}」stderr 应可定位`);
    assert.ok(
      result.stderr.includes(c.strategy) || result.stderr.includes(c.snapshot),
      `用例「${c.name}」stderr 应指明输入文件`,
    );
    assert.equal(target.hits.length, 0, `用例「${c.name}」（#${index}）不得发出任何请求`);
  }

  // 策略文件缺失
  const missing = await runReplayWithStrategy(okSnapshot, target.port, `${dir}/no-such.json`);
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /读取比较策略文件 .*no-such\.json/);
  assert.equal(target.hits.length, 0);

  // 对照：未被策略选中的记录不解析计划正文（非 JSON 也合法），仍按字节比较
  const controlSnapshot = await writeText(
    dir,
    'control.json',
    makeSnapshot([makeRecord(1, { target: '/api/raw', plannedBody: 'not-json' })]),
  );
  const control = await runReplayWithStrategy(controlSnapshot, target.port, okStrategy);
  assert.equal(control.code, 0, `未选中记录的计划正文不参与 JSON 校验：${control.stderr}`);
  const controlReport = JSON.parse(control.stdout) as ReplayReport;
  assert.equal(controlReport.same, 1);
  assert.deepEqual(target.hits, ['/api/raw'], '对照用例正常发出请求');

  // 空快照：提供策略也退出 0、不发任何请求
  const emptySnapshot = await writeText(dir, 'empty-snapshot.json', makeSnapshot([]));
  const empty = await runReplayWithStrategy(emptySnapshot, target.port, okStrategy);
  assert.equal(empty.code, 0);
  assert.equal((JSON.parse(empty.stdout) as ReplayReport).total, 0);
  assert.deepEqual(target.hits, ['/api/raw']);
});

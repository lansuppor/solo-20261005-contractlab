// replay 可选 JSON 语义响应比较（--strategy）的回归测试
//
// 覆盖：
// - 混合接口：策略选中的接口按 JSON 语义比较（忽略排版、键序与动态字段），
//   未选中的接口仍按正文原始字节比较；
// - JSON 差异报告：列出全部未忽略的独立差异（RFC 6901 位置、计划/实际值、
//   明确缺失），节点缺失或类型不同只报该节点，数组多出/缺失元素在下标报告；
// - 忽略数组项不删除、不移位；重复与父子重叠的忽略项不改变结果；
// - 特殊字段名（空字段名、__proto__、~0/~1 转义）与根指针忽略；
//   祖先类型不同仍报告；忽略规则不豁免解析；
// - 实际响应非 UTF-8 / 非 JSON 记正文差异（说明原因）并继续后续记录；
// - 数字按解析数值比较（0 与 -0 等价）、标量不转换类型、缺失与 null 不同；
// - 输入失败（非法策略、重复接口、非法指针、所选记录计划正文非 JSON）：
//   退出 2、stderr 定位文件与字段、stdout 为空且零请求。

import assert from 'node:assert/strict';
import http from 'node:http';
import test, { type TestContext } from 'node:test';
import { makeTempDir, runCli, writeText, type CliResult } from './helpers.ts';

// ---------------------------------------------------------------------------
// 快照与策略构造
// ---------------------------------------------------------------------------

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
  const plannedBody = patch?.plannedBody ?? '{"ok":true}';
  return {
    id,
    receivedAt: '2026-10-07T00:00:00.000Z',
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
      body: plannedBody,
    },
    delivery: 'sent',
  };
}

function makeSnapshot(records: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ note: 'replay-json 测试快照', count: records.length, records });
}

function makeStrategy(endpoints: readonly unknown[]): string {
  return JSON.stringify({ endpoints });
}

// ---------------------------------------------------------------------------
// 目标服务：按“方法 + 去查询串路径”路由到预设状态与正文（正文可为任意字节）
// ---------------------------------------------------------------------------

interface Route {
  readonly status: number;
  readonly body: string | Buffer;
}

interface Target {
  readonly port: number;
  readonly hits: readonly string[];
}

async function startTarget(t: TestContext, routes: Readonly<Record<string, Route>>): Promise<Target> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const key = `${String(req.method)} ${String(req.url).split('?')[0]}`;
    hits.push(key);
    const route = routes[key] ?? { status: 404, body: 'not found' };
    req.resume();
    req.on('end', () => {
      res.writeHead(route.status, { 'Content-Type': 'application/json; charset=utf-8' });
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
// replay 调用与报告类型
// ---------------------------------------------------------------------------

interface BodyDifference {
  readonly pointer: string;
  readonly planned: unknown;
  readonly actual: unknown;
}

interface JsonReplayReport {
  readonly total: number;
  readonly same: number;
  readonly different: number;
  readonly failed: number;
  readonly results: readonly {
    readonly id: number;
    readonly outcome: string;
    readonly differences?: { status: boolean; body: boolean };
    readonly bodyDifferences?: readonly BodyDifference[];
    readonly bodyError?: string;
    readonly planned?: { status: number; body: { encoding: string; content: string } };
    readonly response?: { status: number; body: { encoding: string; content: string } };
    readonly reason?: string;
  }[];
}

function runReplay(
  requests: string,
  port: number,
  timeoutMs: number,
  strategy?: string,
): Promise<CliResult> {
  const args = ['replay', '-r', requests, '-p', String(port), '-t', String(timeoutMs)];
  if (strategy !== undefined) {
    args.push('--strategy', strategy);
  }
  return runCli(args);
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test('混合接口：选中接口忽略排版/键序/动态字段，未选中接口仍按字节比较', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    // 语义相同但排版、键序不同，且动态字段取值不同（被忽略）
    'GET /api/order': { status: 200, body: '{ "b": [ 1, 2 ], "a": 1, "ts": 99999 }' },
    // 未选中接口：仅排版不同也属字节差异
    'GET /api/plain': { status: 200, body: '{ "x": 1 }' },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/order?verbose=1', plannedBody: '{"a":1,"b":[1,2],"ts":1}' }),
      makeRecord(2, { target: '/api/plain', plannedBody: '{"x":1}' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([{ method: 'GET', path: '/api/order', ignore: ['/ts'] }]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1, '字节模式接口存在差异应退出 1');
  const report = JSON.parse(result.stdout) as JsonReplayReport;
  assert.equal(report.total, 2);
  assert.equal(report.same, 1);
  assert.equal(report.different, 1);

  // JSON 模式：排版、键序与被忽略的动态字段不造成差异
  assert.equal(report.results[0].outcome, 'same');
  assert.equal(report.results[0].response?.body.content, '{ "b": [ 1, 2 ], "a": 1, "ts": 99999 }');

  // 字节模式：仅排版差异即不同，且不附带 JSON 差异字段
  assert.equal(report.results[1].outcome, 'different');
  assert.deepEqual(report.results[1].differences, { status: false, body: true });
  assert.equal(report.results[1].bodyDifferences, undefined);
  assert.equal(report.results[1].bodyError, undefined);
  assert.equal(report.results[1].planned?.body.content, '{"x":1}');
  assert.equal(report.results[1].response?.body.content, '{ "x": 1 }');
});

test('JSON 差异报告：全部独立差异、RFC 6901 位置、计划/实际值与明确缺失', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    'GET /api/order': {
      status: 200,
      body: JSON.stringify({
        keep: 1,
        chg: 2,
        typ: [1], // 计划为对象：类型不同只报该节点
        arr: [1, 9], // 元素变化 + 少一个元素
        num: '1', // 不做类型转换
        extraNull: null, // 缺失与 null 不同
      }),
    },
  });
  const plannedBody = JSON.stringify({
    keep: 1,
    chg: 1,
    gone: 5,
    typ: { x: 1 },
    arr: [1, 2, 3],
    explicitNull: null,
    num: 1,
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([makeRecord(1, { target: '/api/order', plannedBody })]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([{ method: 'GET', path: '/api/order' }]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as JsonReplayReport;
  assert.equal(report.different, 1);
  const entry = report.results[0];
  assert.equal(entry.outcome, 'different');
  assert.deepEqual(entry.differences, { status: false, body: true });
  assert.deepEqual(entry.bodyDifferences, [
    { pointer: '/chg', planned: 1, actual: 2 },
    { pointer: '/gone', planned: 5, actual: 'missing' },
    { pointer: '/typ', planned: { x: 1 }, actual: [1] },
    { pointer: '/arr/1', planned: 2, actual: 9 },
    { pointer: '/arr/2', planned: 3, actual: 'missing' }, // 缺失元素在下标报告，不另报长度
    { pointer: '/explicitNull', planned: null, actual: 'missing' },
    { pointer: '/num', planned: 1, actual: '1' },
    { pointer: '/extraNull', planned: 'missing', actual: null },
  ]);
  // 差异项保留计划与实际正文的无损表示
  assert.equal(entry.planned?.body.content, plannedBody);
  assert.equal(entry.response?.status, 200);
});

test('忽略数组项不删除不移位；数字 0 与 -0 等价', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    // 被忽略的下标 1 取值不同；0 与 -0 等价
    'GET /api/items': { status: 200, body: '{"items":[1,9,3],"zero":-0}' },
    // 被忽略的下标不参与，但其余下标不移动：多出的元素在其下标报告
    'GET /api/items2': { status: 200, body: '{"items":[1,9,3,4]}' },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/items', plannedBody: '{"items":[1,2,3],"zero":0}' }),
      makeRecord(2, { target: '/api/items2', plannedBody: '{"items":[1,2,3]}' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([
      { method: 'GET', path: '/api/items', ignore: ['/items/1'] },
      { method: 'GET', path: '/api/items2', ignore: ['/items/1'] },
    ]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as JsonReplayReport;
  assert.equal(report.same, 1);
  assert.equal(report.different, 1);
  assert.equal(report.results[0].outcome, 'same', '忽略下标 1 且 0 与 -0 等价');
  assert.equal(report.results[1].outcome, 'different');
  assert.deepEqual(report.results[1].bodyDifferences, [
    { pointer: '/items/3', planned: 'missing', actual: 4 },
  ]);
});

test('特殊字段名、根指针忽略、重复与父子重叠忽略项、祖先类型不同仍报告', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    // 空字段名、__proto__、含 / 与 ~ 的字段名、嵌套对象：全部取值不同但都被忽略
    'GET /api/special': {
      status: 200,
      body: '{"":10,"__proto__":20,"a/b":30,"m~n":40,"obj":{"x":9,"y":8}}',
    },
    // 根指针忽略：任意 JSON 都相同（两侧仍须可解析）
    'GET /api/root': { status: 200, body: '[1,2,3]' },
    // __proto__ 作为普通自有字段参与比较（未忽略时）
    'GET /api/proto': { status: 200, body: '{"__proto__":2,"a":1}' },
    // 忽略 /a/b，但祖先 /a 类型不同仍报告
    'GET /api/ancestor': { status: 200, body: '{"a":5}' },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, {
        target: '/api/special',
        plannedBody: '{"":1,"__proto__":2,"a/b":3,"m~n":4,"obj":{"x":1,"y":2}}',
      }),
      makeRecord(2, { target: '/api/root', plannedBody: '{"a":1}' }),
      makeRecord(3, { target: '/api/proto', plannedBody: '{"__proto__":1,"a":1}' }),
      makeRecord(4, { target: '/api/ancestor', plannedBody: '{"a":{"b":1}}' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([
      {
        method: 'GET',
        path: '/api/special',
        // 重复（"/" 两次）与父子重叠（/obj 与 /obj/x）的忽略项不改变结果
        ignore: ['/', '/', '/__proto__', '/a~1b', '/m~0n', '/obj', '/obj/x'],
      },
      { method: 'GET', path: '/api/root', ignore: [''] },
      { method: 'GET', path: '/api/proto' },
      { method: 'GET', path: '/api/ancestor', ignore: ['/a/b'] },
    ]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as JsonReplayReport;
  assert.equal(report.same, 2);
  assert.equal(report.different, 2);
  assert.equal(report.results[0].outcome, 'same', '特殊字段名忽略（含根外全部字段）');
  assert.equal(report.results[1].outcome, 'same', '根指针忽略整个正文（两侧均可解析）');
  assert.equal(report.results[2].outcome, 'different');
  assert.deepEqual(report.results[2].bodyDifferences, [
    { pointer: '/__proto__', planned: 1, actual: 2 },
  ]);
  assert.equal(report.results[3].outcome, 'different');
  assert.deepEqual(report.results[3].bodyDifferences, [
    { pointer: '/a', planned: { b: 1 }, actual: 5 },
  ]);
});

test('实际响应非 JSON/非 UTF-8 记正文差异并继续后续记录；两侧可剥离单个开头 BOM', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    'GET /api/json': { status: 200, body: 'not-json-at-all' },
    'GET /api/json2': { status: 200, body: '{ "b" : 2 }' },
    'GET /api/plain': { status: 200, body: 'plain-ok' },
    'GET /api/json3': { status: 200, body: Buffer.from([0xff, 0xfe, 0x80]) },
    'GET /api/json4': {
      status: 200,
      body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{ "d" : 4 }', 'utf8')]),
    },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/json', plannedBody: '{"a":1}' }),
      makeRecord(2, { target: '/api/json2', plannedBody: '{"b":2}' }),
      makeRecord(3, { target: '/api/plain', plannedBody: 'plain-ok' }),
      makeRecord(4, { target: '/api/json3', plannedBody: '{"c":3}' }),
      // 计划正文同样仅可剥离单个开头 BOM
      makeRecord(5, { target: '/api/json4', plannedBody: '\uFEFF{"d":4}' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([
      { method: 'GET', path: '/api/json' },
      { method: 'GET', path: '/api/json2' },
      { method: 'GET', path: '/api/json3' },
      { method: 'GET', path: '/api/json4' },
    ]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as JsonReplayReport;
  assert.equal(report.total, 5);
  assert.equal(report.same, 3);
  assert.equal(report.different, 2);
  assert.equal(report.failed, 0, '解析失败不是通信失败');
  assert.equal(target.hits.length, 5, '解析失败后继续后续记录');

  // 非 JSON：记正文差异并说明原因，保留无损正文
  assert.equal(report.results[0].outcome, 'different');
  assert.deepEqual(report.results[0].differences, { status: false, body: true });
  assert.match(report.results[0].bodyError ?? '', /不是合法 JSON/);
  assert.equal(report.results[0].bodyDifferences, undefined);
  assert.equal(report.results[0].response?.body.content, 'not-json-at-all');

  // 排版差异被忽略
  assert.equal(report.results[1].outcome, 'same');
  // 字节模式接口不受影响
  assert.equal(report.results[2].outcome, 'same');

  // 非 UTF-8：同样记正文差异并说明原因（base64 无损保留）
  assert.equal(report.results[3].outcome, 'different');
  assert.match(report.results[3].bodyError ?? '', /不是合法 UTF-8/);
  assert.equal(report.results[3].response?.body.encoding, 'base64');

  // 两侧各剥离单个开头 BOM 后语义相同
  assert.equal(report.results[4].outcome, 'same');
});

test('状态码始终精确比较（JSON 模式下正文相同也算差异）', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    'GET /api/order': { status: 201, body: '{ "a": 1 }' },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([makeRecord(1, { target: '/api/order', plannedBody: '{"a":1}' })]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([{ method: 'GET', path: '/api/order' }]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as JsonReplayReport;
  assert.equal(report.different, 1);
  assert.deepEqual(report.results[0].differences, { status: true, body: false });
  assert.equal(report.results[0].bodyDifferences, undefined);
});

test('输入失败：非法策略与所选记录计划正文非 JSON，退出 2、stderr 定位、stdout 为空且零请求', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);

  // 计数型目标：任何输入失败都不得有请求到达
  let hits = 0;
  const counter = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on('end', () => res.end('{"ok":true}'));
  });
  await new Promise<void>((resolve) => counter.listen(0, '127.0.0.1', resolve));
  t.after(() => counter.close());
  const address = counter.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const okSnapshot = await writeText(
    dir,
    'ok.json',
    makeSnapshot([makeRecord(1, { target: '/api/json', plannedBody: '{"a":1}' })]),
  );
  const okStrategy = await writeText(
    dir,
    'ok-strategy.json',
    makeStrategy([{ method: 'GET', path: '/api/json' }]),
  );

  // 策略文件本身的失败：stderr 指明策略文件
  const strategyCases: { name: string; strategy: string; expect: RegExp }[] = [
    { name: '策略不是合法 JSON', strategy: '{bad', expect: /比较策略文件.*不是合法 JSON/ },
    { name: '顶层未知字段', strategy: '{"endpoints":[],"extra":1}', expect: /未知字段 "extra"/ },
    {
      name: '接口未知字段',
      strategy: makeStrategy([{ method: 'GET', path: '/api/json', mode: 'json' }]),
      expect: /endpoints\[0\].*未知字段 "mode"/,
    },
    {
      name: '重复接口',
      strategy: makeStrategy([
        { method: 'GET', path: '/api/json' },
        { method: 'GET', path: '/api/json' },
      ]),
      expect: /endpoints\[1\].*重复/,
    },
    {
      name: '非法方法',
      strategy: makeStrategy([{ method: 'PUT', path: '/api/json' }]),
      expect: /endpoints\[0\]\.method/,
    },
    {
      name: '路径不以 / 开头',
      strategy: makeStrategy([{ method: 'GET', path: 'api/json' }]),
      expect: /endpoints\[0\]\.path/,
    },
    {
      name: 'ignore 非数组',
      strategy: makeStrategy([{ method: 'GET', path: '/api/json', ignore: '/a' }]),
      expect: /endpoints\[0\]\.ignore 必须是/,
    },
    {
      name: '指针非法转义',
      strategy: makeStrategy([{ method: 'GET', path: '/api/json', ignore: ['/a~2'] }]),
      expect: /endpoints\[0\]\.ignore\[0\].*非法转义/,
    },
    {
      name: '指针不以 / 开头',
      strategy: makeStrategy([{ method: 'GET', path: '/api/json', ignore: ['a'] }]),
      expect: /endpoints\[0\]\.ignore\[0\].*"\/" 开头/,
    },
    {
      name: '指针非字符串',
      strategy: makeStrategy([{ method: 'GET', path: '/api/json', ignore: [1] }]),
      expect: /endpoints\[0\]\.ignore\[0\].*指针字符串/,
    },
  ];
  for (const c of strategyCases) {
    const file = await writeText(dir, `bad-strategy-${strategyCases.indexOf(c)}.json`, c.strategy);
    const result = await runReplay(okSnapshot, port, 5_000, file);
    assert.equal(result.code, 2, `用例「${c.name}」应退出 2`);
    assert.equal(result.stdout, '', `用例「${c.name}」stdout 必须为空`);
    assert.ok(result.stderr.includes(file), `用例「${c.name}」stderr 应指明策略文件：${result.stderr}`);
    assert.match(result.stderr, c.expect, `用例「${c.name}」stderr 应定位字段`);
  }
  const missing = await runReplay(okSnapshot, port, 5_000, `${dir}/no-such-strategy.json`);
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /no-such-strategy\.json/);

  // 所选记录的计划正文须为 UTF-8 JSON（仅可剥离单个开头 BOM，空正文非法）
  const bodyCases: { name: string; plannedBody: string; expect: RegExp }[] = [
    { name: '计划正文非 JSON', plannedBody: 'not-json', expect: /不是合法 JSON/ },
    { name: '计划正文为空', plannedBody: '', expect: /空正文/ },
    { name: '计划正文仅 BOM', plannedBody: '\uFEFF', expect: /空正文/ },
    { name: '计划正文双 BOM', plannedBody: '\uFEFF\uFEFF{"a":1}', expect: /不是合法 JSON/ },
  ];
  for (const c of bodyCases) {
    const file = await writeText(
      dir,
      `bad-body-${bodyCases.indexOf(c)}.json`,
      makeSnapshot([makeRecord(1, { target: '/api/json', plannedBody: c.plannedBody })]),
    );
    const result = await runReplay(file, port, 5_000, okStrategy);
    assert.equal(result.code, 2, `用例「${c.name}」应退出 2`);
    assert.equal(result.stdout, '', `用例「${c.name}」stdout 必须为空`);
    assert.ok(result.stderr.includes(file), `用例「${c.name}」stderr 应指明快照文件：${result.stderr}`);
    assert.match(result.stderr, /records\[0\]\.plannedResponse\.body/, `用例「${c.name}」应定位字段`);
    assert.match(result.stderr, c.expect, `用例「${c.name}」stderr 应说明原因`);
  }

  // 未被策略选中的记录：计划正文不是 JSON 也不影响（仍按字节比较）
  const unselected = await writeText(
    dir,
    'unselected.json',
    makeSnapshot([makeRecord(1, { target: '/api/other', plannedBody: 'not-json' })]),
  );
  const unselectedResult = await runReplay(unselected, port, 5_000, okStrategy);
  assert.notEqual(unselectedResult.code, 2, '未选中接口的计划正文不做 JSON 校验');

  assert.equal(hits, 1, '输入失败时不得发出任何请求（仅未选中接口用例发出 1 条）');
});

test('空快照 + 策略：退出 0，不发任何请求', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const emptyFile = await writeText(
    dir,
    'empty.json',
    JSON.stringify({ note: '空快照', count: 0, records: [] }),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([{ method: 'GET', path: '/api/json' }]),
  );
  let hits = 0;
  const counter = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on('end', () => res.end('{}'));
  });
  await new Promise<void>((resolve) => counter.listen(0, '127.0.0.1', resolve));
  t.after(() => counter.close());
  const address = counter.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const result = await runReplay(emptyFile, port, 1_000, strategyFile);
  assert.equal(result.code, 0, `空快照应退出 0：${result.stderr}`);
  const report = JSON.parse(result.stdout) as JsonReplayReport;
  assert.equal(report.total, 0);
  assert.equal(hits, 0);
});

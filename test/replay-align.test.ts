// replay 数组业务键对齐（--strategy 的 align）的回归测试
//
// 覆盖：
// - 纯重排不误报；重排后字段变化按业务键配对，差异明细给出双方各自在原始
//   正文中的 RFC 6901 位置；
// - 增删键：只在一侧出现的键报告整个元素（不深入），双方独立存在性标记，
//   缺失不以 null 或字符串 "missing" 表示；数组本身缺失按原节点差异处理；
// - 忽略与对齐交互：忽略指针以计划原下标定位并作用于配对元素（含缺失元素）、
//   新增键不被其他下标的忽略项遮蔽、忽略整数组仍生效、忽略不豁免键校验；
// - 混合键类型：字符串/数字/布尔严格按类型（1 ≠ "1"）、0 与 -0 等价；
// - 特殊字段：空键名、__proto__ 键名、~0/~1 位置转义、根指针对齐；
// - 非法配置（重复/嵌套位置、非法指针与键）退出 2；
// - 计划末条对齐非法时零请求、退出 2 并定位记录与正文位置；
// - 实际响应对齐非法记 different（alignmentErrors 位置+原因、该位置回退
//   下标比较）并继续后续记录，不算通信失败。

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
  const target = patch?.target ?? '/api/items';
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
  return JSON.stringify({ note: 'replay-align 测试快照', count: records.length, records });
}

function makeStrategy(endpoints: readonly unknown[]): string {
  return JSON.stringify({ endpoints });
}

// ---------------------------------------------------------------------------
// 目标服务：按“方法 + 去查询串路径”路由到预设状态与正文
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

interface AlignedDifference {
  readonly array: string;
  readonly keyField: string;
  readonly key: unknown;
  readonly plannedPointer?: string;
  readonly actualPointer?: string;
  readonly plannedExists: boolean;
  readonly actualExists: boolean;
  readonly planned: unknown;
  readonly actual: unknown;
}

interface AlignReplayReport {
  readonly total: number;
  readonly same: number;
  readonly different: number;
  readonly failed: number;
  readonly results: readonly {
    readonly id: number;
    readonly outcome: string;
    readonly differences?: { status: boolean; body: boolean };
    readonly bodyDifferences?: readonly { pointer: string; planned: unknown; actual: unknown }[];
    readonly alignedDifferences?: readonly AlignedDifference[];
    readonly alignmentErrors?: readonly { pointer: string; reason: string }[];
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

test('纯重排不误报；重排后字段变化按业务键配对并给出双方原正文位置', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    // 仅顺序变化：不造成任何差异
    'GET /api/items': { status: 200, body: '[{"id":2,"v":"b"},{"id":1,"v":"a"}]' },
    // 重排 + 字段变化：id=2 的 state 变了，位置在两侧不同
    'GET /api/orders': {
      status: 200,
      body: '{"items":[{"id":2,"state":"created"},{"id":1,"state":"paid"}]}',
    },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/items', plannedBody: '[{"id":1,"v":"a"},{"id":2,"v":"b"}]' }),
      makeRecord(2, {
        target: '/api/orders',
        plannedBody: '{"items":[{"id":1,"state":"paid"},{"id":2,"state":"paid"}]}',
      }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([
      { method: 'GET', path: '/api/items', align: [{ pointer: '', key: 'id' }] },
      { method: 'GET', path: '/api/orders', align: [{ pointer: '/items', key: 'id' }] },
    ]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReplayReport;
  assert.equal(report.same, 1, '纯重排（根指针对齐）不应误报');
  assert.equal(report.different, 1);
  assert.equal(report.results[0].outcome, 'same');

  const entry = report.results[1];
  assert.equal(entry.outcome, 'different');
  assert.deepEqual(entry.differences, { status: false, body: true });
  assert.equal(entry.bodyDifferences, undefined, '对齐数组内差异不进入普通差异列表');
  assert.deepEqual(entry.alignedDifferences, [
    {
      array: '/items',
      keyField: 'id',
      key: 2,
      plannedPointer: '/items/1/state',
      actualPointer: '/items/0/state',
      plannedExists: true,
      actualExists: true,
      planned: 'paid',
      actual: 'created',
    },
  ]);
  // 差异项保留双方正文的无损表示（不改写、不排序）
  assert.equal(entry.planned?.body.content, '{"items":[{"id":1,"state":"paid"},{"id":2,"state":"paid"}]}');
  assert.equal(entry.response?.body.content, '{"items":[{"id":2,"state":"created"},{"id":1,"state":"paid"}]}');
});

test('增删键报告整个元素（独立存在性标记，缺失≠null/"missing"）；数组本身缺失按原节点差异', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    // id=2 仅计划侧，id=4 仅实际侧；id=1 配对且内部字段缺失（null 与缺失区分）
    'GET /api/items': {
      status: 200,
      body: '[{"id":3,"x":null},{"id":1,"v":"a"},{"id":4,"v":"d"}]',
    },
    // 数组本身缺失：按原节点差异处理
    'GET /api/gone': { status: 200, body: '{"other":1}' },
  });
  const plannedBody = '[{"id":1,"v":"a","w":1},{"id":2,"v":"b"},{"id":3,"x":null}]';
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/items', plannedBody }),
      makeRecord(2, { target: '/api/gone', plannedBody: '{"items":[{"id":1}],"other":1}' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([
      { method: 'GET', path: '/api/items', align: [{ pointer: '', key: 'id' }] },
      { method: 'GET', path: '/api/gone', align: [{ pointer: '/items', key: 'id' }] },
    ]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReplayReport;
  assert.equal(report.different, 2);

  const entry = report.results[0];
  assert.deepEqual(entry.alignedDifferences, [
    // 计划下标顺序：id=1 配对，字段 w 仅计划侧存在
    {
      array: '',
      keyField: 'id',
      key: 1,
      plannedPointer: '/0/w',
      plannedExists: true,
      actualExists: false,
      planned: 1,
      actual: null,
    },
    // id=2 仅计划侧：报告整个元素，不深入
    {
      array: '',
      keyField: 'id',
      key: 2,
      plannedPointer: '/1',
      plannedExists: true,
      actualExists: false,
      planned: { id: 2, v: 'b' },
      actual: null,
    },
    // id=4 仅实际侧（新键）：报告整个元素
    {
      array: '',
      keyField: 'id',
      key: 4,
      actualPointer: '/2',
      plannedExists: false,
      actualExists: true,
      planned: null,
      actual: { id: 4, v: 'd' },
    },
  ]);
  // 缺失不以字符串 "missing" 或混淆的 null 表示：存在性由独立标记给出
  for (const diff of entry.alignedDifferences ?? []) {
    assert.notEqual(diff.planned, 'missing');
    assert.notEqual(diff.actual, 'missing');
    assert.equal(typeof diff.plannedExists, 'boolean');
    assert.equal(typeof diff.actualExists, 'boolean');
  }

  // 数组本身缺失：普通节点差异（"missing" 语义沿用），无对齐明细
  const gone = report.results[1];
  assert.equal(gone.outcome, 'different');
  assert.equal(gone.alignedDifferences, undefined);
  assert.deepEqual(gone.bodyDifferences, [
    { pointer: '/items', planned: [{ id: 1 }], actual: 'missing' },
  ]);
});

test('忽略与对齐交互：计划原下标定位、缺失元素、新键不被遮蔽、忽略整数组、忽略不豁免键校验', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    // 计划下标 0（id=1）被忽略：配对后其字段差异与存在性都不报；
    // id=2 配对且字段变化照报；id=9 为新增键，不被 /items/0 的忽略遮蔽
    'GET /api/items': {
      status: 200,
      body: '{"items":[{"id":2,"v":"B"},{"id":1,"v":"CHANGED"},{"id":9,"v":"new"}]}',
    },
    // 忽略整数组：任意重排与增删都相同
    'GET /api/whole': { status: 200, body: '{"items":[{"id":9}]}' },
    // 计划下标 0（id=1）被忽略且该键在实际侧缺失：缺失元素同样被忽略
    'GET /api/missing': { status: 200, body: '[{"id":2,"v":"b"}]' },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, {
        target: '/api/items',
        plannedBody: '{"items":[{"id":1,"v":"a"},{"id":2,"v":"b"}]}',
      }),
      makeRecord(2, { target: '/api/whole', plannedBody: '{"items":[{"id":1}]}' }),
      makeRecord(3, {
        target: '/api/missing',
        plannedBody: '[{"id":1,"v":"a"},{"id":2,"v":"b"}]',
      }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([
      { method: 'GET', path: '/api/items', ignore: ['/items/0'], align: [{ pointer: '/items', key: 'id' }] },
      { method: 'GET', path: '/api/whole', ignore: ['/items'], align: [{ pointer: '/items', key: 'id' }] },
      { method: 'GET', path: '/api/missing', ignore: ['/0'], align: [{ pointer: '', key: 'id' }] },
    ]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReplayReport;
  assert.equal(report.same, 2, '忽略整数组与忽略缺失元素均应相同');
  assert.equal(report.different, 1);

  // 被忽略的计划下标 0（id=1）不产生差异，但其配对身份不变（id=1 不报为新增）；
  // id=2 的字段变化照报；id=9 是新增键，不被 /items/0 遮蔽
  assert.deepEqual(report.results[0].alignedDifferences, [
    {
      array: '/items',
      keyField: 'id',
      key: 2,
      plannedPointer: '/items/1/v',
      actualPointer: '/items/0/v',
      plannedExists: true,
      actualExists: true,
      planned: 'b',
      actual: 'B',
    },
    {
      array: '/items',
      keyField: 'id',
      key: 9,
      actualPointer: '/items/2',
      plannedExists: false,
      actualExists: true,
      planned: null,
      actual: { id: 9, v: 'new' },
    },
  ]);
  assert.equal(report.results[1].outcome, 'same', '忽略整数组：重排与增删都不报');
  assert.equal(report.results[2].outcome, 'same', '被忽略的计划元素在实际侧缺失也不报');

  // 忽略不豁免键完整性与唯一性校验：被忽略下标的重复键仍使计划侧非法
  const badSnapshot = await writeText(
    dir,
    'bad.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/items', plannedBody: '{"items":[{"id":1},{"id":1},{"id":2}]}' }),
    ]),
  );
  const badResult = await runReplay(badSnapshot, target.port, 5_000, strategyFile);
  assert.equal(badResult.code, 2, '被忽略下标的重复键仍属计划侧非法');
  assert.equal(badResult.stdout, '');
  assert.match(badResult.stderr, /records\[0\]\.plannedResponse\.body/);
  assert.match(badResult.stderr, /重复/);
});

test('混合键类型：严格按类型（1 ≠ "1"）、0 与 -0 等价、布尔键', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    // 数字 1 与字符串 "1" 是不同的键；布尔 true 与字符串 "true" 也不同；
    // 计划侧 0 与实际侧 -0 是同一个键
    'GET /api/keys': {
      status: 200,
      body: '[{"k":"1","v":"s"},{"k":true,"v":"b"},{"k":-0,"v":"zero"}]',
    },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, {
        target: '/api/keys',
        plannedBody: '[{"k":1,"v":"n"},{"k":"true","v":"t"},{"k":0,"v":"zero"}]',
      }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([{ method: 'GET', path: '/api/keys', align: [{ pointer: '', key: 'k' }] }]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReplayReport;
  assert.equal(report.different, 1);
  // 0/-0 配对成功（无差异）；1 与 "1"、true 与 "true" 各自只在一侧出现
  assert.deepEqual(report.results[0].alignedDifferences, [
    { array: '', keyField: 'k', key: 1, plannedPointer: '/0', plannedExists: true, actualExists: false, planned: { k: 1, v: 'n' }, actual: null },
    { array: '', keyField: 'k', key: 'true', plannedPointer: '/1', plannedExists: true, actualExists: false, planned: { k: 'true', v: 't' }, actual: null },
    { array: '', keyField: 'k', key: '1', actualPointer: '/0', plannedExists: false, actualExists: true, planned: null, actual: { k: '1', v: 's' } },
    { array: '', keyField: 'k', key: true, actualPointer: '/1', plannedExists: false, actualExists: true, planned: null, actual: { k: true, v: 'b' } },
  ]);
});

test('特殊字段：空键名、__proto__ 键名、~0/~1 位置转义', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    // 空字段名作键（纯重排）
    'GET /api/empty': { status: 200, body: '[{"":"b","v":9},{"":"a","v":1}]' },
    // __proto__ 字段名作键（自有字段）
    'GET /api/proto': { status: 200, body: '[{"__proto__":"y","v":9},{"__proto__":"x","v":1}]' },
    // 位置含 / 与 ~ 的字段名：~1 与 ~0 转义
    'GET /api/esc': { status: 200, body: '{"a/b":{"m~n":[{"id":2,"v":"B"},{"id":1,"v":"a"}]}}' },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/empty', plannedBody: '[{"":"a","v":1},{"":"b","v":9}]' }),
      makeRecord(2, { target: '/api/proto', plannedBody: '[{"__proto__":"x","v":1},{"__proto__":"y","v":2}]' }),
      makeRecord(3, { target: '/api/esc', plannedBody: '{"a/b":{"m~n":[{"id":1,"v":"a"},{"id":2,"v":"b"}]}}' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([
      { method: 'GET', path: '/api/empty', align: [{ pointer: '', key: '' }] },
      { method: 'GET', path: '/api/proto', align: [{ pointer: '', key: '__proto__' }] },
      { method: 'GET', path: '/api/esc', align: [{ pointer: '/a~1b/m~0n', key: 'id' }] },
    ]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReplayReport;
  assert.equal(report.same, 1, '空键名纯重排不报');
  assert.equal(report.different, 2);
  assert.deepEqual(report.results[1].alignedDifferences, [
    {
      array: '',
      keyField: '__proto__',
      key: 'y',
      plannedPointer: '/1/v',
      actualPointer: '/0/v',
      plannedExists: true,
      actualExists: true,
      planned: 2,
      actual: 9,
    },
  ]);
  assert.deepEqual(report.results[2].alignedDifferences, [
    {
      array: '/a~1b/m~0n',
      keyField: 'id',
      key: 2,
      plannedPointer: '/a~1b/m~0n/1/v',
      actualPointer: '/a~1b/m~0n/0/v',
      plannedExists: true,
      actualExists: true,
      planned: 'b',
      actual: 'B',
    },
  ]);
});

test('非法配置：重复位置、嵌套位置（含根）、非法指针与键，退出 2 且零请求', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  let hits = 0;
  const counter = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on('end', () => res.end('[]'));
  });
  await new Promise<void>((resolve) => counter.listen(0, '127.0.0.1', resolve));
  t.after(() => counter.close());
  const address = counter.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const okSnapshot = await writeText(
    dir,
    'ok.json',
    makeSnapshot([makeRecord(1, { target: '/api/items', plannedBody: '[{"id":1}]' })]),
  );

  const cases: { name: string; align: unknown; expect: RegExp }[] = [
    { name: 'align 非数组', align: '/items', expect: /endpoints\[0\]\.align 必须是数组/ },
    { name: '条目非对象', align: ['/items'], expect: /endpoints\[0\]\.align\[0\] 必须是对象/ },
    { name: '条目未知字段', align: [{ pointer: '/items', key: 'id', mode: 'x' }], expect: /align\[0\].*未知字段 "mode"/ },
    { name: '指针非法', align: [{ pointer: 'items', key: 'id' }], expect: /align\[0\]\.pointer.*"\/" 开头/ },
    { name: '键非字符串', align: [{ pointer: '/items', key: 1 }], expect: /align\[0\]\.key 必须是字符串/ },
    {
      name: '重复位置',
      align: [
        { pointer: '/items', key: 'id' },
        { pointer: '/items', key: 'uid' },
      ],
      expect: /align\[1\]\.pointer.*重复/,
    },
    {
      name: '嵌套位置',
      align: [
        { pointer: '/items', key: 'id' },
        { pointer: '/items/0', key: 'id' },
      ],
      expect: /align\[1\]\.pointer.*嵌套/,
    },
    {
      name: '根与其他位置嵌套',
      align: [
        { pointer: '', key: 'id' },
        { pointer: '/items', key: 'id' },
      ],
      expect: /align\[1\]\.pointer.*嵌套/,
    },
  ];
  for (const c of cases) {
    const file = await writeText(
      dir,
      `bad-align-${cases.indexOf(c)}.json`,
      makeStrategy([{ method: 'GET', path: '/api/items', align: c.align }]),
    );
    const result = await runReplay(okSnapshot, port, 5_000, file);
    assert.equal(result.code, 2, `用例「${c.name}」应退出 2`);
    assert.equal(result.stdout, '', `用例「${c.name}」stdout 必须为空`);
    assert.ok(result.stderr.includes(file), `用例「${c.name}」stderr 应指明策略文件`);
    assert.match(result.stderr, c.expect, `用例「${c.name}」stderr 应定位字段：${result.stderr}`);
  }
  assert.equal(hits, 0, '非法配置不得发出任何请求');
});

test('计划末条对齐非法：退出 2、stderr 定位记录与正文位置、stdout 为空且零请求', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  let hits = 0;
  const counter = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on('end', () => res.end('[{"id":1}]'));
  });
  await new Promise<void>((resolve) => counter.listen(0, '127.0.0.1', resolve));
  t.after(() => counter.close());
  const address = counter.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([{ method: 'GET', path: '/api/items', align: [{ pointer: '', key: 'id' }] }]),
  );

  const bodyCases: { name: string; plannedBody: string; expect: RegExp }[] = [
    { name: '对齐位置不是数组', plannedBody: '{"id":1}', expect: /不是数组/ },
    { name: '元素不是对象', plannedBody: '[{"id":1},2]', expect: /"\/1".*必须是对象|必须是对象.*"\/1"/ },
    { name: '缺少键字段', plannedBody: '[{"id":1},{"uid":2}]', expect: /缺少键字段/ },
    { name: '键为 null', plannedBody: '[{"id":null}]', expect: /null 不能作键/ },
    { name: '键为对象', plannedBody: '[{"id":{"x":1}}]', expect: /必须是字符串、有限数字或布尔值/ },
    { name: '键重复', plannedBody: '[{"id":1},{"id":1}]', expect: /重复/ },
  ];
  for (const c of bodyCases) {
    // 首条合法、末条非法：全部计划正文有效前不得连接，零请求
    const file = await writeText(
      dir,
      `bad-plan-${bodyCases.indexOf(c)}.json`,
      makeSnapshot([
        makeRecord(1, { target: '/api/items', plannedBody: '[{"id":1}]' }),
        makeRecord(2, { target: '/api/items', plannedBody: c.plannedBody }),
      ]),
    );
    const result = await runReplay(file, port, 5_000, strategyFile);
    assert.equal(result.code, 2, `用例「${c.name}」应退出 2`);
    assert.equal(result.stdout, '', `用例「${c.name}」stdout 必须为空`);
    assert.ok(result.stderr.includes(file), `用例「${c.name}」stderr 应指明快照文件`);
    assert.match(result.stderr, /records\[1\]\.plannedResponse\.body/, `用例「${c.name}」应定位记录`);
    assert.match(result.stderr, c.expect, `用例「${c.name}」应说明原因：${result.stderr}`);
  }
  assert.equal(hits, 0, '计划末条非法时不得发出任何请求');
});

test('实际响应对齐非法记 different（位置+原因、回退下标比较）并继续后续记录', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    // 实际侧键重复：对齐非法，回退下标比较（下标 1 处亦不同）
    'GET /api/dup': { status: 200, body: '[{"id":1,"v":"a"},{"id":1,"v":"b"}]' },
    // 实际侧元素不是对象
    'GET /api/nonobj': { status: 200, body: '[{"id":1},null]' },
    // 实际侧对齐位置不是数组
    'GET /api/notarray': { status: 200, body: '{"items":{"id":1}}' },
    // 后续记录照常重放且可对齐相同
    'GET /api/ok': { status: 200, body: '[{"id":2,"v":"b"},{"id":1,"v":"a"}]' },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/dup', plannedBody: '[{"id":1,"v":"a"},{"id":2,"v":"b"}]' }),
      makeRecord(2, { target: '/api/nonobj', plannedBody: '[{"id":1},{"id":2}]' }),
      makeRecord(3, { target: '/api/notarray', plannedBody: '{"items":[{"id":1}]}' }),
      makeRecord(4, { target: '/api/ok', plannedBody: '[{"id":1,"v":"a"},{"id":2,"v":"b"}]' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([
      { method: 'GET', path: '/api/dup', align: [{ pointer: '', key: 'id' }] },
      { method: 'GET', path: '/api/nonobj', align: [{ pointer: '', key: 'id' }] },
      { method: 'GET', path: '/api/notarray', align: [{ pointer: '/items', key: 'id' }] },
      { method: 'GET', path: '/api/ok', align: [{ pointer: '', key: 'id' }] },
    ]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1, '对齐非法是差异而非通信失败');
  const report = JSON.parse(result.stdout) as AlignReplayReport;
  assert.equal(report.total, 4);
  assert.equal(report.different, 3);
  assert.equal(report.failed, 0, '不算通信失败');
  assert.equal(report.same, 1, '非法记录之后继续后续记录');
  assert.deepEqual(target.hits, ['GET /api/dup', 'GET /api/nonobj', 'GET /api/notarray', 'GET /api/ok']);

  const dup = report.results[0];
  assert.equal(dup.outcome, 'different');
  assert.deepEqual(dup.differences, { status: false, body: true });
  assert.equal(dup.alignmentErrors?.length, 1);
  assert.equal(dup.alignmentErrors?.[0].pointer, '/1');
  assert.match(dup.alignmentErrors?.[0].reason ?? '', /重复/);
  // 该位置回退为按下标比较：下标 1 处的字段差异仍列出
  assert.deepEqual(dup.bodyDifferences, [
    { pointer: '/1/id', planned: 2, actual: 1 },
  ]);
  assert.equal(dup.alignedDifferences, undefined);

  const nonobj = report.results[1];
  assert.equal(nonobj.alignmentErrors?.length, 1);
  assert.equal(nonobj.alignmentErrors?.[0].pointer, '/1');
  assert.match(nonobj.alignmentErrors?.[0].reason ?? '', /必须是对象/);

  const notarray = report.results[2];
  assert.equal(notarray.alignmentErrors?.length, 1);
  assert.equal(notarray.alignmentErrors?.[0].pointer, '/items');
  assert.match(notarray.alignmentErrors?.[0].reason ?? '', /不是数组/);
  assert.deepEqual(notarray.bodyDifferences, [
    { pointer: '/items', planned: [{ id: 1 }], actual: { id: 1 } },
  ]);

  assert.equal(report.results[3].outcome, 'same', '后续记录照常对齐比较');
});

test('对齐位置在两侧都不存在允许；未选中接口仍按字节比较', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const target = await startTarget(t, {
    // 两侧都没有 /items：位置不存在允许
    'GET /api/none': { status: 200, body: '{"other":2}' },
    // 未选中接口：仅排版不同即字节差异
    'GET /api/plain': { status: 200, body: '[ { "id": 1 } ]' },
  });
  const snapshotFile = await writeText(
    dir,
    'snapshot.json',
    makeSnapshot([
      makeRecord(1, { target: '/api/none', plannedBody: '{"other":2}' }),
      makeRecord(2, { target: '/api/plain', plannedBody: '[{"id":1}]' }),
    ]),
  );
  const strategyFile = await writeText(
    dir,
    'strategy.json',
    makeStrategy([{ method: 'GET', path: '/api/none', align: [{ pointer: '/items', key: 'id' }] }]),
  );

  const result = await runReplay(snapshotFile, target.port, 10_000, strategyFile);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReplayReport;
  assert.equal(report.same, 1, '两侧都不存在对齐位置时不产生差异');
  assert.equal(report.different, 1, '未选中接口仍按字节比较');
  assert.equal(report.results[0].outcome, 'same');
  assert.equal(report.results[1].outcome, 'different');
  assert.equal(report.results[1].alignedDifferences, undefined);
});

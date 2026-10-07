// replay 可选业务键数组对齐（--strategy 的 keyedArrays）真实本机回归
//
// 覆盖：
// - 重排后同键元素字段变化：内部差异取“实际”位置，单侧元素取“存在侧”位置；
// - 增删键：只在一侧出现的整元素携带业务键与双方独立存在性标记，
//   缺失不与 null 或字符串 "missing" 混淆；
// - 忽略与对齐的交互：忽略以计划下标跟随重排后的配对元素（含元素内子路径、
//   缺失元素）；新增键不被其他下标的忽略项遮蔽；忽略整数组/祖先整体不启用
//   对齐且不校验实际侧；忽略不豁免计划侧键完整性与唯一性；下标忽略不豁免
//   实际侧整组校验；
// - 混合键类型、严格按类型、0 与 -0 配对；
// - 特殊字段：空字段名 / __proto__ 作键、~0/~1 转义定位、根数组对齐；
// - 多个互不嵌套的对齐位置并存；其他数组仍按下标；对齐位置不存在允许；
// - 实际侧对齐数组类型/元素/键非法记 different（附位置与原因）并继续后续记录；
// - 实际侧对齐位置整体缺失按普通节点差异；
// - 计划侧对齐数组非法（含末条记录）退出 2、stderr 定位记录与正文位置、
//   stdout 为空且零请求；
// - 策略 keyedArrays 自身非法退出 2 并定位；
// - 不配置 keyedArrays 时 JSON 比较行为不变；正文无损表示不被改写或排序。

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
  const target = patch?.target ?? '/api/x';
  return {
    id,
    receivedAt: '2026-10-08T00:00:00.000Z',
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
      body: patch?.plannedBody ?? '{"ok":true}',
    },
    delivery: 'sent',
  };
}

function makeSnapshot(records: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ note: 'replay-align 测试快照', count: records.length, records });
}

interface KeyedArray {
  readonly pointer: string;
  readonly key: string;
}

function makeStrategy(
  endpoints: readonly {
    readonly method: string;
    readonly path: string;
    readonly ignore?: readonly string[];
    readonly keyedArrays?: readonly KeyedArray[];
  }[],
): string {
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

async function startTarget(
  t: TestContext,
  routes: Readonly<Record<string, Route>>,
): Promise<Target> {
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
// 报告类型与调用
// ---------------------------------------------------------------------------

interface AlignDiff {
  readonly pointer: string;
  readonly planned: unknown;
  readonly actual: unknown;
  readonly key?: { readonly field: string; readonly value: unknown };
  readonly plannedExists?: boolean;
  readonly actualExists?: boolean;
}

interface AlignError {
  readonly pointer: string;
  readonly reason: string;
}

interface AlignReport {
  readonly total: number;
  readonly same: number;
  readonly different: number;
  readonly failed: number;
  readonly results: readonly {
    readonly id: number;
    readonly outcome: string;
    readonly differences?: { status: boolean; body: boolean };
    readonly bodyDifferences?: readonly AlignDiff[];
    readonly bodyAlignmentErrors?: readonly AlignError[];
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

async function writeFixture(
  t: TestContext,
  records: readonly Record<string, unknown>[],
  endpoints: readonly {
    readonly method: string;
    readonly path: string;
    readonly ignore?: readonly string[];
    readonly keyedArrays?: readonly KeyedArray[];
  }[],
): Promise<{ readonly dir: string; readonly snapshot: string; readonly strategy: string }> {
  const dir = await makeTempDir(t);
  const snapshot = await writeText(dir, 'snapshot.json', makeSnapshot(records));
  const strategy = await writeText(dir, 'strategy.json', makeStrategy(endpoints));
  return { dir, snapshot, strategy };
}

// ---------------------------------------------------------------------------
// 1) 重排后字段变化：内部差异取实际位置
// ---------------------------------------------------------------------------

test('重排后同键元素字段变化：内部差异取实际元素在原始正文中的位置', {
  timeout: 60_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const plannedBody = JSON.stringify({ list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] });
  // b 由计划下标 1 重排到实际下标 0，且 v 变化
  const actualBody = JSON.stringify({ list: [{ id: 'b', v: 20 }, { id: 'a', v: 1 }] });
  const target = await startTarget(t, { 'GET /api/x': { status: 200, body: actualBody } });
  const { snapshot, strategy } = await writeFixture(
    t,
    [makeRecord(1, { plannedBody })],
    [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 'id' }] }],
  );

  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.equal(report.different, 1);
  assert.deepEqual(report.results[0].bodyDifferences, [
    { pointer: '/list/0/v', planned: 2, actual: 20 }, // 实际位置，不是计划位置 /list/1/v
  ]);
  assert.equal(report.results[0].bodyAlignmentErrors, undefined);
  // 正文无损表示不被改写或排序
  assert.equal(report.results[0].planned?.body.content, plannedBody);
  assert.equal(report.results[0].response?.body.content, actualBody);
});

test('纯重排无字段变化：顺序不影响结论，判 same', { timeout: 60_000 }, async (t) => {
  const target = await startTarget(t, {
    'GET /api/x': {
      status: 200,
      body: JSON.stringify({ list: [{ id: 'b', v: 2 }, { id: 'a', v: 1 }, { id: 'c', v: 3 }] }),
    },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [
      makeRecord(1, {
        plannedBody: JSON.stringify({ list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }] }),
      }),
    ],
    [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 'id' }] }],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.equal(report.same, 1);
});

// ---------------------------------------------------------------------------
// 2) 增删键：整元素、业务键、存在侧位置、双方独立存在性标记
// ---------------------------------------------------------------------------

test('增删键：整元素差异携带业务键与双方存在性标记，位置取存在侧', {
  timeout: 60_000,
}, async (t) => {
  const plannedBody = JSON.stringify({
    list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }],
  });
  // 删除 c，新增 x；a/b 重排
  const actualBody = JSON.stringify({
    list: [{ id: 'x', v: 9 }, { id: 'b', v: 2 }, { id: 'a', v: 1 }],
  });
  const target = await startTarget(t, { 'GET /api/x': { status: 200, body: actualBody } });
  const { snapshot, strategy } = await writeFixture(
    t,
    [makeRecord(1, { plannedBody })],
    [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 'id' }] }],
  );

  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  const diffs = report.results[0].bodyDifferences ?? [];
  // 计划遍历先报删除（c 在计划下标 2），再报实际独有（x 在实际下标 0）
  assert.deepEqual(diffs, [
    {
      pointer: '/list/2',
      planned: { id: 'c', v: 3 },
      actual: 'missing',
      key: { field: 'id', value: 'c' },
      plannedExists: true,
      actualExists: false,
    },
    {
      pointer: '/list/0',
      planned: 'missing',
      actual: { id: 'x', v: 9 },
      key: { field: 'id', value: 'x' },
      plannedExists: false,
      actualExists: true,
    },
  ]);
  // 缺失侧写字符串 "missing"，但以存在性布尔为准；单侧元素不深入
  for (const d of diffs) {
    assert.equal(typeof d.key?.value, 'string');
    assert.notEqual(d.planned, null);
    assert.notEqual(d.actual, null);
  }
});

test('配对元素内部：显式 null 与字段缺失仍是两条不同语义', { timeout: 60_000 }, async (t) => {
  const target = await startTarget(t, {
    'GET /api/x': {
      status: 200,
      body: JSON.stringify({ list: [{ id: 'a' }] }), // note 缺失
    },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [makeRecord(1, { plannedBody: JSON.stringify({ list: [{ id: 'a', note: null }] }) })],
    [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 'id' }] }],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.deepEqual(report.results[0].bodyDifferences, [
    { pointer: '/list/0/note', planned: null, actual: 'missing' },
  ]);
});

// ---------------------------------------------------------------------------
// 3) 忽略与对齐的交互
// ---------------------------------------------------------------------------

test('忽略以计划下标跟随重排后的配对元素（元素整体与元素内子路径）', {
  timeout: 60_000,
}, async (t) => {
  // 计划下标 1 是 b；实际 b 重排到下标 0 且 v 变化——忽略 /list/1/v 仍作用于 b
  const plannedBody = JSON.stringify({ list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] });
  const target = await startTarget(t, {
    'GET /api/child': {
      status: 200,
      body: JSON.stringify({ list: [{ id: 'b', v: 99 }, { id: 'a', v: 1 }] }),
    },
    // 忽略整个配对元素 /list/1（计划 b）：b 重排到下标 0 且 v 变化也被忽略
    'GET /api/whole': {
      status: 200,
      body: JSON.stringify({ list: [{ id: 'b', v: 99 }, { id: 'a', v: 1 }] }),
    },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [
      makeRecord(1, { target: '/api/child', plannedBody }),
      makeRecord(2, { target: '/api/whole', plannedBody }),
    ],
    [
      { method: 'GET', path: '/api/child', ignore: ['/list/1/v'], keyedArrays: [{ pointer: '/list', key: 'id' }] },
      { method: 'GET', path: '/api/whole', ignore: ['/list/1'], keyedArrays: [{ pointer: '/list', key: 'id' }] },
    ],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.equal(report.same, 2);
  assert.equal(target.hits.length, 2);
});

test('计划下标的忽略项可抑制缺失元素；新增键不被其他下标的忽略项遮蔽', {
  timeout: 60_000,
}, async (t) => {
  // 删除计划下标 1 的 b：/list/1 忽略作用于缺失的配对元素 => 不报
  const plannedDel = JSON.stringify({ list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] });
  const target = await startTarget(t, {
    'GET /api/del': { status: 200, body: JSON.stringify({ list: [{ id: 'a', v: 1 }] }) },
    // 忽略计划下标 1（b），但实际下标 1 出现的是新键 c：必须报告
    'GET /api/new': {
      status: 200,
      body: JSON.stringify({ list: [{ id: 'b', v: 99 }, { id: 'c', v: 7 }, { id: 'a', v: 1 }] }),
    },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [
      makeRecord(1, { target: '/api/del', plannedBody: plannedDel }),
      makeRecord(2, { target: '/api/new', plannedBody: plannedDel }),
    ],
    [
      { method: 'GET', path: '/api/del', ignore: ['/list/1'], keyedArrays: [{ pointer: '/list', key: 'id' }] },
      { method: 'GET', path: '/api/new', ignore: ['/list/1'], keyedArrays: [{ pointer: '/list', key: 'id' }] },
    ],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.equal(report.results[0].outcome, 'same', '缺失元素被其计划下标处的忽略项抑制');
  assert.equal(report.results[1].outcome, 'different');
  // b 配对（计划下标 1）整体被忽略；新键 c 在实际下标 1 不被遮蔽
  assert.deepEqual(report.results[1].bodyDifferences, [
    {
      pointer: '/list/1',
      planned: 'missing',
      actual: { id: 'c', v: 7 },
      key: { field: 'id', value: 'c' },
      plannedExists: false,
      actualExists: true,
    },
  ]);
});

test('忽略整数组或祖先：整体不启用对齐、不校验实际侧，判 same', { timeout: 60_000 }, async (t) => {
  // 计划侧键合法；实际侧对齐数组元素非法，但整数组/祖先被忽略 => 不报对齐错误
  const plannedList = JSON.stringify({ root: { list: [{ id: 'a' }] } });
  const target = await startTarget(t, {
    'GET /api/whole': { status: 200, body: JSON.stringify({ list: [5, 6] }) },
    'GET /api/ancestor': { status: 200, body: JSON.stringify({ root: { list: [5, 6] } }) },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [
      makeRecord(1, { target: '/api/whole', plannedBody: JSON.stringify({ list: [{ id: 'a' }] }) }),
      makeRecord(2, { target: '/api/ancestor', plannedBody: plannedList }),
    ],
    [
      { method: 'GET', path: '/api/whole', ignore: ['/list'], keyedArrays: [{ pointer: '/list', key: 'id' }] },
      { method: 'GET', path: '/api/ancestor', ignore: ['/root'], keyedArrays: [{ pointer: '/root/list', key: 'id' }] },
    ],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.equal(report.same, 2);
});

test('下标级忽略不豁免实际侧整组校验：实际对齐位置不是数组仍记差异', {
  timeout: 60_000,
}, async (t) => {
  const target = await startTarget(t, {
    'GET /api/x': { status: 200, body: JSON.stringify({ list: 5 }) },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [makeRecord(1, { plannedBody: JSON.stringify({ list: [{ id: 'a' }] }) })],
    [
      {
        method: 'GET',
        path: '/api/x',
        ignore: ['/list/0'],
        keyedArrays: [{ pointer: '/list', key: 'id' }],
      },
    ],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.equal(report.results[0].outcome, 'different');
  assert.deepEqual(report.results[0].differences, { status: false, body: true });
  const errs = report.results[0].bodyAlignmentErrors ?? [];
  assert.equal(errs.length, 1);
  assert.equal(errs[0].pointer, '/list');
  assert.match(errs[0].reason, /不是数组/);
  // 下标级忽略存在时仍进行整组类型校验
  assert.equal(report.results[0].bodyDifferences, undefined);
});

test('忽略不豁免计划侧键完整性/唯一性：整数组被忽略但计划键重复仍退出 2、零请求', {
  timeout: 60_000,
}, async (t) => {
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

  const dir = await makeTempDir(t);
  // /list 被整体忽略，但计划正文里同数组键重复：连接前校验仍失败
  const badPlan = JSON.stringify({ list: [{ id: 'dup' }, { id: 'dup' }] });
  const snapshot = await writeText(dir, 'snapshot.json', makeSnapshot([makeRecord(1, { plannedBody: badPlan })]));
  const strategy = await writeText(
    dir,
    'strategy.json',
    makeStrategy([
      { method: 'GET', path: '/api/x', ignore: ['/list'], keyedArrays: [{ pointer: '/list', key: 'id' }] },
    ]),
  );
  const result = await runReplay(snapshot, port, 5_000, strategy);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /records\[0\]\.plannedResponse\.body/);
  assert.match(result.stderr, /"\/list"/);
  assert.match(result.stderr, /唯一|非法/);
  assert.equal(hits, 0, '计划侧非法时不得发出任何请求');
});

// ---------------------------------------------------------------------------
// 4) 混合键类型、严格按类型、0 与 -0
// ---------------------------------------------------------------------------

test('混合键类型严格配对：字符串"1"≠数字1，布尔≠字符串，0 与 -0 配对', {
  timeout: 60_000,
}, async (t) => {
  const plannedBody = JSON.stringify({
    list: [{ k: '1', v: 's' }, { k: 1, v: 'n' }, { k: true, v: 'b' }, { k: 0, v: 'z' }],
  });
  // 重排；缺数字 1（字符串 "1" 仍在，不得顶配）；-0 与 0 配对且 v 相同
  const actualBody = JSON.stringify({
    list: [{ k: -0, v: 'z' }, { k: '1', v: 's' }, { k: true, v: 'b' }],
  });
  const target = await startTarget(t, { 'GET /api/x': { status: 200, body: actualBody } });
  const { snapshot, strategy } = await writeFixture(
    t,
    [makeRecord(1, { plannedBody })],
    [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 'k' }] }],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  // 仅数字 1 这一元素缺失（计划下标 1）；字符串 "1" 与布尔 true 各自配对
  assert.deepEqual(report.results[0].bodyDifferences, [
    {
      pointer: '/list/1',
      planned: { k: 1, v: 'n' },
      actual: 'missing',
      key: { field: 'k', value: 1 },
      plannedExists: true,
      actualExists: false,
    },
  ]);
});

test('0 与 -0 同键：元素内容一致判 same', { timeout: 60_000 }, async (t) => {
  const target = await startTarget(t, {
    'GET /api/x': { status: 200, body: JSON.stringify({ list: [{ k: -0, v: 7 }] }) },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [makeRecord(1, { plannedBody: JSON.stringify({ list: [{ k: 0, v: 7 }] }) })],
    [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 'k' }] }],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.equal(report.same, 1);
});

// ---------------------------------------------------------------------------
// 5) 特殊字段名、转义指针、根数组对齐
// ---------------------------------------------------------------------------

test('空字段名与 __proto__ 作业务键、~0/~1 转义定位对齐数组', { timeout: 60_000 }, async (t) => {
  const target = await startTarget(t, {
    // 键为空字段名 ""，重排后字段变化
    'GET /api/empty': {
      status: 200,
      body: JSON.stringify({ list: [{ '': 'y', v: 20 }, { '': 'x', v: 1 }] }),
    },
    // 键为 __proto__（对象字面量的 __proto__ 会被当作原型设置，故用原始 JSON 文本）
    'GET /api/proto': {
      status: 200,
      body: '{"list":[{"__proto__":"p","v":20}]}',
    },
    // 对齐数组位于含 / 与 ~ 的字段名下
    'GET /api/esc': {
      status: 200,
      body: JSON.stringify({ 'a/b': { 'm~n': { list: [{ id: 'b' }, { id: 'a' }] } } }),
    },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [
      makeRecord(1, {
        target: '/api/empty',
        plannedBody: JSON.stringify({ list: [{ '': 'x', v: 1 }, { '': 'y', v: 2 }] }),
      }),
      makeRecord(2, {
        target: '/api/proto',
        plannedBody: '{"list":[{"__proto__":"p","v":2}]}',
      }),
      makeRecord(3, {
        target: '/api/esc',
        plannedBody: JSON.stringify({ 'a/b': { 'm~n': { list: [{ id: 'a' }, { id: 'b' }] } } }),
      }),
    ],
    [
      { method: 'GET', path: '/api/empty', keyedArrays: [{ pointer: '/list', key: '' }] },
      { method: 'GET', path: '/api/proto', keyedArrays: [{ pointer: '/list', key: '__proto__' }] },
      { method: 'GET', path: '/api/esc', keyedArrays: [{ pointer: '/a~1b/m~0n/list', key: 'id' }] },
    ],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.equal(report.results[0].outcome, 'different');
  assert.deepEqual(report.results[0].bodyDifferences, [{ pointer: '/list/0/v', planned: 2, actual: 20 }]);
  assert.equal(report.results[1].outcome, 'different');
  assert.deepEqual(report.results[1].bodyDifferences, [{ pointer: '/list/0/v', planned: 2, actual: 20 }]);
  // 转义路径上的纯重排判 same
  assert.equal(report.results[2].outcome, 'same');
});

test('根数组对齐（pointer 为 ""）：重排后差异位置从下标开始', { timeout: 60_000 }, async (t) => {
  const target = await startTarget(t, {
    'GET /api/x': { status: 200, body: JSON.stringify([{ id: 'b', v: 20 }, { id: 'a', v: 1 }]) },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [makeRecord(1, { plannedBody: JSON.stringify([{ id: 'a', v: 1 }, { id: 'b', v: 2 }]) })],
    [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '', key: 'id' }] }],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.deepEqual(report.results[0].bodyDifferences, [
    { pointer: '/0/v', planned: 2, actual: 20 },
  ]);
});

// ---------------------------------------------------------------------------
// 6) 多个互不嵌套对齐位置；其他数组仍按下标；对齐位置不存在允许
// ---------------------------------------------------------------------------

test('多个互不嵌套的对齐位置分别配对；同文档内其他数组仍按下标；位置不存在允许', {
  timeout: 60_000,
}, async (t) => {
  const plannedBody = JSON.stringify({
    a: { items: [{ id: 'a1' }, { id: 'a2' }] },
    b: { items: [{ id: 'b1' }] },
    tail: [1, 2, 3], // 非对齐数组：按下标
  });
  const actualBody = JSON.stringify({
    a: { items: [{ id: 'a2' }, { id: 'a1' }] }, // 纯重排
    b: { items: [{ id: 'b1' }] },
    tail: [1, 9, 3], // 下标 1 变化
  });
  const target = await startTarget(t, { 'GET /api/x': { status: 200, body: actualBody } });
  const { snapshot, strategy } = await writeFixture(
    t,
    [makeRecord(1, { plannedBody })],
    [
      {
        method: 'GET',
        path: '/api/x',
        keyedArrays: [
          { pointer: '/a/items', key: 'id' },
          { pointer: '/b/items', key: 'id' },
          { pointer: '/nope', key: 'id' }, // 两侧都不存在：允许、无影响
        ],
      },
    ],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.deepEqual(report.results[0].bodyDifferences, [
    { pointer: '/tail/1', planned: 2, actual: 9 },
  ]);
});

// ---------------------------------------------------------------------------
// 7) 实际侧非法对齐数组：记 different 附位置原因并继续后续记录
// ---------------------------------------------------------------------------

test('实际侧对齐数组元素/键非法或重复：different + bodyAlignmentErrors，并继续后续记录', {
  timeout: 60_000,
}, async (t) => {
  const validPlan = JSON.stringify({ list: [{ id: 'a' }, { id: 'b' }] });
  const invalidCases: { name: string; actual: unknown; expect: RegExp }[] = [
    { name: '对齐位置不是数组', actual: { list: 5 }, expect: /不是数组/ },
    { name: '元素不是对象', actual: { list: [{ id: 'a' }, 5] }, expect: /下标 1.*不是 JSON 对象/ },
    { name: '元素缺少键字段', actual: { list: [{ id: 'a' }, { v: 1 }] }, expect: /下标 1.*缺少业务键字段 "id"/ },
    { name: '键为 null', actual: { list: [{ id: null }] }, expect: /下标 0.*null 不能作业务键/ },
    { name: '键为对象', actual: { list: [{ id: {} }] }, expect: /下标 0.*必须是字符串、有限数字或布尔/ },
    { name: '键重复', actual: { list: [{ id: 'a' }, { id: 'a' }] }, expect: /下标 1.*重复/ },
  ];
  const routes: Record<string, Route> = {
    // 最后一条合法记录：证明非法后继续重放
    'GET /api/ok': { status: 200, body: validPlan },
  };
  for (const [i, c] of invalidCases.entries()) {
    routes[`GET /api/bad${i}`] = { status: 200, body: JSON.stringify(c.actual) };
  }
  const target = await startTarget(t, routes);
  const records = [
    ...invalidCases.map((c, i) => makeRecord(i + 1, { target: `/api/bad${i}`, plannedBody: validPlan })),
    makeRecord(invalidCases.length + 1, { target: '/api/ok', plannedBody: validPlan }),
  ];
  // 为所有路由生成同一策略（每个接口独立列一条）
  const dir = await makeTempDir(t);
  const snapshot = await writeText(dir, 'snapshot.json', makeSnapshot(records));
  const allEndpoints = [
    ...invalidCases.map((_, i) => ({
      method: 'GET',
      path: `/api/bad${i}`,
      keyedArrays: [{ pointer: '/list', key: 'id' }] as KeyedArray[],
    })),
    { method: 'GET', path: '/api/ok', keyedArrays: [{ pointer: '/list', key: 'id' }] as KeyedArray[] },
  ];
  const fullStrategy = await writeText(dir, 'strategy-full.json', makeStrategy(allEndpoints));

  const result = await runReplay(snapshot, target.port, 10_000, fullStrategy);
  assert.equal(result.code, 1, '存在差异应退出 1（不是通信失败）');
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.equal(report.failed, 0);
  assert.equal(report.total, invalidCases.length + 1);
  assert.equal(report.same, 1, '最后一条合法记录判 same，说明非法后继续后续记录');
  assert.equal(target.hits.length, invalidCases.length + 1, '每条记录都应发出请求');
  invalidCases.forEach((c, i) => {
    const entry = report.results[i];
    assert.equal(entry.outcome, 'different', `用例「${c.name}」应判 different`);
    assert.equal(entry.differences?.body, true, `用例「${c.name}」应标记正文差异`);
    const errs = entry.bodyAlignmentErrors ?? [];
    assert.equal(errs.length, 1, `用例「${c.name}」应有一条对齐错误`);
    assert.equal(errs[0].pointer, '/list', `用例「${c.name}」应定位到 /list`);
    assert.match(errs[0].reason, c.expect, `用例「${c.name}」原因不符：${errs[0].reason}`);
  });
});

test('实际侧对齐位置整体缺失：按普通节点差异处理，不记对齐错误', { timeout: 60_000 }, async (t) => {
  const target = await startTarget(t, {
    'GET /api/x': { status: 200, body: '{}' },
  });
  const plannedArray = [{ id: 'a' }];
  const { snapshot, strategy } = await writeFixture(
    t,
    [makeRecord(1, { plannedBody: JSON.stringify({ list: plannedArray }) })],
    [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 'id' }] }],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  assert.equal(report.results[0].bodyAlignmentErrors, undefined);
  assert.deepEqual(report.results[0].bodyDifferences, [
    { pointer: '/list', planned: plannedArray, actual: 'missing' },
  ]);
});

// ---------------------------------------------------------------------------
// 8) 计划侧非法：末条非法时零请求
// ---------------------------------------------------------------------------

test('计划侧对齐数组非法（含末条记录）：退出 2、定位记录与正文位置、stdout 空、零请求', {
  timeout: 60_000,
}, async (t) => {
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

  const dir = await makeTempDir(t);
  const strategy = await writeText(
    dir,
    'strategy.json',
    makeStrategy([{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 'id' }] }]),
  );

  const cases: { name: string; body: unknown; expect: RegExp }[] = [
    { name: '对齐位置不是数组', body: { list: 5 }, expect: /必须是数组/ },
    { name: '元素不是对象', body: { list: [5] }, expect: /下标 0/ },
    { name: '缺键字段', body: { list: [{ v: 1 }] }, expect: /下标 0.*缺少业务键字段 "id"/ },
    { name: '键为 null', body: { list: [{ id: null }] }, expect: /下标 0.*null/ },
    { name: '键为布尔外类型（对象）', body: { list: [{ id: {} }] }, expect: /下标 0/ },
    { name: '键重复', body: { list: [{ id: 'a' }, { id: 'a' }] }, expect: /下标 1.*唯一/ },
  ];
  for (const [i, c] of cases.entries()) {
    // 每条快照放 3 条记录，非法项在末条
    const records = [
      makeRecord(1, { target: '/api/x', plannedBody: JSON.stringify({ list: [{ id: 'ok1' }] }) }),
      makeRecord(2, { target: '/api/x', plannedBody: JSON.stringify({ list: [{ id: 'ok2' }] }) }),
      makeRecord(3, { target: '/api/x', plannedBody: JSON.stringify(c.body) }),
    ];
    const file = await writeText(dir, `bad-plan-${i}.json`, makeSnapshot(records));
    const result = await runReplay(file, port, 5_000, strategy);
    assert.equal(result.code, 2, `用例「${c.name}」应退出 2`);
    assert.equal(result.stdout, '', `用例「${c.name}」stdout 必须为空`);
    assert.ok(result.stderr.includes(file), `用例「${c.name}」stderr 应指明快照文件`);
    assert.match(result.stderr, /records\[2\]\.plannedResponse\.body/, `用例「${c.name}」应定位到末条记录`);
    assert.match(result.stderr, /位置 ".*"/, `用例「${c.name}」应给出正文位置`);
    assert.match(result.stderr, c.expect, `用例「${c.name}」应说明原因：${result.stderr}`);
  }
  assert.equal(hits, 0, '任何计划侧非法都不得发出请求（包括前两条合法记录）');
});

test('计划正文位置不存在时对齐不启用：合法，正常重放', { timeout: 60_000 }, async (t) => {
  const target = await startTarget(t, {
    'GET /api/x': { status: 200, body: JSON.stringify({ other: [{ a: 1 }] }) },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [makeRecord(1, { plannedBody: JSON.stringify({ other: [{ a: 1 }] }) })],
    [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 'id' }] }],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 0, result.stderr);
});

// ---------------------------------------------------------------------------
// 9) 策略 keyedArrays 自身非法：退出 2 并定位、stdout 空、零请求
// ---------------------------------------------------------------------------

test('策略 keyedArrays 非法：退出 2、stderr 定位、stdout 为空、零请求', {
  timeout: 60_000,
}, async (t) => {
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

  const dir = await makeTempDir(t);
  const okSnapshot = await writeText(
    dir,
    'ok.json',
    makeSnapshot([makeRecord(1, { plannedBody: JSON.stringify({ list: [{ id: 'a' }] }) })]),
  );

  // 直接拼策略 JSON 以容纳非法值
  const cases: { name: string; json: string; expect: RegExp }[] = [
    {
      name: 'keyedArrays 非数组',
      json: JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/x', keyedArrays: {} }] }),
      expect: /endpoints\[0\]\.keyedArrays 必须是数组/,
    },
    {
      name: '数组项非对象',
      json: JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/x', keyedArrays: [5] }] }),
      expect: /endpoints\[0\]\.keyedArrays\[0\] 必须是对象/,
    },
    {
      name: '数组项未知字段',
      json: JSON.stringify({
        endpoints: [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 'id', extra: 1 }] }],
      }),
      expect: /endpoints\[0\]\.keyedArrays\[0\].*未知字段 "extra"/,
    },
    {
      name: 'pointer 非字符串',
      json: JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: 1, key: 'id' }] }] }),
      expect: /endpoints\[0\]\.keyedArrays\[0\].*指针字符串/,
    },
    {
      name: 'pointer 非法转义',
      json: JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/a~2', key: 'id' }] }] }),
      expect: /endpoints\[0\]\.keyedArrays\[0\].*非法转义/,
    },
    {
      name: 'key 非字符串',
      json: JSON.stringify({ endpoints: [{ method: 'GET', path: '/api/x', keyedArrays: [{ pointer: '/list', key: 7 }] }] }),
      expect: /endpoints\[0\]\.keyedArrays\[0\]\.key/,
    },
    {
      name: '重复位置',
      json: JSON.stringify({
        endpoints: [
          {
            method: 'GET',
            path: '/api/x',
            keyedArrays: [
              { pointer: '/list', key: 'id' },
              { pointer: '/list', key: 'code' },
            ],
          },
        ],
      }),
      expect: /keyedArrays\[1\].*(重复|嵌套)/,
    },
    {
      name: '祖先/后代位置嵌套',
      json: JSON.stringify({
        endpoints: [
          {
            method: 'GET',
            path: '/api/x',
            keyedArrays: [
              { pointer: '/a', key: 'id' },
              { pointer: '/a/b', key: 'id' },
            ],
          },
        ],
      }),
      expect: /keyedArrays\[1\].*(重复|嵌套)/,
    },
    {
      name: '后代/祖先顺序嵌套',
      json: JSON.stringify({
        endpoints: [
          {
            method: 'GET',
            path: '/api/x',
            keyedArrays: [
              { pointer: '/a/b', key: 'id' },
              { pointer: '/a', key: 'id' },
            ],
          },
        ],
      }),
      expect: /keyedArrays\[1\].*(重复|嵌套)/,
    },
    {
      name: '根位置与其他位置嵌套',
      json: JSON.stringify({
        endpoints: [
          {
            method: 'GET',
            path: '/api/x',
            keyedArrays: [
              { pointer: '', key: 'id' },
              { pointer: '/a', key: 'id' },
            ],
          },
        ],
      }),
      expect: /keyedArrays\[1\].*(重复|嵌套)/,
    },
  ];
  for (const [i, c] of cases.entries()) {
    const file = await writeText(dir, `bad-strategy-${i}.json`, c.json);
    const result = await runReplay(okSnapshot, port, 5_000, file);
    assert.equal(result.code, 2, `用例「${c.name}」应退出 2`);
    assert.equal(result.stdout, '', `用例「${c.name}」stdout 必须为空`);
    assert.ok(result.stderr.includes(file), `用例「${c.name}」stderr 应指明策略文件`);
    assert.match(result.stderr, c.expect, `用例「${c.name}」stderr 应定位：${result.stderr}`);
  }
  assert.equal(hits, 0, '策略非法时不得发出任何请求');
});

// ---------------------------------------------------------------------------
// 10) 不配置 keyedArrays 时行为不变（重排按下标 => 差异）
// ---------------------------------------------------------------------------

test('策略不配置 keyedArrays：数组仍按下标比较（重排即按下标出字段差异）', {
  timeout: 60_000,
}, async (t) => {
  const target = await startTarget(t, {
    'GET /api/x': {
      status: 200,
      body: JSON.stringify({ list: [{ id: 'b', v: 2 }, { id: 'a', v: 1 }] }),
    },
  });
  const { snapshot, strategy } = await writeFixture(
    t,
    [
      makeRecord(1, {
        plannedBody: JSON.stringify({ list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] }),
      }),
    ],
    [{ method: 'GET', path: '/api/x' }],
  );
  const result = await runReplay(snapshot, target.port, 10_000, strategy);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as AlignReport;
  // 无对齐：下标 0 是 a 对 b、下标 1 是 b 对 a，递归到各自字段（原 JSON 比较行为）
  assert.deepEqual(report.results[0].bodyDifferences, [
    { pointer: '/list/0/id', planned: 'a', actual: 'b' },
    { pointer: '/list/0/v', planned: 1, actual: 2 },
    { pointer: '/list/1/id', planned: 'b', actual: 'a' },
    { pointer: '/list/1/v', planned: 2, actual: 1 },
  ]);
  assert.equal(report.results[0].bodyAlignmentErrors, undefined);
});

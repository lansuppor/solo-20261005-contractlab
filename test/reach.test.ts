// 离线响应分支可达性诊断（reach）回归测试
//
// 覆盖（全部为真实场景文件 + `node app.ts reach` 子进程）：
// - 三种结论 reachable / covered / contradictory 与配置顺序；
// - 共同遮挡：两支匹配枚举 a/b，后一支仅匹配 flag==true，被前两支的“并集”
//   共同遮挡（coveredBy 同时列出两支），不是单支包含也不是抽样；
// - 枚举剩余值让兜底可达；可选字段缺失与显式 null 分开；样例补全全部必填字段；
// - 可空：根可空时 JSON null 落兜底；可空字段上 null 条件可达；不可空字段上
//   null 条件矛盾；
// - 特殊字段名：空字段名（/）、__proto__、含 / 与 ~ 字段的 ~0/~1 指针；
// - 0 与 -0 等价（两支分别钉 0/-0，后一支被前一支遮挡）；
// - 类型不符、枚举越界、同一指针互异常量判 contradictory；
// - 每个可达分支与可达兜底的样例都原样发送到真实本机 serve，并经请求记录核对
//   实际选中的就是所报分支或兜底（正文检查通过、branchSelection 一致）；
// - 范围与输入错误退出 2、stderr 定位、stdout 空；全部可达退出 0、有不可达 1，
//   兜底不可达不改变退出码。

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  makeTempDir,
  runCli,
  sendRequest,
  startServer,
  writeConfig,
  writeText,
  type RawRequest,
  type RunningServer,
} from './helpers.ts';

function resp(body: string, status = 200): unknown {
  return { status, headers: {}, body, delay: 0 };
}

interface ReachReport {
  readonly configFile: string;
  readonly method: string;
  readonly path: string;
  readonly branches: ReadonlyArray<{
    readonly id: string;
    readonly status: 'reachable' | 'covered' | 'contradictory';
    readonly example?: RawRequest;
    readonly coveredBy?: readonly string[];
    readonly reasons?: ReadonlyArray<{ readonly pointer: string; readonly message: string }>;
  }>;
  readonly fallback: {
    readonly status: 'reachable' | 'covered';
    readonly example?: RawRequest;
    readonly coveredBy?: readonly string[];
  };
  readonly unreachableBranches: number;
}

async function runReach(configFile: string, routePath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCli(['reach', '--config', configFile, '--path', routePath]);
}

function postJson(routePath: string, body: string): RawRequest {
  return { method: 'POST', path: routePath, headers: { 'Content-Type': 'application/json' }, body };
}

// 清空记录后发送一条请求，再取请求记录（管理查询本身不记录），
// 返回实际响应与该业务请求的记录字段。
async function probe(
  server: RunningServer,
  routePath: string,
  body: string,
): Promise<{
  status: number;
  respBody: string;
  selection: { kind: string; id?: string } | null;
  passed: boolean | null;
}> {
  await sendRequest(server.port, { method: 'POST', path: '/__contractlab/requests/clear', headers: {}, body: '' });
  const res = await sendRequest(server.port, postJson(routePath, body));
  const log = JSON.parse(
    (await sendRequest(server.port, { method: 'GET', path: '/__contractlab/requests', headers: {}, body: '' })).body,
  );
  assert.equal(log.records.length, 1, '清空后只有这一条业务请求记录');
  const rec = log.records[0];
  return {
    status: res.status,
    respBody: res.body,
    selection: rec.branchSelection,
    passed: rec.bodyValidationPassed,
  };
}

// 把报告里的一份可达样例发到真实服务：必须 2xx、正文检查通过、
// 且实际选中的分支/兜底与报告一致；返回实际响应以便进一步核对响应正文。
async function assertExampleSelects(
  server: RunningServer,
  example: RawRequest,
  expected: { kind: 'branch'; id: string } | { kind: 'fallback' },
): Promise<{ status: number; respBody: string }> {
  assert.deepEqual(example.headers, { 'Content-Type': 'application/json' }, '样例只带必要的 Content-Type 头');
  const r = await probe(server, example.path, example.body);
  assert.equal(r.passed, true, `样例必须通过正文检查：${example.body}`);
  assert.equal(r.status >= 200 && r.status < 300, true, `样例应得到场景成功响应，实际 ${r.status}：${r.respBody}`);
  if (expected.kind === 'branch') {
    assert.deepEqual(r.selection, { kind: 'branch', id: expected.id }, `样例 ${example.body} 应首先命中分支 ${expected.id}`);
  } else {
    assert.deepEqual(r.selection, { kind: 'fallback' }, `样例 ${example.body} 应命中兜底`);
  }
  return { status: r.status, respBody: r.respBody };
}

// ---------------------------------------------------------------------------
// 场景一：共同遮挡（题述原例的精确形态）+ 矛盾分支 + 兜底被全覆盖
// ---------------------------------------------------------------------------

function jointShadowConfig(): unknown {
  return {
    endpoints: [
      {
        method: 'POST',
        path: '/orders',
        requestBody: {
          type: 'object',
          fields: {
            state: { type: 'string', enum: ['a', 'b'], required: true },
            flag: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        responses: [resp('FB')],
        branches: [
          { id: 'is-a', when: { '/state': 'a' }, responses: [resp('BR-A')] },
          { id: 'is-b', when: { '/state': 'b' }, responses: [resp('BR-B')] },
          { id: 'flag-only', when: { '/flag': true }, responses: [resp('BR-FLAG')] },
          { id: 'impossible', when: { '/state': 'c' }, responses: [resp('BR-C')] },
        ],
      },
    ],
  };
}

test('共同遮挡：flag-only 被 is-a/is-b 两支并集共同遮挡；矛盾分支定位；样例真实命中', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', jointShadowConfig());
  const server = await startServer(file);
  t.after(server.close);

  const result = await runReach(file, '/orders');
  assert.equal(result.code, 1, '存在 covered/contradictory 分支，退出 1');
  const report = JSON.parse(result.stdout) as ReachReport;
  assert.equal(report.method, 'POST');
  assert.equal(report.path, '/orders');
  assert.equal(report.configFile, file);
  assert.equal(report.unreachableBranches, 2);

  const byId = new Map(report.branches.map((b) => [b.id, b]));
  assert.deepEqual(report.branches.map((b) => b.id), ['is-a', 'is-b', 'flag-only', 'impossible']);

  // is-a / is-b 可达，样例补全必填字段
  const a = byId.get('is-a') as ReachReport['branches'][number];
  assert.equal(a.status, 'reachable');
  assert.equal(a.example?.body, '{"state":"a"}');
  const aHit = await assertExampleSelects(server, a.example as RawRequest, { kind: 'branch', id: 'is-a' });
  assert.equal(aHit.respBody, 'BR-A');

  const b = byId.get('is-b') as ReachReport['branches'][number];
  assert.equal(b.status, 'reachable');
  const bHit = await assertExampleSelects(server, b.example as RawRequest, { kind: 'branch', id: 'is-b' });
  assert.equal(bHit.respBody, 'BR-B');

  // flag-only 被前两支“共同”遮挡：coveredBy 必须同时列出两支
  const flag = byId.get('flag-only') as ReachReport['branches'][number];
  assert.equal(flag.status, 'covered');
  assert.deepEqual(flag.coveredBy, ['is-a', 'is-b']);
  assert.equal('example' in flag, false, '不可达分支不给样例');

  // 真实核对遮挡：满足 flag-only 的两类合格正文分别先命中 is-a / is-b
  const hitA = await probe(server, '/orders', '{"state":"a","flag":true}');
  assert.deepEqual(hitA.selection, { kind: 'branch', id: 'is-a' });
  assert.equal(hitA.respBody, 'BR-A');
  const hitB = await probe(server, '/orders', '{"state":"b","flag":true}');
  assert.deepEqual(hitB.selection, { kind: 'branch', id: 'is-b' });
  assert.equal(hitB.respBody, 'BR-B');

  // impossible：条件与枚举矛盾
  const impossible = byId.get('impossible') as ReachReport['branches'][number];
  assert.equal(impossible.status, 'contradictory');
  assert.equal('example' in impossible, false);
  assert.ok(impossible.reasons?.some((r) => r.pointer === '/state' && r.message.includes('c')));
  // 该条件值在真实服务上直接 400，没有任何分支会被命中
  const c = await probe(server, '/orders', '{"state":"c"}');
  assert.equal(c.status, 400);
  assert.equal(c.passed, false);
  assert.equal(c.selection, null);

  // 兜底也被两支并集覆盖（仅信息，不改变退出码的计数）
  assert.equal(report.fallback.status, 'covered');
  assert.deepEqual(report.fallback.coveredBy, ['is-a', 'is-b']);
  assert.equal('example' in report.fallback, false);
});

// ---------------------------------------------------------------------------
// 场景二：枚举剩余值 + 可选字段缺失 => 兜底可达；样例真实命中兜底
// ---------------------------------------------------------------------------

test('枚举剩余值与可选字段缺失：兜底可达，样例省略可选字段并真实落兜底；全部可达退出 0', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config: unknown = {
    endpoints: [
      {
        method: 'POST',
        path: '/orders',
        requestBody: {
          type: 'object',
          fields: {
            state: { type: 'string', enum: ['a', 'b', 'c'], required: true },
            note: { type: 'string' },
            flag: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        responses: [resp('FB')],
        branches: [
          { id: 'is-a', when: { '/state': 'a' }, responses: [resp('BR-A')] },
          { id: 'is-b', when: { '/state': 'b' }, responses: [resp('BR-B')] },
          { id: 'note-x', when: { '/note': 'x' }, responses: [resp('BR-NOTE')] },
        ],
      },
    ],
  };
  const file = await writeConfig(dir, 'scenes.json', config);
  const server = await startServer(file);
  t.after(server.close);

  const result = await runReach(file, '/orders');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ReachReport;
  assert.equal(report.unreachableBranches, 0);

  const byId = new Map(report.branches.map((b) => [b.id, b]));
  for (const id of ['is-a', 'is-b', 'note-x']) {
    assert.equal(byId.get(id)?.status, 'reachable', `${id} 应可达`);
    await assertExampleSelects(server, byId.get(id)?.example as RawRequest, { kind: 'branch', id });
  }
  // note-x 的样例必须显式带上 note，同时补全必填的 state（取未被前两支占用的 c）
  const noteExample = JSON.parse((byId.get('note-x') as ReachReport['branches'][number]).example?.body as string);
  assert.equal(noteExample.note, 'x');

  // 兜底可达：枚举剩余值 c + 可选字段全部缺失
  assert.equal(report.fallback.status, 'reachable');
  const fbBody = report.fallback.example?.body;
  assert.equal(fbBody, '{"state":"c"}', '样例只补全必填字段，省略可选的 note/flag');
  const fbHit = await assertExampleSelects(server, report.fallback.example as RawRequest, { kind: 'fallback' });
  assert.equal(fbHit.respBody, 'FB');

  // 显式 null 与缺失不同：state c + note:null（note 不可空）应被真实服务 400
  const nullNote = await probe(server, '/orders', '{"state":"c","note":null}');
  assert.equal(nullNote.status, 400);
  assert.equal(nullNote.selection, null);
});

// ---------------------------------------------------------------------------
// 场景三：可空根（null 落兜底）、可空字段上的 null 条件、不可空字段上矛盾
// ---------------------------------------------------------------------------

test('可空：根 null 落兜底；可空字段 null 条件可达；不可空字段 null 条件矛盾', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config: unknown = {
    endpoints: [
      {
        method: 'POST',
        path: '/orders',
        requestBody: {
          type: 'object',
          nullable: true,
          fields: {
            state: { type: 'string', enum: ['a', 'b'], required: true },
            flag: { type: 'boolean', nullable: true },
            note: { type: 'string' },
          },
          additionalProperties: false,
        },
        responses: [resp('FB')],
        branches: [
          { id: 'flag-null', when: { '/flag': null }, responses: [resp('BR-NULL')] },
          { id: 'is-a', when: { '/state': 'a' }, responses: [resp('BR-A')] },
          { id: 'is-b', when: { '/state': 'b' }, responses: [resp('BR-B')] },
          { id: 'note-null', when: { '/note': null }, responses: [resp('BR-NNOTE')] },
        ],
      },
    ],
  };
  const file = await writeConfig(dir, 'scenes.json', config);
  const server = await startServer(file);
  t.after(server.close);

  const result = await runReach(file, '/orders');
  assert.equal(result.code, 1); // note-null 矛盾
  const report = JSON.parse(result.stdout) as ReachReport;
  const byId = new Map(report.branches.map((b) => [b.id, b]));

  // 可空字段上的 null 条件可达：样例在 flag 处显式为 null（不是缺失）
  const flagNull = byId.get('flag-null') as ReachReport['branches'][number];
  assert.equal(flagNull.status, 'reachable');
  const fnBody = JSON.parse(flagNull.example?.body as string);
  assert.equal(fnBody.flag, null);
  assert.equal(Object.prototype.hasOwnProperty.call(fnBody, 'flag'), true);
  const fnHit = await assertExampleSelects(server, flagNull.example as RawRequest, { kind: 'branch', id: 'flag-null' });
  assert.equal(fnHit.respBody, 'BR-NULL');

  // 缺失字段不等于 null：state a 但不带 flag 时不命中 flag-null（落后续分支）
  const missingFlag = await probe(server, '/orders', '{"state":"a"}');
  assert.deepEqual(missingFlag.selection, { kind: 'branch', id: 'is-a' });

  // 不可空字段上的 null 条件矛盾
  const noteNull = byId.get('note-null') as ReachReport['branches'][number];
  assert.equal(noteNull.status, 'contradictory');
  assert.ok(noteNull.reasons?.some((r) => r.pointer === '/note'));
  const noteNullReq = await probe(server, '/orders', '{"state":"a","note":null}');
  assert.equal(noteNullReq.status, 400);

  // 根可空：JSON null 不命中任何字段分支，兜底可达且样例正文就是 null
  assert.equal(report.fallback.status, 'reachable');
  assert.equal(report.fallback.example?.body, 'null');
  const rootNull = await assertExampleSelects(server, report.fallback.example as RawRequest, { kind: 'fallback' });
  assert.equal(rootNull.respBody, 'FB');
});

// ---------------------------------------------------------------------------
// 场景四：特殊字段名（空名 / __proto__ / ~0 / ~1）
// ---------------------------------------------------------------------------

test('特殊字段名：空字段名、__proto__、斜杠与波浪号字段的单段指针', { timeout: 30_000 }, async (t) => {
  const fields: Record<string, unknown> = Object.create(null);
  fields[''] = { type: 'string' };
  fields['__proto__'] = { type: 'integer' };
  fields['a/b'] = { type: 'boolean' };
  fields['a~b'] = { type: 'boolean' };
  const dir = await makeTempDir(t);
  const config: unknown = {
    endpoints: [
      {
        method: 'POST',
        path: '/special',
        requestBody: { type: 'object', fields, additionalProperties: false },
        responses: [resp('FB')],
        branches: [
          { id: 'empty', when: { '/': 'x' }, responses: [resp('BR-EMPTY')] },
          { id: 'proto', when: { '/__proto__': 0 }, responses: [resp('BR-PROTO')] },
          { id: 'slash', when: { '/a~1b': true }, responses: [resp('BR-SLASH')] },
          { id: 'tilde', when: { '/a~0b': true }, responses: [resp('BR-TILDE')] },
        ],
      },
    ],
  };
  const file = await writeConfig(dir, 'scenes.json', config);
  const server = await startServer(file);
  t.after(server.close);

  const result = await runReach(file, '/special');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ReachReport;
  const byId = new Map(report.branches.map((b) => [b.id, b]));

  const expectedBodies: Record<string, string> = {
    empty: 'BR-EMPTY',
    proto: 'BR-PROTO',
    slash: 'BR-SLASH',
    tilde: 'BR-TILDE',
  };
  for (const id of ['empty', 'proto', 'slash', 'tilde']) {
    const branch = byId.get(id) as ReachReport['branches'][number];
    assert.equal(branch.status, 'reachable', `${id} 应可达`);
    const hit = await assertExampleSelects(server, branch.example as RawRequest, { kind: 'branch', id });
    assert.equal(hit.respBody, expectedBodies[id]);
  }

  // 空对象不命中任何支：兜底可达
  assert.equal(report.fallback.status, 'reachable');
  assert.equal(report.fallback.example?.body, '{}');
  const fb = await assertExampleSelects(server, report.fallback.example as RawRequest, { kind: 'fallback' });
  assert.equal(fb.respBody, 'FB');
});

// ---------------------------------------------------------------------------
// 场景五：0 与 -0 等价导致的遮挡；以及同指针互异/类型不符矛盾
// ---------------------------------------------------------------------------

test('0 与 -0 等价：后支被前支遮挡；类型不符与同指针互异常量判矛盾', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config: unknown = {
    endpoints: [
      {
        method: 'POST',
        path: '/nums',
        requestBody: {
          type: 'object',
          fields: { n: { type: 'integer', enum: [0, 1] }, flag: { type: 'boolean' } },
          additionalProperties: false,
        },
        responses: [resp('FB')],
        branches: [
          { id: 'zero', when: { '/n': 0 }, responses: [resp('BR-ZERO')] },
          { id: 'neg-zero', when: { '/n': -0 }, responses: [resp('BR-NEG')] },
          { id: 'type-bad', when: { '/flag': 'true' }, responses: [resp('BR-TB')] },
          { id: 'enum-miss', when: { '/n': 2 }, responses: [resp('BR-EM')] },
        ],
      },
    ],
  };
  const file = await writeConfig(dir, 'scenes.json', config);
  const server = await startServer(file);
  t.after(server.close);

  const result = await runReach(file, '/nums');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as ReachReport;
  const byId = new Map(report.branches.map((b) => [b.id, b]));

  const zero = byId.get('zero') as ReachReport['branches'][number];
  assert.equal(zero.status, 'reachable');
  await assertExampleSelects(server, zero.example as RawRequest, { kind: 'branch', id: 'zero' });

  // -0 与 0 数值相等：neg-zero 被 zero 遮挡
  const neg = byId.get('neg-zero') as ReachReport['branches'][number];
  assert.equal(neg.status, 'covered');
  assert.deepEqual(neg.coveredBy, ['zero']);
  const negHit = await probe(server, '/nums', '{"n":-0}');
  assert.deepEqual(negHit.selection, { kind: 'branch', id: 'zero' });
  assert.equal(negHit.respBody, 'BR-ZERO');

  // 类型不符
  const typeBad = byId.get('type-bad') as ReachReport['branches'][number];
  assert.equal(typeBad.status, 'contradictory');
  assert.ok(typeBad.reasons?.some((r) => r.pointer === '/flag'));

  // 枚举越界（JSON 配置中同一 when 键无法保留重复键，故互异常量以枚举越界见证）
  const enumMiss = byId.get('enum-miss') as ReachReport['branches'][number];
  assert.equal(enumMiss.status, 'contradictory');
  assert.ok(enumMiss.reasons?.some((r) => r.pointer === '/n' && r.message.includes('枚举')));
  const enumMissReq = await probe(server, '/nums', '{"n":2}');
  assert.equal(enumMissReq.status, 400);
  assert.equal(enumMissReq.selection, null);

  // 没有分支钉住“缺失/其余值”：兜底可达（n 取未被钉住的枚举剩余值 1 或缺省）
  assert.equal(report.fallback.status, 'reachable');
  await assertExampleSelects(server, report.fallback.example as RawRequest, { kind: 'fallback' });
});

// ---------------------------------------------------------------------------
// 场景六：范围错误与各类输入失败 -> 退出 2、stderr 定位、stdout 为空
// ---------------------------------------------------------------------------

test('范围与输入错误：退出 2、stderr 可定位、stdout 为空', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);

  const outOfScope: unknown = {
    endpoints: [
      // GET 接口
      { method: 'GET', path: '/g', responses: [resp('G')] },
      // POST 但无 branches
      { method: 'POST', path: '/no-branches', responses: [resp('X')] },
      // 根规则为标量
      {
        method: 'POST',
        path: '/scalar-root',
        requestBody: { type: 'string' },
        responses: [resp('X')],
        branches: [{ id: 'r', when: { '': 'x' }, responses: [resp('X')] }],
      },
      // 多段指针
      {
        method: 'POST',
        path: '/deep',
        requestBody: {
          type: 'object',
          fields: { tags: { type: 'array', items: { type: 'string' } } },
          additionalProperties: false,
        },
        responses: [resp('X')],
        branches: [{ id: 'd', when: { '/tags/0': 'x' }, responses: [resp('X')] }],
      },
      // 根指针（条件值合法，但根指针为零段，超出范围）
      {
        method: 'POST',
        path: '/root-ptr',
        requestBody: { type: 'object', fields: { k: { type: 'string' } }, additionalProperties: false },
        responses: [resp('X')],
        branches: [{ id: 'r', when: { '': 'x' }, responses: [resp('X')] }],
      },
      // 指向未声明字段
      {
        method: 'POST',
        path: '/undeclared',
        requestBody: { type: 'object', fields: { k: { type: 'string' } }, additionalProperties: false },
        responses: [resp('X')],
        branches: [{ id: 'u', when: { '/missing': 'x' }, responses: [resp('X')] }],
      },
      // 指向 object 字段
      {
        method: 'POST',
        path: '/obj-field',
        requestBody: {
          type: 'object',
          fields: { box: { type: 'object', fields: {} } },
          additionalProperties: false,
        },
        responses: [resp('X')],
        branches: [{ id: 'o', when: { '/box': null }, responses: [resp('X')] }],
      },
    ],
  };
  const scopeFile = await writeConfig(dir, 'scope.json', outOfScope);

  const cases: Array<{ name: string; path: string; expect: RegExp }> = [
    { name: 'GET 路径', path: '/g', expect: /不存在 POST 接口/ },
    { name: '无分支接口', path: '/no-branches', expect: /未声明 branches/ },
    { name: '标量根规则', path: '/scalar-root', expect: /根 requestBody 为 object/ },
    { name: '多段指针', path: '/deep', expect: /单段/ },
    { name: '根指针', path: '/root-ptr', expect: /单段/ },
    { name: '未声明字段', path: '/undeclared', expect: /未声明字段/ },
    { name: 'object 字段', path: '/obj-field', expect: /标量字段/ },
    { name: '路径不存在', path: '/no-such', expect: /不存在 POST 接口/ },
  ];
  for (const c of cases) {
    const r = await runReach(scopeFile, c.path);
    assert.equal(r.code, 2, `${c.name} 应退出 2`);
    assert.equal(r.stdout, '', `${c.name} stdout 必须为空`);
    assert.ok(c.expect.test(r.stderr), `${c.name} stderr 应可定位，实际：${r.stderr}`);
  }

  // 参数错误
  const missingPath = await runCli(['reach', '--config', scopeFile]);
  assert.equal(missingPath.code, 2);
  assert.equal(missingPath.stdout, '');
  assert.ok(missingPath.stderr.includes('--path'));

  const badPath = await runCli(['reach', '--config', scopeFile, '--path', 'orders']);
  assert.equal(badPath.code, 2);
  assert.equal(badPath.stdout, '');

  const unknownFlag = await runCli(['reach', '--config', scopeFile, '--path', '/g', '--nope']);
  assert.equal(unknownFlag.code, 2);
  assert.equal(unknownFlag.stdout, '');

  // 文件缺失
  const missingFile = await runReach(path.join(dir, 'missing.json'), '/g');
  assert.equal(missingFile.code, 2);
  assert.equal(missingFile.stdout, '');
  assert.ok(missingFile.stderr.includes('missing.json'));

  // JSON 解析失败
  const badJson = await writeText(dir, 'bad.json', '{ not json');
  const parseFail = await runReach(badJson, '/g');
  assert.equal(parseFail.code, 2);
  assert.equal(parseFail.stdout, '');
  assert.ok(parseFail.stderr.includes('bad.json'));

  // 场景严格校验失败（未知字段）
  const invalidScene = await writeConfig(dir, 'invalid.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/x',
        requestBody: { type: 'object', bogus: 1 },
        responses: [resp('X')],
        branches: [{ id: 'b', when: { '/k': 1 }, responses: [resp('X')] }],
      },
    ],
  });
  const invalid = await runReach(invalidScene, '/x');
  assert.equal(invalid.code, 2, '整份场景严格校验失败时不得输出报告');
  assert.equal(invalid.stdout, '');
  assert.ok(invalid.stderr.includes('invalid.json'));
});

test('现有命令与服务行为不受影响：help 含 reach；无参数仍显示帮助', { timeout: 20_000 }, async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes('reach --config'));
  const noArgs = await runCli([]);
  assert.equal(noArgs.code, 0);
  assert.ok(noArgs.stdout.includes('contractlab'));
  const badCommand = await runCli(['bogus']);
  assert.equal(badCommand.code, 2);
});

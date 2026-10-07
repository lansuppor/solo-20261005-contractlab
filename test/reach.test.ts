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
      // 多段指针穿过数组
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
      // 多段指针穿过对象再穿数组（中间 object 合法，数组段拒绝）
      {
        method: 'POST',
        path: '/deep2',
        requestBody: {
          type: 'object',
          fields: {
            m: { type: 'object', fields: { tags: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        responses: [resp('X')],
        branches: [{ id: 'd', when: { '/m/tags/0': 'x' }, responses: [resp('X')] }],
      },
      // 根指针（条件值合法，但根指针为零段，超出范围）
      {
        method: 'POST',
        path: '/root-ptr',
        requestBody: { type: 'object', fields: { k: { type: 'string' } }, additionalProperties: false },
        responses: [resp('X')],
        branches: [{ id: 'r', when: { '': 'x' }, responses: [resp('X')] }],
      },
      // 单段指向未声明字段
      {
        method: 'POST',
        path: '/undeclared',
        requestBody: { type: 'object', fields: { k: { type: 'string' } }, additionalProperties: false },
        responses: [resp('X')],
        branches: [{ id: 'u', when: { '/missing': 'x' }, responses: [resp('X')] }],
      },
      // 多段指针的中间段指向未声明字段
      {
        method: 'POST',
        path: '/undeclared-mid',
        requestBody: {
          type: 'object',
          fields: { m: { type: 'object', fields: { z: { type: 'string' } }, additionalProperties: false } },
          additionalProperties: false,
        },
        responses: [resp('X')],
        branches: [{ id: 'u', when: { '/m/nope/z': 'x' }, responses: [resp('X')] }],
      },
      // 多段指针穿过标量字段
      {
        method: 'POST',
        path: '/through-scalar',
        requestBody: {
          type: 'object',
          fields: { k: { type: 'string' }, m: { type: 'object', fields: { z: { type: 'string' } }, additionalProperties: false } },
          additionalProperties: false,
        },
        responses: [resp('X')],
        branches: [{ id: 'u', when: { '/k/z': 'x' }, responses: [resp('X')] }],
      },
      // 单段终点为 object 字段
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
      // 多段终点为 object 字段
      {
        method: 'POST',
        path: '/obj-end',
        requestBody: {
          type: 'object',
          fields: { m: { type: 'object', fields: { box: { type: 'object', fields: {} } }, additionalProperties: false } },
          additionalProperties: false,
        },
        responses: [resp('X')],
        branches: [{ id: 'o', when: { '/m/box': null }, responses: [resp('X')] }],
      },
      // 终点为 array 字段
      {
        method: 'POST',
        path: '/arr-end',
        requestBody: {
          type: 'object',
          fields: { m: { type: 'object', fields: { tags: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
          additionalProperties: false,
        },
        responses: [resp('X')],
        branches: [{ id: 'a', when: { '/m/tags': null }, responses: [resp('X')] }],
      },
      // 多段指针沿 object 链指向已声明标量字段：在范围内，不应拒绝
      {
        method: 'POST',
        path: '/nested-ok',
        requestBody: {
          type: 'object',
          fields: { m: { type: 'object', fields: { z: { type: 'string' } }, additionalProperties: false } },
          additionalProperties: false,
        },
        responses: [resp('X')],
        branches: [{ id: 'n', when: { '/m/z': 'x' }, responses: [resp('X')] }],
      },
    ],
  };
  const scopeFile = await writeConfig(dir, 'scope.json', outOfScope);

  const cases: Array<{ name: string; path: string; expect: RegExp }> = [
    { name: 'GET 路径', path: '/g', expect: /不存在 POST 接口/ },
    { name: '无分支接口', path: '/no-branches', expect: /未声明 branches/ },
    { name: '标量根规则', path: '/scalar-root', expect: /根 requestBody 为 object/ },
    { name: '穿过多段数组', path: '/deep', expect: /只能穿过 object/ },
    { name: '对象后穿数组', path: '/deep2', expect: /只能穿过 object/ },
    { name: '根指针', path: '/root-ptr', expect: /根指针/ },
    { name: '未声明字段', path: '/undeclared', expect: /未声明字段/ },
    { name: '中间段未声明字段', path: '/undeclared-mid', expect: /未声明字段/ },
    { name: '穿过标量字段', path: '/through-scalar', expect: /只能穿过 object/ },
    { name: 'object 终点', path: '/obj-field', expect: /标量字段/ },
    { name: '多段 object 终点', path: '/obj-end', expect: /标量字段/ },
    { name: 'array 终点', path: '/arr-end', expect: /标量字段/ },
    { name: '路径不存在', path: '/no-such', expect: /不存在 POST 接口/ },
  ];
  for (const c of cases) {
    const r = await runReach(scopeFile, c.path);
    assert.equal(r.code, 2, `${c.name} 应退出 2`);
    assert.equal(r.stdout, '', `${c.name} stdout 必须为空`);
    assert.ok(c.expect.test(r.stderr), `${c.name} stderr 应可定位，实际：${r.stderr}`);
  }

  // 沿 object 链的多段指针在范围内：正常输出报告、退出 0（该支可达、兜底可达）
  const nestedOk = await runReach(scopeFile, '/nested-ok');
  assert.equal(nestedOk.code, 0, nestedOk.stderr);
  const nestedReport = JSON.parse(nestedOk.stdout) as ReachReport;
  assert.equal(nestedReport.branches[0]?.status, 'reachable');

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

// ---------------------------------------------------------------------------
// 场景七：题述 buyer 例——祖先形态变化（可选可空 -> 后支可达；必填不可空 -> 共同遮挡）
// ---------------------------------------------------------------------------

function buyerConfig(ancestor: { required?: boolean; nullable?: boolean }): unknown {
  return {
    endpoints: [
      {
        method: 'POST',
        path: '/orders',
        requestBody: {
          type: 'object',
          fields: {
            buyer: {
              type: 'object',
              ...(ancestor.required ? { required: true } : {}),
              ...(ancestor.nullable ? { nullable: true } : {}),
              fields: { state: { type: 'string', enum: ['a', 'b'], required: true } },
              additionalProperties: false,
            },
            flag: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        responses: [resp('FB')],
        branches: [
          { id: 'buyer-a', when: { '/buyer/state': 'a' }, responses: [resp('BR-A')] },
          { id: 'buyer-b', when: { '/buyer/state': 'b' }, responses: [resp('BR-B')] },
          { id: 'flag', when: { '/flag': true }, responses: [resp('BR-FLAG')] },
        ],
      },
    ],
  };
}

test('祖先可选可空：buyer 缺失/null 的 flag:true 正文使后支可达；样例真实命中', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', buyerConfig({}));
  const server = await startServer(file);
  t.after(server.close);

  const result = await runReach(file, '/orders');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ReachReport;
  const byId = new Map(report.branches.map((b) => [b.id, b]));

  for (const id of ['buyer-a', 'buyer-b', 'flag']) {
    const branch = byId.get(id) as ReachReport['branches'][number];
    assert.equal(branch.status, 'reachable', `${id} 应可达`);
    await assertExampleSelects(server, branch.example as RawRequest, { kind: 'branch', id });
  }
  // 后支样例正是 buyer 缺失的 {"flag":true}
  assert.equal((byId.get('flag') as ReachReport['branches'][number]).example?.body, '{"flag":true}');

  // buyer 缺失 + flag:true：真实服务选 flag
  const missing = await probe(server, '/orders', '{"flag":true}');
  assert.deepEqual(missing.selection, { kind: 'branch', id: 'flag' });

  // buyer 为 null + flag:true（此配置 buyer 不可空）：真实服务 400，不进分支
  const buyerNull = await probe(server, '/orders', '{"buyer":null,"flag":true}');
  assert.equal(buyerNull.status, 400);
  assert.equal(buyerNull.selection, null);

  // buyer 存在但 state 不匹配枚举时不可能合格；state a/b + flag true 分别先命中前两支
  const aFlag = await probe(server, '/orders', '{"buyer":{"state":"a"},"flag":true}');
  assert.deepEqual(aFlag.selection, { kind: 'branch', id: 'buyer-a' });
  const bFlag = await probe(server, '/orders', '{"buyer":{"state":"b"},"flag":true}');
  assert.deepEqual(bFlag.selection, { kind: 'branch', id: 'buyer-b' });
});

test('祖先必填不可空：后支被前两支经共享祖先并集共同遮挡；样例补全 buyer', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', buyerConfig({ required: true }));
  const server = await startServer(file);
  t.after(server.close);

  const result = await runReach(file, '/orders');
  assert.equal(result.code, 1, '存在 covered 分支，退出 1');
  const report = JSON.parse(result.stdout) as ReachReport;
  const byId = new Map(report.branches.map((b) => [b.id, b]));

  const a = byId.get('buyer-a') as ReachReport['branches'][number];
  const b = byId.get('buyer-b') as ReachReport['branches'][number];
  assert.equal(a.status, 'reachable');
  assert.equal(b.status, 'reachable');
  for (const branch of [a, b]) {
    await assertExampleSelects(server, branch.example as RawRequest, { kind: 'branch', id: branch.id });
  }

  const flag = byId.get('flag') as ReachReport['branches'][number];
  assert.equal(flag.status, 'covered');
  assert.deepEqual(flag.coveredBy, ['buyer-a', 'buyer-b']);
  assert.equal('example' in flag, false, '不可达分支不给样例');

  // 真实核对：缺 buyer 的 flag:true 现在 400（buyer 必填）；带 buyer 必先命中前两支
  const noBuyer = await probe(server, '/orders', '{"flag":true}');
  assert.equal(noBuyer.status, 400);
  assert.equal(noBuyer.selection, null);
  const aFlag = await probe(server, '/orders', '{"buyer":{"state":"a"},"flag":true}');
  assert.deepEqual(aFlag.selection, { kind: 'branch', id: 'buyer-a' });
  const bFlag = await probe(server, '/orders', '{"buyer":{"state":"b"},"flag":true}');
  assert.deepEqual(bFlag.selection, { kind: 'branch', id: 'buyer-b' });
});

test('祖先可选且可空：buyer:null + flag:true 使后支可达；null 祖先上深层条件不匹配', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', buyerConfig({ nullable: true }));
  const server = await startServer(file);
  t.after(server.close);

  const result = await runReach(file, '/orders');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as ReachReport;
  const byId = new Map(report.branches.map((b) => [b.id, b]));
  assert.equal((byId.get('flag') as ReachReport['branches'][number]).status, 'reachable');

  // buyer:null + flag:true：buyer 显式 null 合法，深层指针取不到值，只命中 flag
  const buyerNull = await probe(server, '/orders', '{"buyer":null,"flag":true}');
  assert.equal(buyerNull.status, 200);
  assert.deepEqual(buyerNull.selection, { kind: 'branch', id: 'flag' });
  assert.equal(buyerNull.respBody, 'BR-FLAG');

  // 仅 buyer:null（无 flag）：深层两支都不匹配，落兜底
  const onlyNull = await probe(server, '/orders', '{"buyer":null}');
  assert.deepEqual(onlyNull.selection, { kind: 'fallback' });
});

// ---------------------------------------------------------------------------
// 场景八：多层共享祖先 + 必填兄弟字段补全 + 祖先内叶字段遮挡 vs 顶层叶字段逃逸
// ---------------------------------------------------------------------------

test('多层共享祖先：深层叶字段被并集遮挡、样例补全各层必填兄弟；顶层兄弟字段可达', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config: unknown = {
    endpoints: [
      {
        method: 'POST',
        path: '/deep',
        requestBody: {
          type: 'object',
          fields: {
            top: { type: 'integer', required: true },
            a: {
              type: 'object',
              fields: {
                sib: { type: 'integer', required: true },
                b: {
                  type: 'object',
                  required: true,
                  fields: {
                    state: { type: 'string', enum: ['a', 'b'], required: true },
                    f: { type: 'boolean' },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
            other: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        responses: [resp('FB')],
        branches: [
          { id: 'xa', when: { '/a/b/state': 'a' }, responses: [resp('XA')] },
          { id: 'xb', when: { '/a/b/state': 'b' }, responses: [resp('XB')] },
          { id: 'inner-f', when: { '/a/b/f': true }, responses: [resp('IF')] },
          { id: 'top-other', when: { '/other': true }, responses: [resp('TO')] },
        ],
      },
    ],
  };
  const file = await writeConfig(dir, 'scenes.json', config);
  const server = await startServer(file);
  t.after(server.close);

  const result = await runReach(file, '/deep');
  assert.equal(result.code, 1, 'inner-f 被遮挡，退出 1');
  const report = JSON.parse(result.stdout) as ReachReport;
  const byId = new Map(report.branches.map((b) => [b.id, b]));

  // xa/xb 可达：样例补全 top、a.sib，且含必要祖先 a/b
  for (const id of ['xa', 'xb']) {
    const branch = byId.get(id) as ReachReport['branches'][number];
    assert.equal(branch.status, 'reachable');
    const body = JSON.parse(branch.example?.body as string);
    assert.equal(body.top, 0, '补全顶层必填兄弟 top');
    assert.equal(body.a.sib, 0, '补全中间层必填兄弟 a.sib');
    assert.ok(body.a.b && typeof body.a.b === 'object', '补全必要祖先 a.b');
    await assertExampleSelects(server, branch.example as RawRequest, { kind: 'branch', id });
  }

  // inner-f 钉的是共享祖先 a.b 内的叶字段：a.b 必填且 state 必填枚举 a/b，
  // 任何满足它的正文必先命中 xa/xb —— 共同遮挡
  const innerF = byId.get('inner-f') as ReachReport['branches'][number];
  assert.equal(innerF.status, 'covered');
  assert.deepEqual(innerF.coveredBy, ['xa', 'xb']);
  assert.equal('example' in innerF, false);

  // 顶层 other 不在 a.b 祖先内：a 可选，{top,other:true} 逃出深层遮挡
  const topOther = byId.get('top-other') as ReachReport['branches'][number];
  assert.equal(topOther.status, 'reachable');
  const otherBody = JSON.parse(topOther.example?.body as string);
  assert.equal(otherBody.other, true);
  assert.equal(Object.prototype.hasOwnProperty.call(otherBody, 'a'), false, '样例不带可选祖先 a');
  await assertExampleSelects(server, topOther.example as RawRequest, { kind: 'branch', id: 'top-other' });

  // 真实核对 inner-f 的两类满足正文分别先命中 xa/xb
  const hitA = await probe(server, '/deep', '{"top":1,"a":{"sib":2,"b":{"state":"a","f":true}}}');
  assert.deepEqual(hitA.selection, { kind: 'branch', id: 'xa' });
  const hitB = await probe(server, '/deep', '{"top":1,"a":{"sib":2,"b":{"state":"b","f":true}}}');
  assert.deepEqual(hitB.selection, { kind: 'branch', id: 'xb' });

  // 兜底可达：a 缺失时没有深层分支，other 也不带
  assert.equal(report.fallback.status, 'reachable');
  const fbBody = JSON.parse(report.fallback.example?.body as string);
  assert.deepEqual(fbBody, { top: 0 });
  await assertExampleSelects(server, report.fallback.example as RawRequest, { kind: 'fallback' });
});

// ---------------------------------------------------------------------------
// 场景九：深层特殊字段名、深层矛盾定位、叶 null 与祖先 null 分开
// ---------------------------------------------------------------------------

test('深层特殊字段名、深层矛盾定位、叶 null 与祖先缺失/null 分开', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const fields: Record<string, unknown> = Object.create(null);
  // 根空名字段，其下 __proto__ 为枚举字符串（内层对象也须无原型并赋值，
  // 不能在对象字面量中写 __proto__——那会设置原型而非自有字段）
  const emptyFields: Record<string, unknown> = Object.create(null);
  emptyFields.__proto__ = { type: 'string', enum: ['p', 'q'] };
  fields[''] = {
    type: 'object',
    fields: emptyFields,
    additionalProperties: false,
  };
  // a 可空：其下标量 s 不可空；深层 z 为 integer
  fields.a = {
    type: 'object',
    nullable: true,
    fields: {
      s: { type: 'string', enum: ['x', 'y'] },
      deep: { type: 'object', fields: { z: { type: 'integer', required: true } }, additionalProperties: false },
    },
    additionalProperties: false,
  };
  const config: unknown = {
    endpoints: [
      {
        method: 'POST',
        path: '/e',
        requestBody: { type: 'object', fields, additionalProperties: false },
        responses: [resp('FB')],
        branches: [
          { id: 'empty-proto', when: { '//__proto__': 'p' }, responses: [resp('EP')] },
          { id: 'both', when: { '/a/s': 'x', '/a/deep/z': 5 }, responses: [resp('BOTH')] },
          { id: 'leaf-null', when: { '/a/s': null }, responses: [resp('LN')] },
          { id: 'bad-type', when: { '/a/deep/z': 1.5 }, responses: [resp('BT')] },
        ],
      },
    ],
  };
  const file = await writeConfig(dir, 'scenes.json', config);
  const server = await startServer(file);
  t.after(server.close);

  const result = await runReach(file, '/e');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as ReachReport;
  const byId = new Map(report.branches.map((b) => [b.id, b]));

  // 空名祖先下的 __proto__ 叶字段：指针 //__proto__，样例真实命中
  const ep = byId.get('empty-proto') as ReachReport['branches'][number];
  assert.equal(ep.status, 'reachable');
  assert.equal(ep.example?.body, '{"":{"__proto__":"p"}}');
  await assertExampleSelects(server, ep.example as RawRequest, { kind: 'branch', id: 'empty-proto' });

  // 一支钉两个共享祖先 a 下的叶字段：样例补全 a、a.deep 与必填 z
  const both = byId.get('both') as ReachReport['branches'][number];
  assert.equal(both.status, 'reachable');
  const bothBodyObj = JSON.parse(both.example?.body as string);
  assert.equal(bothBodyObj.a.s, 'x');
  assert.equal(bothBodyObj.a.deep.z, 5);
  await assertExampleSelects(server, both.example as RawRequest, { kind: 'branch', id: 'both' });

  // 叶 s 不可空：/a/s == null 矛盾（祖先 a 缺失或为 null 也不等于叶为 null）
  const leafNull = byId.get('leaf-null') as ReachReport['branches'][number];
  assert.equal(leafNull.status, 'contradictory');
  assert.ok(leafNull.reasons?.some((r) => r.pointer === '/a/s'));

  // 深层类型矛盾按完整多段指针定位
  const badType = byId.get('bad-type') as ReachReport['branches'][number];
  assert.equal(badType.status, 'contradictory');
  assert.ok(badType.reasons?.some((r) => r.pointer === '/a/deep/z' && r.message.includes('integer')));

  // 真实服务：叶为 null 400；祖先 a 缺失/为 null 时深层条件不命中（落兜底，不报错）
  const leafNullReq = await probe(server, '/e', '{"a":{"s":null}}');
  assert.equal(leafNullReq.status, 400);
  const aMissing = await probe(server, '/e', '{}');
  assert.deepEqual(aMissing.selection, { kind: 'fallback' });
  const aNull = await probe(server, '/e', '{"a":null}');
  assert.equal(aNull.status, 200);
  assert.deepEqual(aNull.selection, { kind: 'fallback' });

  // 兜底可达
  assert.equal(report.fallback.status, 'reachable');
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

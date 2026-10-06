// 嵌套 allOf 交集的回归测试（import 子命令）
//
// 覆盖题目场景：三个开放对象分支都声明可选 box；box 内部前两支分别声明
// 可选 x 为 string / integer 并允许额外字段，第三支不声明内部字段且拒绝
// 额外字段。中间两分支（box1 ∩ box2）单独看无法表达，但三分支的最终接受
// 集合可表达为“box 可省略或为空对象”，必须成功导入。
//
// - 成功语义的接受集合：外层允许额外字段、box 可省略/为空对象、box 内任何
//   字段拒绝（用真实本机服务核对允许与拒绝的正文）；
// - 分支换序、等价嵌套分组、本文件内引用不改变成功/拒绝结论与接受集合；
// - 删除第三支则以“无法表达”拒绝；对象交集位于数组元素时遵循同样规则；
// - 必填冲突（空交集）、无法表达、字段禁止出现三种情形可区分，失败退出 2、
//   stdout 为空、stderr 指明输入文件 + 操作/定义位置 + 冲突字段 + 原因；
// - 所选可达定义中的非法值/未知关键字/引用错误不因字段最终被禁止而忽略。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeTempDir,
  runCli,
  sceneResponse,
  SCENE_BODY,
  SCENE_STATUS,
  sendRequest,
  startServer,
  writeConfig,
} from './helpers.ts';

function runImport(openapi: string, config: string) {
  return runCli(['import', '--openapi', openapi, '--config', config]);
}

function jsonBody(schema: unknown): unknown {
  return { required: true, content: { 'application/json': { schema } } };
}

function spec(paths: unknown, components?: unknown): unknown {
  const doc: Record<string, unknown> = { openapi: '3.0.0', paths };
  if (components !== undefined) {
    doc.components = components;
  }
  return doc;
}

function sceneWith(endpoints: unknown[]): unknown {
  return { endpoints };
}

function postEndpoint(p: string): unknown {
  return { method: 'POST', path: p, responses: [sceneResponse()] };
}

// ---------------------------------------------------------------------------
// 题目场景的三个分支（外层均为开放对象，box 均可选）
// ---------------------------------------------------------------------------

// 分支一：box 内可选 x: string，允许额外字段
function branch1(): unknown {
  return {
    type: 'object',
    properties: { box: { type: 'object', properties: { x: { type: 'string' } } } },
  };
}

// 分支二：box 内可选 x: integer，允许额外字段
function branch2(): unknown {
  return {
    type: 'object',
    properties: { box: { type: 'object', properties: { x: { type: 'integer' } } } },
  };
}

// 分支三：box 不声明内部字段且拒绝额外字段
function branch3(): unknown {
  return {
    type: 'object',
    properties: { box: { type: 'object', additionalProperties: false } },
  };
}

// 期望的导入结果规则：外层允许额外字段；box 可选、内部为空对象规则
const EXPECTED_RULE = {
  type: 'object',
  fields: {
    box: { type: 'object', fields: {}, additionalProperties: false },
  },
  additionalProperties: true,
};

async function writePair(
  dir: string,
  name: string,
  schema: unknown,
  components?: unknown,
): Promise<{ api: string; config: string }> {
  const api = await writeConfig(
    dir,
    `api-${name}.json`,
    spec({ '/a': { post: { requestBody: jsonBody(schema) } } }, components),
  );
  const config = await writeConfig(dir, `scenes-${name}.json`, sceneWith([postEndpoint('/a')]));
  return { api, config };
}

function parseOutput(stdout: string): { endpoints: Record<string, unknown>[] } {
  const parsed = JSON.parse(stdout) as { endpoints: Record<string, unknown>[] };
  assert.ok(Array.isArray(parsed.endpoints), '输出必须是含 endpoints 数组的场景 JSON');
  return parsed;
}

// ---------------------------------------------------------------------------
// 嵌套三分支：成功导入 + 真实服务核对接受集合
// ---------------------------------------------------------------------------

test('嵌套三分支：中间两分支无法表达但最终可表达，必须成功；真实服务核对接受与拒绝', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const { api, config } = await writePair(dir, 'flat', {
    allOf: [branch1(), branch2(), branch3()],
  });

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `应成功导入，stderr:\n${result.stderr}`);
  const out = parseOutput(result.stdout);
  assert.deepEqual(out.endpoints[0].requestBody, EXPECTED_RULE);
  // 仅替换 requestBody：responses 原样保留
  assert.deepEqual(out.endpoints[0].responses, [sceneResponse()]);

  // 成功输出直接用于真实本机服务，核对允许与拒绝的正文
  const outFile = await writeConfig(dir, 'out.json', JSON.parse(result.stdout));
  const server = await startServer(outFile);
  try {
    const post = (body: string) =>
      sendRequest(server.port, {
        method: 'POST',
        path: '/a',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

    // 允许：省略 box、box 为空对象、外层额外字段
    for (const body of ['{}', '{"box":{}}', '{"extra":1}', '{"box":{},"extra":"s"}']) {
      const res = await post(body);
      assert.equal(res.status, SCENE_STATUS, `应接受 ${body}：${res.status} ${res.body}`);
      assert.equal(res.body, SCENE_BODY);
    }

    // 拒绝：box 中任何字段（含 x 的两种类型与其他名字）、box 非对象
    for (const body of [
      '{"box":{"x":"s"}}',
      '{"box":{"x":1}}',
      '{"box":{"anything":1}}',
      '{"box":null}',
      '{"box":[]}',
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, `应拒绝 ${body}：${res.status} ${res.body}`);
    }
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 分支换序、等价嵌套分组、本文件内引用不改变结论与接受集合
// ---------------------------------------------------------------------------

test('分支换序、等价嵌套分组与本文件内引用不改变结论与接受集合', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);

  // 基准：扁平三分支
  const base = await writePair(dir, 'order-base', { allOf: [branch1(), branch2(), branch3()] });
  const baseResult = await runImport(base.api, base.config);
  assert.equal(baseResult.code, 0, `基准应成功，stderr:\n${baseResult.stderr}`);
  const canonical = parseOutput(baseResult.stdout).endpoints[0].requestBody;
  assert.deepEqual(canonical, EXPECTED_RULE);

  const variants: Array<{ name: string; schema: unknown; components?: unknown }> = [
    // 分支换序
    { name: 'order-231', schema: { allOf: [branch2(), branch3(), branch1()] } },
    { name: 'order-321', schema: { allOf: [branch3(), branch2(), branch1()] } },
    { name: 'order-312', schema: { allOf: [branch3(), branch1(), branch2()] } },
    // 等价嵌套分组
    { name: 'group-1-23', schema: { allOf: [branch1(), { allOf: [branch2(), branch3()] }] } },
    { name: 'group-12-3', schema: { allOf: [{ allOf: [branch1(), branch2()] }, branch3()] } },
    {
      name: 'group-nested-deep',
      schema: { allOf: [{ allOf: [branch1(), { allOf: [branch2()] }] }, { allOf: [branch3()] }] },
    },
    // 本文件内引用：分支为 $ref、$ref 指向嵌套组合
    {
      name: 'refs',
      schema: {
        allOf: [
          { $ref: '#/components/schemas/B1' },
          { $ref: '#/components/schemas/Group23' },
        ],
      },
      components: {
        schemas: {
          B1: branch1(),
          B2: branch2(),
          B3: branch3(),
          Group23: { allOf: [{ $ref: '#/components/schemas/B2' }, { $ref: '#/components/schemas/B3' }] },
        },
      },
    },
    // 引用与字面混合、引用指向单分支组合
    {
      name: 'refs-mixed',
      schema: {
        allOf: [
          { $ref: '#/components/schemas/Wrap1' },
          branch2(),
          { $ref: '#/components/schemas/B3' },
        ],
      },
      components: {
        schemas: {
          Wrap1: { allOf: [branch1()] },
          B3: branch3(),
        },
      },
    },
  ];

  for (const v of variants) {
    const { api, config } = await writePair(dir, v.name, v.schema, v.components);
    const result = await runImport(api, config);
    assert.equal(result.code, 0, `${v.name}：应成功，stderr:\n${result.stderr}`);
    assert.deepEqual(
      parseOutput(result.stdout).endpoints[0].requestBody,
      canonical,
      `${v.name}：接受集合（及输出规则）必须与扁平三分支一致`,
    );
  }
});

// ---------------------------------------------------------------------------
// 删除第三支：无法表达，拒绝并定位
// ---------------------------------------------------------------------------

test('删除第三支则以无法表达拒绝：退出 2、stdout 为空、stderr 定位文件/操作/冲突字段', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const { api, config } = await writePair(dir, 'two-branches', {
    allOf: [branch1(), branch2()],
  });

  const result = await runImport(api, config);
  assert.equal(result.code, 2, `应退出 2\nstdout:\n${result.stdout}`);
  assert.equal(result.stdout, '', '失败时 stdout 必须为空');
  assert.ok(result.stderr.includes(api), `stderr 应指明输入文件：\n${result.stderr}`);
  assert.ok(
    result.stderr.includes('paths["/a"].post.requestBody'),
    `stderr 应给出操作位置：\n${result.stderr}`,
  );
  assert.ok(
    result.stderr.includes('properties["box"]') && result.stderr.includes('properties["x"]'),
    `stderr 应定位冲突字段 box 与 x：\n${result.stderr}`,
  );
  assert.ok(result.stderr.includes('无法表达'), `stderr 应说明无法表达：\n${result.stderr}`);
  assert.ok(!result.stderr.includes('交集为空：'), `无法表达与空交集应区分：\n${result.stderr}`);
});

// ---------------------------------------------------------------------------
// 对象交集位于数组元素时遵循同样规则
// ---------------------------------------------------------------------------

test('数组元素中的对象交集遵循同样规则：三分支成功、真实服务核对、两分无法表达', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const item = (inner: unknown) => ({ type: 'array', items: inner });
  const b1 = { type: 'object', properties: { box: item({ type: 'object', properties: { x: { type: 'string' } } }) } };
  const b2 = { type: 'object', properties: { box: item({ type: 'object', properties: { x: { type: 'integer' } } }) } };
  const b3 = { type: 'object', properties: { box: item({ type: 'object', additionalProperties: false }) } };

  const { api, config } = await writePair(dir, 'array-items', { allOf: [b1, b2, b3] });
  const result = await runImport(api, config);
  assert.equal(result.code, 0, `数组元素三分支应成功，stderr:\n${result.stderr}`);
  assert.deepEqual(parseOutput(result.stdout).endpoints[0].requestBody, {
    type: 'object',
    fields: {
      box: {
        type: 'array',
        items: { type: 'object', fields: {}, additionalProperties: false },
      },
    },
    additionalProperties: true,
  });

  const outFile = await writeConfig(dir, 'out-arr.json', JSON.parse(result.stdout));
  const server = await startServer(outFile);
  try {
    const post = (body: string) =>
      sendRequest(server.port, {
        method: 'POST',
        path: '/a',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    for (const body of ['{}', '{"box":[]}', '{"box":[{}]}', '{"box":[{},{}]}', '{"extra":1,"box":[{}]}']) {
      const res = await post(body);
      assert.equal(res.status, SCENE_STATUS, `应接受 ${body}：${res.status} ${res.body}`);
    }
    for (const body of ['{"box":[{"x":"s"}]}', '{"box":[{"x":1}]}', '{"box":[{"y":0}]}', '{"box":[null]}']) {
      const res = await post(body);
      assert.equal(res.status, 400, `应拒绝 ${body}：${res.status} ${res.body}`);
    }
  } finally {
    await server.close();
  }

  // 删除第三支：数组元素交集无法表达，拒绝
  const two = await writePair(dir, 'array-items-two', { allOf: [b1, b2] });
  const r2 = await runImport(two.api, two.config);
  assert.equal(r2.code, 2, `两分支应退出 2\nstdout:\n${r2.stdout}`);
  assert.equal(r2.stdout, '');
  assert.ok(r2.stderr.includes('无法表达'), `stderr 应说明无法表达：\n${r2.stderr}`);
  assert.ok(r2.stderr.includes('properties["box"]'), `stderr 应定位冲突字段：\n${r2.stderr}`);
});

// ---------------------------------------------------------------------------
// 必填冲突：整体空交集，拒绝并定位
// ---------------------------------------------------------------------------

test('必填冲突：空交集拒绝，stderr 指明文件、操作位置、冲突字段与原因', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);

  const cases: Array<{ name: string; schema: unknown; field: string }> = [
    {
      // 同名字段均为必填，类型相交为空
      name: 'required-type-conflict',
      schema: {
        allOf: [
          { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
          { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] },
        ],
      },
      field: '"x"',
    },
    {
      // 必填字段被另一分支禁止出现
      name: 'required-forbidden',
      schema: {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
          { type: 'object', properties: {}, additionalProperties: false },
        ],
      },
      field: '"a"',
    },
    {
      // 嵌套在可选 box 内的必填冲突：box 交集为空，box 自身必填 -> 整体空交集
      name: 'nested-required-conflict',
      schema: {
        allOf: [
          {
            type: 'object',
            properties: {
              box: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
            },
            required: ['box'],
          },
          {
            type: 'object',
            properties: {
              box: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] },
            },
            required: ['box'],
          },
        ],
      },
      field: '"x"',
    },
  ];

  for (const c of cases) {
    const { api, config } = await writePair(dir, c.name, c.schema);
    const result = await runImport(api, config);
    assert.equal(result.code, 2, `${c.name}：应退出 2\nstdout:\n${result.stdout}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(result.stderr.includes(api), `${c.name}：stderr 应指明输入文件：\n${result.stderr}`);
    assert.ok(
      result.stderr.includes('paths["/a"].post.requestBody'),
      `${c.name}：stderr 应给出操作位置：\n${result.stderr}`,
    );
    assert.ok(result.stderr.includes(c.field), `${c.name}：stderr 应定位冲突字段：\n${result.stderr}`);
    assert.ok(result.stderr.includes('交集为空'), `${c.name}：stderr 应说明空交集：\n${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 可达定义中的非法值不因字段最终被禁止而忽略
// ---------------------------------------------------------------------------

test('可达定义中的非法值、未知关键字、引用错误不因字段最终被禁止而忽略', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);

  const cases: Array<{ name: string; schema: unknown; components?: unknown; expect: RegExp }> = [
    {
      // x 最终被第三支禁止出现，但分支一里 x 的未知关键字仍须拒绝
      name: 'unknown-keyword-in-forbidden-field',
      schema: {
        allOf: [
          {
            type: 'object',
            properties: { box: { type: 'object', properties: { x: { type: 'string', format: 'email' } } } },
          },
          branch2(),
          branch3(),
        ],
      },
      expect: /未支持的关键字 "format"/,
    },
    {
      // 第三支（使交集可表达的分支）自身的非法值仍须拒绝
      name: 'illegal-value-in-third-branch',
      schema: {
        allOf: [
          branch1(),
          branch2(),
          { type: 'object', properties: { box: { type: 'object', additionalProperties: 'no' } } },
        ],
      },
      expect: /additionalProperties/,
    },
    {
      // 被禁止字段内部的引用错误仍须拒绝
      name: 'broken-ref-in-forbidden-field',
      schema: {
        allOf: [
          {
            type: 'object',
            properties: {
              box: { type: 'object', properties: { x: { $ref: '#/components/schemas/Missing' } } },
            },
          },
          branch2(),
          branch3(),
        ],
      },
      components: { schemas: {} },
      expect: /目标不存在/,
    },
    {
      // 嵌套组合节点中的未知关键字仍须拒绝
      name: 'unknown-keyword-in-nested-allof',
      schema: {
        allOf: [
          branch1(),
          { allOf: [branch2()], minProperties: 1 },
          branch3(),
        ],
      },
      expect: /未支持的关键字 "minProperties"/,
    },
  ];

  for (const c of cases) {
    const { api, config } = await writePair(dir, c.name, c.schema, c.components);
    const result = await runImport(api, config);
    assert.equal(result.code, 2, `${c.name}：应退出 2\nstdout:\n${result.stdout}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(result.stderr.includes(api), `${c.name}：stderr 应指明输入文件：\n${result.stderr}`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位原因：\n${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 字段禁止出现 / 整体空交集 / 非空但无法表达 三种情形可区分
// ---------------------------------------------------------------------------

test('字段禁止出现（成功）、整体空交集与非空但无法表达（均退出 2）可区分', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);

  // 字段禁止出现：可选字段被另一分支（addl:false 且未声明）禁止 -> 成功且不留在结果中
  const forbidden = await writePair(dir, 'field-forbidden', {
    allOf: [
      { type: 'object', properties: { keep: { type: 'string' }, gone: { type: 'integer' } } },
      { type: 'object', properties: { keep: { type: 'string' } }, additionalProperties: false },
    ],
  });
  const r1 = await runImport(forbidden.api, forbidden.config);
  assert.equal(r1.code, 0, `字段禁止出现应可表达（成功），stderr:\n${r1.stderr}`);
  const rule = parseOutput(r1.stdout).endpoints[0].requestBody as {
    fields: Record<string, unknown>;
    additionalProperties: boolean;
  };
  assert.ok(!('gone' in rule.fields), '被禁止出现的字段不得留在结果中');
  assert.equal(rule.additionalProperties, false);

  // 整体空交集：退出 2 且说明“交集为空”
  const empty = await writePair(dir, 'empty-intersection', {
    allOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
      { type: 'object', properties: {}, additionalProperties: false },
    ],
  });
  const r2 = await runImport(empty.api, empty.config);
  assert.equal(r2.code, 2);
  assert.equal(r2.stdout, '');
  assert.ok(r2.stderr.includes('交集为空'), `空交集应说明原因：\n${r2.stderr}`);

  // 非空但无法表达：退出 2 且说明“无法表达”
  const inexpressible = await writePair(dir, 'inexpressible', {
    allOf: [
      { type: 'object', properties: { x: { type: 'string' } } },
      { type: 'object', properties: { x: { type: 'integer' } } },
    ],
  });
  const r3 = await runImport(inexpressible.api, inexpressible.config);
  assert.equal(r3.code, 2);
  assert.equal(r3.stdout, '');
  assert.ok(r3.stderr.includes('无法表达'), `无法表达应说明原因：\n${r3.stderr}`);
});

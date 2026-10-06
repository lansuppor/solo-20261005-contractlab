// OpenAPI 请求正文约定导入（import 子命令）的回归测试
//
// 覆盖：
// - 基本转换：替换 POST 规则、移除无声明 POST 的旧规则、GET 不变、
//   保留接口顺序与 responses、additionalProperties 缺省显式输出、特殊字段名保留；
// - 本文件内 $ref：共享引用、JSON Pointer 转义、requestBody 级引用，
//   以及缺失目标 / 外部引用 / 循环引用（引用链定位）/ 引用节点带额外字段；
// - 纯对象 allOf：同名字段递归相交（number∩integer 取 integer）、必填并集、
//   各分支额外字段限制（禁止出现的字段被丢弃）、空交集与无法表达的拒绝；
// - 嵌套 allOf 整体交集：叶分支展平后对“全部分支”一次判定，结论与分支顺序、
//   嵌套分组、本文件内 $ref 无关（成功接受集合一致、失败一致）；中间两支
//   string∩integer 本不可表达时，再叠加封闭空对象分支后真实交集为只接受空对象
//   的封闭对象，必须成功；删除该分支才以“非空但无法表达”拒绝；必填冲突（整体
//   空交集）定位到禁止分支；字段最终被禁止也不忽略其中的非法值/未知关键字；
//   对象交集位于数组元素时遵循同一规则；成功输出用真实 serve 核对允许/拒绝正文；
// - 操作选择与 requestBody 错误矩阵、schema 错误矩阵；
// - 未选中操作与不可达定义不参与转换；
// - 成功输出可直接用于真实 serve 与 compare；
// - 失败一律退出 2、stderr 可定位（文件 + 操作/定义位置）、stdout 为空。

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  makeTempDir,
  runCli,
  runCompare,
  sceneResponse,
  SCENE_BODY,
  SCENE_STATUS,
  sendRequest,
  startServer,
  writeConfig,
  writeText,
} from './helpers.ts';

function runImport(openapi: string, config: string) {
  return runCli(['import', '--openapi', openapi, '--config', config]);
}

// 便捷构造：POST 操作的必填 JSON 正文
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

function postEndpoint(p: string, extra?: Record<string, unknown>): unknown {
  return { method: 'POST', path: p, responses: [sceneResponse()], ...extra };
}

// 解析成功输出：退出码必须为 0，stdout 必须是完整场景 JSON
function parseOutput(stdout: string): { endpoints: Record<string, unknown>[] } {
  const parsed = JSON.parse(stdout) as { endpoints: Record<string, unknown>[] };
  assert.ok(Array.isArray(parsed.endpoints), '输出必须是含 endpoints 数组的场景 JSON');
  return parsed;
}

// ---------------------------------------------------------------------------
// 基本转换
// ---------------------------------------------------------------------------

test('基本转换：替换 POST 规则、移除无声明的旧规则、GET 不变、保留顺序与 responses', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec({
    '/api/order': {
      get: { responses: {} },
      post: {
        requestBody: jsonBody({
          type: 'object',
          properties: {
            id: { type: 'integer' },
            note: { type: 'string', description: '注释', example: 'x', nullable: false },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['id'],
        }),
        responses: {},
      },
    },
    '/api/echo': { post: { responses: {} } },
  }));
  const config = await writeConfig(dir, 'scenes.json', sceneWith([
    { method: 'GET', path: '/api/order', responses: [sceneResponse()] },
    postEndpoint('/api/order', { requestBody: { type: 'string' } }),
    postEndpoint('/api/echo', { requestBody: { type: 'object' } }),
  ]));

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `应成功，stderr:\n${result.stderr}`);
  const out = parseOutput(result.stdout);

  // 接口顺序与 responses 原样保留
  assert.deepEqual(
    out.endpoints.map((ep) => `${ep.method} ${ep.path}`),
    ['GET /api/order', 'POST /api/order', 'POST /api/echo'],
  );
  for (const ep of out.endpoints) {
    assert.deepEqual(ep.responses, [sceneResponse()], 'responses 必须原样保留');
  }

  // GET 不携带规则
  assert.ok(!('requestBody' in out.endpoints[0]), 'GET 接口不得出现 requestBody');

  // POST /api/order：规则被替换；additionalProperties 缺省按 OpenAPI 允许并显式输出
  assert.deepEqual(out.endpoints[1].requestBody, {
    type: 'object',
    fields: {
      id: { type: 'integer', required: true },
      note: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: true,
  });

  // POST /api/echo：文档未声明请求体，旧规则被移除
  assert.ok(!('requestBody' in out.endpoints[2]), '未声明请求体时应移除旧规则');
});

test('特殊字段名（空名、__proto__、斜杠、波浪号）原样保留', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  // 注意：对象字面量中的 __proto__ 会被当作原型 setter，这里直接写 JSON 文本
  const api = await writeText(
    dir,
    'api.json',
    `{
  "openapi": "3.0.0",
  "paths": {
    "/a": { "post": { "requestBody": { "required": true, "content": { "application/json": { "schema": { "$ref": "#/components/schemas/weird~1name" } } } } } }
  },
  "components": {
    "schemas": {
      "weird/name": {
        "type": "object",
        "properties": {
          "": { "type": "integer" },
          "__proto__": { "type": "boolean" },
          "a/b~c": { "type": "string" }
        },
        "required": ["", "__proto__", "a/b~c"]
      }
    }
  }
}
`,
  );
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `应成功，stderr:\n${result.stderr}`);
  const out = parseOutput(result.stdout);
  // 期望值同样用 JSON.parse 构造，保证 __proto__ 是自有字段
  const expected = JSON.parse(`{
    "type": "object",
    "fields": {
      "": { "type": "integer", "required": true },
      "__proto__": { "type": "boolean", "required": true },
      "a/b~c": { "type": "string", "required": true }
    },
    "additionalProperties": true
  }`);
  assert.deepEqual(out.endpoints[0].requestBody, expected);
  // 序列化后的输出文本中 __proto__ 必须是自有字段（重新解析仍存在）
  const reparsed = JSON.parse(result.stdout) as { endpoints: Array<{ requestBody?: { fields?: object } }> };
  assert.ok(
    Object.prototype.hasOwnProperty.call(reparsed.endpoints[0].requestBody?.fields, '__proto__'),
    '输出 JSON 中的 __proto__ 必须是自有字段',
  );
});

// ---------------------------------------------------------------------------
// $ref
// ---------------------------------------------------------------------------

test('$ref：共享引用、嵌套引用与 requestBody 级引用', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec(
    {
      '/a': {
        post: {
          // requestBody 本身也是本文件内 $ref
          requestBody: { $ref: '#/components/requestBodies/Named' },
        },
      },
    },
    {
      schemas: {
        Name: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
        // 间接引用：Alias -> Name
        Alias: { $ref: '#/components/schemas/Name' },
        Pair: {
          type: 'object',
          properties: {
            // 共享引用：同一 schema 被两处使用
            first: { $ref: '#/components/schemas/Name' },
            second: { $ref: '#/components/schemas/Alias' },
            history: { type: 'array', items: { $ref: '#/components/schemas/Name' } },
          },
        },
      },
      requestBodies: {
        Named: {
          description: '忽略的描述',
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Pair' } } },
        },
      },
    },
  ));
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `应成功，stderr:\n${result.stderr}`);
  const nameRule = {
    type: 'object',
    fields: { name: { type: 'string', required: true } },
    additionalProperties: false,
  };
  assert.deepEqual(parseOutput(result.stdout).endpoints[0].requestBody, {
    type: 'object',
    fields: {
      first: nameRule,
      second: nameRule,
      history: { type: 'array', items: nameRule },
    },
    additionalProperties: true,
  });
});

test('$ref 错误：外部引用、缺失目标、循环引用（链定位）、引用节点带额外字段', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));

  const cases: Array<{ name: string; schema: unknown; components?: unknown; expect: RegExp }> = [
    {
      name: '外部引用',
      schema: { $ref: './other.json#/A' },
      expect: /仅支持本文件内 \$ref/,
    },
    {
      name: '缺失目标',
      schema: { $ref: '#/components/schemas/Missing' },
      components: { schemas: {} },
      expect: /目标不存在/,
    },
    {
      name: '循环引用',
      schema: { $ref: '#/components/schemas/A' },
      components: {
        schemas: {
          A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
          B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } },
        },
      },
      expect: /循环 \$ref 引用：#\/components\/schemas\/A -> #\/components\/schemas\/B -> #\/components\/schemas\/A/,
    },
    {
      name: '引用节点带额外字段',
      schema: { $ref: '#/components/schemas/A', type: 'object' },
      components: { schemas: { A: { type: 'object' } } },
      expect: /不得包含其他字段/,
    },
  ];

  for (const c of cases) {
    const api = await writeConfig(
      dir,
      `api-${c.name}.json`,
      spec({ '/a': { post: { requestBody: jsonBody(c.schema) } } }, c.components),
    );
    const result = await runImport(api, config);
    assert.equal(result.code, 2, `${c.name}：应退出 2\nstdout:\n${result.stdout}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(result.stderr.includes(api), `${c.name}：stderr 应指明文件：\n${result.stderr}`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位原因：\n${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 纯对象 allOf
// ---------------------------------------------------------------------------

test('allOf：递归相交、number∩integer 取 integer、必填并集、额外字段限制', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec(
    {
      '/a': {
        post: {
          requestBody: jsonBody({
            // 组合节点可带注释；分支可引用或嵌套组合
            title: '组合',
            allOf: [
              { $ref: '#/components/schemas/Base' },
              {
                allOf: [
                  {
                    type: 'object',
                    properties: {
                      id: { type: 'integer' },
                      x: { type: 'integer' },
                      name: { type: 'string' },
                      nested: { type: 'object', properties: { v: { type: 'number' } } },
                    },
                    required: ['name'],
                    additionalProperties: false,
                  },
                ],
              },
            ],
          }),
        },
      },
    },
    {
      schemas: {
        Base: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            x: { type: 'number' },
            name: { type: 'string' },
            gone: { type: 'string' },
            nested: { type: 'object', properties: { v: { type: 'integer' } } },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
  ));
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `应成功，stderr:\n${result.stderr}`);
  assert.deepEqual(parseOutput(result.stdout).endpoints[0].requestBody, {
    type: 'object',
    fields: {
      id: { type: 'integer', required: true },
      // number ∩ integer 取 integer
      x: { type: 'integer' },
      // 必填并集：id（分支一）+ name（分支二）
      name: { type: 'string', required: true },
      // 同名字段递归交集
      nested: {
        type: 'object',
        fields: { v: { type: 'integer' } },
        additionalProperties: true,
      },
      // gone 被分支二禁止出现（未声明且 additionalProperties:false），不留在结果中
    },
    additionalProperties: false,
  });
  const rule = parseOutput(result.stdout).endpoints[0].requestBody as { fields: Record<string, unknown> };
  assert.ok(!('gone' in rule.fields), '被某分支禁止出现的字段不得留在结果中');
});

test('allOf 拒绝：非对象分支、空交集与无法表达的情形', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));

  const cases: Array<{ name: string; schema: unknown; expect: RegExp }> = [
    {
      name: '非对象分支',
      schema: { allOf: [{ type: 'object' }, { type: 'string' }] },
      expect: /纯对象 allOf/,
    },
    {
      name: '必填字段被另一分支禁止出现',
      schema: {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
          { type: 'object', properties: {}, additionalProperties: false },
        ],
      },
      expect: /交集为空/,
    },
    {
      name: '同名字段类型相交为空（必填）',
      schema: {
        allOf: [
          { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
          { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] },
        ],
      },
      expect: /交集为空/,
    },
    {
      name: '可选字段交集为空但所有分支允许额外字段（无法表达）',
      schema: {
        allOf: [
          { type: 'object', properties: { x: { type: 'string' } } },
          { type: 'object', properties: { x: { type: 'integer' } } },
        ],
      },
      expect: /无法表达/,
    },
    {
      name: '数组元素交集为空（无法表达）',
      schema: {
        allOf: [
          { type: 'object', properties: { xs: { type: 'array', items: { type: 'string' } } }, required: ['xs'] },
          { type: 'object', properties: { xs: { type: 'array', items: { type: 'integer' } } }, required: ['xs'] },
        ],
      },
      expect: /无法表达/,
    },
    {
      name: '组合节点带 type',
      schema: { allOf: [{ type: 'object' }], type: 'object' },
      expect: /未支持的关键字 "type"/,
    },
  ];

  for (const c of cases) {
    const api = await writeConfig(
      dir,
      `api-${c.name}.json`,
      spec({ '/a': { post: { requestBody: jsonBody(c.schema) } } }),
    );
    const result = await runImport(api, config);
    assert.equal(result.code, 2, `${c.name}：应退出 2\nstdout:\n${result.stdout}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位原因：\n${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 嵌套 allOf：整体交集的顺序/分组/引用不变性、必填冲突、最终无法表达与定位
// ---------------------------------------------------------------------------

// 任务原例：三个“开放”对象分支都声明可选 box；box 前两支开放、x 分别为
// string / integer，第三支 box 不声明内部字段且拒绝额外字段。
function boxBranch(x: unknown): unknown {
  return {
    type: 'object',
    additionalProperties: true,
    properties: { box: { type: 'object', additionalProperties: true, properties: { x } } },
  };
}
const BOX_B1 = boxBranch({ type: 'string' });
const BOX_B2 = boxBranch({ type: 'integer' });
const BOX_B3 = {
  type: 'object',
  additionalProperties: true,
  properties: { box: { type: 'object', additionalProperties: false, properties: {} } },
};
const BOX_EXPECTED = {
  type: 'object',
  fields: { box: { type: 'object', fields: {}, additionalProperties: false } },
  additionalProperties: true,
};

// 数组元素版：box 为数组，元素是同样的三分支对象
const ARR_BRANCHES = [
  { type: 'object', additionalProperties: true, properties: { box: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { x: { type: 'string' } } } } } },
  { type: 'object', additionalProperties: true, properties: { box: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { x: { type: 'integer' } } } } } },
  { type: 'object', additionalProperties: true, properties: { box: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {} } } } },
];
const ARR_EXPECTED = {
  type: 'object',
  fields: {
    box: { type: 'array', items: { type: 'object', fields: {}, additionalProperties: false } },
  },
  additionalProperties: true,
};

test('嵌套 allOf：三分支顺序、嵌套分组、$ref 均不改变成功结论与接受集合', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);

  // 同一份三分支交集的多种等价写法（flat 全排列 + 各种嵌套分组 + 本文件内 $ref）
  const variants: Array<{ name: string; schema: unknown; components?: unknown }> = [
    ...[
      [BOX_B1, BOX_B2, BOX_B3],
      [BOX_B1, BOX_B3, BOX_B2],
      [BOX_B2, BOX_B1, BOX_B3],
      [BOX_B2, BOX_B3, BOX_B1],
      [BOX_B3, BOX_B1, BOX_B2],
      [BOX_B3, BOX_B2, BOX_B1],
    ].map((branches, i) => ({ name: `flat 排列 ${i}`, schema: { allOf: branches } })),
    { name: '前两支先成组', schema: { allOf: [{ allOf: [BOX_B1, BOX_B2] }, BOX_B3] } },
    { name: '后两支先成组', schema: { allOf: [BOX_B1, { allOf: [BOX_B2, BOX_B3] }] } },
    { name: '两侧都成组', schema: { allOf: [{ allOf: [BOX_B1] }, { allOf: [BOX_B2, BOX_B3] }] } },
    { name: '三层嵌套', schema: { allOf: [{ allOf: [{ allOf: [BOX_B1] }, BOX_B2] }, BOX_B3] } },
    {
      name: '本文件内 $ref',
      schema: {
        allOf: [
          { $ref: '#/components/schemas/Box1' },
          { $ref: '#/components/schemas/Box2' },
          { $ref: '#/components/schemas/Box3' },
        ],
      },
      components: { schemas: { Box1: BOX_B1, Box2: BOX_B2, Box3: BOX_B3 } },
    },
    {
      name: '嵌套分组混合 $ref',
      schema: {
        allOf: [
          { allOf: [{ $ref: '#/components/schemas/Box1' }, { $ref: '#/components/schemas/Box2' }] },
          { $ref: '#/components/schemas/Box3' },
        ],
      },
      components: { schemas: { Box1: BOX_B1, Box2: BOX_B2, Box3: BOX_B3 } },
    },
  ];

  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));
  for (const v of variants) {
    const api = await writeConfig(
      dir,
      `api-${v.name.replace(/[^\p{L}\p{N}]+/gu, '_')}.json`,
      spec({ '/a': { post: { requestBody: jsonBody(v.schema) } } }, v.components),
    );
    const result = await runImport(api, config);
    assert.equal(result.code, 0, `${v.name}：应成功，stderr:\n${result.stderr}`);
    assert.deepEqual(
      parseOutput(result.stdout).endpoints[0].requestBody,
      BOX_EXPECTED,
      `${v.name}：接受集合（输出规则）必须与其他等价写法一致`,
    );
  }

  // 数组元素版同样成功（flat 与嵌套各一）
  for (const [i, schema] of [
    { allOf: ARR_BRANCHES },
    { allOf: [{ allOf: [ARR_BRANCHES[0], ARR_BRANCHES[1]] }, ARR_BRANCHES[2]] },
  ].entries()) {
    const api = await writeConfig(dir, `api-arr-${i}.json`, spec({ '/a': { post: { requestBody: jsonBody(schema) } } }));
    const result = await runImport(api, config);
    assert.equal(result.code, 0, `数组元素版 ${i}：应成功，stderr:\n${result.stderr}`);
    assert.deepEqual(parseOutput(result.stdout).endpoints[0].requestBody, ARR_EXPECTED);
  }
});

test('嵌套 allOf：删除第三支则非空但无法表达，退出 2 且定位文件/操作/字段', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));

  // 只剩前两支：box.x 的 string∩integer 为空且各方都允许额外字段，无法表达；
  // flat 与“两层嵌套”都必须拒绝（旧实现会在嵌套内层直接拒绝三分支版）。
  for (const [i, schema] of [
    { allOf: [BOX_B1, BOX_B2] },
    { allOf: [{ allOf: [BOX_B1, BOX_B2] }] },
  ].entries()) {
    const api = await writeConfig(dir, `api-two-${i}.json`, spec({ '/a': { post: { requestBody: jsonBody(schema) } } }));
    const result = await runImport(api, config);
    assert.equal(result.code, 2, `两分支版 ${i}：应退出 2\nstdout:\n${result.stdout}`);
    assert.equal(result.stdout, '', '失败时 stdout 必须为空');
    assert.ok(result.stderr.includes(api), 'stderr 应指明输入文件');
    assert.ok(result.stderr.includes('paths["/a"].post.requestBody'), `stderr 应定位操作：\n${result.stderr}`);
    assert.ok(result.stderr.includes('"box"'), `stderr 应指明冲突字段 box：\n${result.stderr}`);
    assert.ok(/无法表达/.test(result.stderr), `stderr 应说明无法表达：\n${result.stderr}`);
  }
});

test('嵌套 allOf：必填字段被另一分支禁止（整体空交集）退出 2 并定位禁止分支', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec({
    '/a': {
      post: {
        requestBody: jsonBody({
          allOf: [
            { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } }, required: ['x'] },
            // 嵌套分组内的封闭空对象禁止 x 出现
            { allOf: [{ type: 'object', additionalProperties: false, properties: {} }] },
          ],
        }),
      },
    },
  }));
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));
  const result = await runImport(api, config);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(api));
  assert.ok(/交集为空/.test(result.stderr), `应判为整体空交集：\n${result.stderr}`);
  assert.ok(result.stderr.includes('"x"'), `应指出冲突字段 x：\n${result.stderr}`);
  // 定位到贡献该结论的嵌套叶分支（allOf[1].allOf[0]）
  assert.ok(result.stderr.includes('allOf[1].allOf[0]'), `应定位到嵌套叶分支：\n${result.stderr}`);
});

test('嵌套 allOf：字段最终被禁止也不忽略其中的非法 schema（非法值/未知关键字仍拒绝）', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));

  const cases: Array<{ name: string; schema: unknown; expect: RegExp }> = [
    // x 虽被第二支封闭分支“禁止出现”，但第一支 x 的类型非法，仍须拒绝
    {
      name: '被禁止字段含非法类型',
      schema: {
        allOf: [
          { type: 'object', additionalProperties: true, properties: { x: { type: 'null' } } },
          { type: 'object', additionalProperties: false, properties: {} },
        ],
      },
      expect: /\.type/,
    },
    // 同上：未知关键字也不能因字段最终消失而忽略
    {
      name: '被禁止字段含未知关键字',
      schema: {
        allOf: [
          { type: 'object', additionalProperties: true, properties: { x: { type: 'string', format: 'email' } } },
          { type: 'object', additionalProperties: false, properties: {} },
        ],
      },
      expect: /未支持的关键字 "format"/,
    },
  ];

  for (const c of cases) {
    const api = await writeConfig(dir, `api-${c.name}.json`, spec({ '/a': { post: { requestBody: jsonBody(c.schema) } } }));
    const result = await runImport(api, config);
    assert.equal(result.code, 2, `${c.name}：应退出 2\nstdout:\n${result.stdout}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位非法点：\n${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 操作选择与 requestBody 错误
// ---------------------------------------------------------------------------

test('操作选择错误：缺少路径、缺少方法、GET 声明正文', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec({
    '/exists': { get: { requestBody: jsonBody({ type: 'object' }) } },
  }));
  const missingPath = await writeConfig(dir, 'missing-path.json', sceneWith([postEndpoint('/nope')]));
  const missingMethod = await writeConfig(dir, 'missing-method.json', sceneWith([postEndpoint('/exists')]));
  const getWithBody = await writeConfig(dir, 'get-with-body.json', sceneWith([
    { method: 'GET', path: '/exists', responses: [sceneResponse()] },
  ]));

  const r1 = await runImport(api, missingPath);
  assert.equal(r1.code, 2);
  assert.equal(r1.stdout, '');
  assert.ok(r1.stderr.includes('"/nope"'), `应定位缺失路径：\n${r1.stderr}`);

  const r2 = await runImport(api, missingMethod);
  assert.equal(r2.code, 2);
  assert.equal(r2.stdout, '');
  assert.ok(r2.stderr.includes('post 操作不存在'), `应定位缺失方法：\n${r2.stderr}`);

  const r3 = await runImport(api, getWithBody);
  assert.equal(r3.code, 2);
  assert.equal(r3.stdout, '');
  assert.ok(r3.stderr.includes('GET 操作不允许声明请求正文'), `应拒绝 GET 正文：\n${r3.stderr}`);
});

test('requestBody 错误：required 非 true、content 不符、缺 schema', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));

  const bodies: Array<{ name: string; body: unknown; expect: RegExp }> = [
    { name: 'required 缺失', body: { content: { 'application/json': { schema: { type: 'object' } } } }, expect: /required 必须为 true/ },
    { name: 'required 为 false', body: { required: false, content: { 'application/json': { schema: { type: 'object' } } } }, expect: /required 必须为 true/ },
    { name: '多种媒体类型', body: { required: true, content: { 'application/json': { schema: { type: 'object' } }, 'text/plain': { schema: { type: 'string' } } } }, expect: /application\/json/ },
    { name: '无 application/json', body: { required: true, content: { 'application/xml': { schema: { type: 'object' } } } }, expect: /application\/json/ },
    { name: '缺 schema', body: { required: true, content: { 'application/json': { example: {} } } }, expect: /缺少 schema/ },
  ];

  for (const [i, c] of bodies.entries()) {
    const api = await writeConfig(
      dir,
      `api-rb-${i}.json`,
      spec({ '/a': { post: { requestBody: c.body } } }),
    );
    const result = await runImport(api, config);
    assert.equal(result.code, 2, `${c.name}：应退出 2`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位原因：\n${result.stderr}`);
    assert.ok(
      result.stderr.includes('paths["/a"].post.requestBody'),
      `${c.name}：stderr 应给出操作位置：\n${result.stderr}`,
    );
  }
});

// ---------------------------------------------------------------------------
// schema 错误矩阵
// ---------------------------------------------------------------------------

test('schema 错误：缺 type、非法类型、未知关键字、nullable:true、required/items/additionalProperties 非法', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));

  const cases: Array<{ name: string; schema: unknown; expect: RegExp }> = [
    { name: '缺 type', schema: { properties: {} }, expect: /\.type/ },
    { name: 'type 为 null 类型', schema: { type: 'null' }, expect: /\.type/ },
    { name: '未知关键字 format', schema: { type: 'string', format: 'email' }, expect: /未支持的关键字 "format"/ },
    { name: '未知关键字 minLength', schema: { type: 'string', minLength: 1 }, expect: /未支持的关键字 "minLength"/ },
    { name: 'object 带 items', schema: { type: 'object', items: { type: 'string' } }, expect: /未支持的关键字 "items"/ },
    { name: 'nullable true', schema: { type: 'string', nullable: true }, expect: /nullable/ },
    { name: 'required 未在同层声明', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, expect: /未在同层 properties 中声明/ },
    { name: 'required 重复', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'] }, expect: /重复/ },
    { name: 'required 非字符串', schema: { type: 'object', properties: {}, required: [1] }, expect: /required\[0\]/ },
    { name: '数组缺 items', schema: { type: 'array' }, expect: /items/ },
    { name: 'additionalProperties 非布尔', schema: { type: 'object', additionalProperties: { type: 'string' } }, expect: /additionalProperties/ },
    { name: '标量带 properties', schema: { type: 'string', properties: {} }, expect: /未支持的关键字 "properties"/ },
  ];

  for (const c of cases) {
    const api = await writeConfig(
      dir,
      `api-schema-${c.name}.json`,
      spec({ '/a': { post: { requestBody: jsonBody(c.schema) } } }),
    );
    const result = await runImport(api, config);
    assert.equal(result.code, 2, `${c.name}：应退出 2\nstdout:\n${result.stdout}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位原因：\n${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 未选中操作与不可达定义不参与转换
// ---------------------------------------------------------------------------

test('未选中操作与不可达定义中的错误不影响结果', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', {
    openapi: '3.0.0',
    paths: {
      '/used': { post: { requestBody: jsonBody({ type: 'object', properties: { id: { type: 'integer' } } }) } },
      // 未选中的路径：requestBody 完全非法也不参与转换
      '/unused': { post: { requestBody: { required: false, content: { 'text/plain': {} } } } },
      // 未选中的方法：GET 声明正文也不参与转换
      '/also-unused': { get: { requestBody: jsonBody({ type: 'null' }) } },
    },
    components: {
      schemas: {
        // 不可达定义：非法 schema 不影响
        Garbage: { type: 'null', minLength: -1 },
      },
    },
  });
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/used')]));

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `未选中部分的错误不应影响结果，stderr:\n${result.stderr}`);
  assert.deepEqual(parseOutput(result.stdout).endpoints[0].requestBody, {
    type: 'object',
    fields: { id: { type: 'integer' } },
    additionalProperties: true,
  });
});

// ---------------------------------------------------------------------------
// 输入文件失败
// ---------------------------------------------------------------------------

test('输入失败：场景校验失败、OpenAPI 解析失败、版本不符、缺 paths', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const goodApi = await writeConfig(dir, 'api.json', spec({
    '/a': { post: { requestBody: jsonBody({ type: 'object' }) } },
  }));
  const goodScene = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/a')]));

  // 场景配置非法（未知字段）
  const badScene = await writeConfig(dir, 'bad-scene.json', {
    endpoints: [{ method: 'POST', path: '/a', responses: [sceneResponse()], bogus: 1 }],
  });
  const r1 = await runImport(goodApi, badScene);
  assert.equal(r1.code, 2);
  assert.equal(r1.stdout, '');
  assert.ok(r1.stderr.includes(badScene), `应指明场景文件：\n${r1.stderr}`);
  assert.ok(r1.stderr.includes('未知字段'), `应给出校验原因：\n${r1.stderr}`);

  // OpenAPI 不是合法 JSON
  const badJson = await writeText(dir, 'bad-api.json', '{ "openapi": ');
  const r2 = await runImport(badJson, goodScene);
  assert.equal(r2.code, 2);
  assert.equal(r2.stdout, '');
  assert.ok(r2.stderr.includes(badJson), `应指明 OpenAPI 文件：\n${r2.stderr}`);

  // 版本不符
  const wrongVersion = await writeConfig(dir, 'v31.json', { openapi: '3.1.0', paths: {} });
  const r3 = await runImport(wrongVersion, goodScene);
  assert.equal(r3.code, 2);
  assert.equal(r3.stdout, '');
  assert.ok(/3\.0/.test(r3.stderr), `应说明仅支持 3.0.x：\n${r3.stderr}`);

  // 缺 paths
  const noPaths = await writeConfig(dir, 'no-paths.json', { openapi: '3.0.0' });
  const r4 = await runImport(noPaths, goodScene);
  assert.equal(r4.code, 2);
  assert.equal(r4.stdout, '');
  assert.ok(r4.stderr.includes('paths'), `应定位 paths：\n${r4.stderr}`);

  // 文件不存在
  const r5 = await runImport(path.join(dir, 'missing.json'), goodScene);
  assert.equal(r5.code, 2);
  assert.equal(r5.stdout, '');
});

test('命令行参数错误：缺参数、未知参数退出 2', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec({}));

  const r1 = await runCli(['import', '--openapi', api]);
  assert.equal(r1.code, 2);
  assert.equal(r1.stdout, '');

  const r2 = await runCli(['import', '--openapi', api, '--config', api, '--bogus']);
  assert.equal(r2.code, 2);
  assert.equal(r2.stdout, '');
});

// ---------------------------------------------------------------------------
// 输出可直接用于 serve 与 compare
// ---------------------------------------------------------------------------

test('成功输出可用于真实 serve 与 compare', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec({
    '/api/order': {
      post: {
        requestBody: jsonBody({
          type: 'object',
          properties: {
            id: { type: 'integer' },
            buyer: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
              additionalProperties: false,
            },
          },
          required: ['id', 'buyer'],
          additionalProperties: false,
        }),
      },
    },
  }));
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/api/order')]));

  const imported = await runImport(api, config);
  assert.equal(imported.code, 0, `导入应成功，stderr:\n${imported.stderr}`);
  const outFile = await writeText(dir, 'out.json', imported.stdout);

  // compare 可以直接读取输出
  const cmp = await runCompare(outFile, outFile);
  assert.equal(cmp.code, 0, `输出应能被 compare 接受，stderr:\n${cmp.stderr}`);

  // serve 可以直接加载输出并按导入的规则校验
  const server = await startServer(outFile);
  try {
    const ok = await sendRequest(server.port, {
      method: 'POST',
      path: '/api/order',
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":1,"buyer":{"name":"ann"}}',
    });
    assert.equal(ok.status, SCENE_STATUS, `合格请求应得到场景响应：${ok.status} ${ok.body}`);
    assert.equal(ok.body, SCENE_BODY);

    const bad = await sendRequest(server.port, {
      method: 'POST',
      path: '/api/order',
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":"oops","buyer":{"name":"ann"},"extra":1}',
    });
    assert.equal(bad.status, 400, `结构差异应被 400 拒绝：${bad.status} ${bad.body}`);
    const report = JSON.parse(bad.body) as { problems: Array<{ pointer: string }> };
    const pointers = report.problems.map((p) => p.pointer).sort();
    assert.deepEqual(pointers, ['/extra', '/id']);
  } finally {
    await server.close();
  }
});

test('嵌套三分支成功输出用于真实 serve：核对 box 允许/拒绝的正文', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  // 任务原例（用一种嵌套分组写法，验证展平后的真实接受集合）
  const schema = {
    allOf: [
      { allOf: [BOX_B1, BOX_B2] },
      BOX_B3,
    ],
  };
  const api = await writeConfig(dir, 'api.json', spec({ '/api/box': { post: { requestBody: jsonBody(schema) } } }));
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/api/box')]));

  const imported = await runImport(api, config);
  assert.equal(imported.code, 0, `导入应成功，stderr:\n${imported.stderr}`);
  const outFile = await writeText(dir, 'out.json', imported.stdout);

  // 输出自比较必然兼容，可直接给 compare 使用
  const cmp = await runCompare(outFile, outFile);
  assert.equal(cmp.code, 0, `输出应能被 compare 接受，stderr:\n${cmp.stderr}`);

  const server = await startServer(outFile);
  const post = (body: string) =>
    sendRequest(server.port, {
      method: 'POST',
      path: '/api/box',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  try {
    // 允许：省略 box
    for (const body of ['{}', '{"other":1}', '{"box":{}}', '{"box":{},"z":true}']) {
      const r = await post(body);
      assert.equal(r.status, SCENE_STATUS, `应接受 ${body}，实际：${r.status} ${r.body}`);
      assert.equal(r.body, SCENE_BODY);
    }

    // 拒绝：box 中任何字段（x 取 string / integer 都不行；其他字段也被第三支拒绝）
    const rejected: Array<{ body: string; pointers: string[] }> = [
      { body: '{"box":{"x":"s"}}', pointers: ['/box/x'] },
      { body: '{"box":{"x":1}}', pointers: ['/box/x'] },
      { body: '{"box":{"y":1}}', pointers: ['/box/y'] },
      { body: '{"box":{"x":"s","y":1}}', pointers: ['/box/x', '/box/y'] },
    ];
    for (const c of rejected) {
      const r = await post(c.body);
      assert.equal(r.status, 400, `${c.body} 应被 400 拒绝，实际：${r.status} ${r.body}`);
      const report = JSON.parse(r.body) as { problems: Array<{ pointer: string }> };
      assert.deepEqual(report.problems.map((p) => p.pointer).sort(), c.pointers);
    }
  } finally {
    await server.close();
  }
});

test('数组元素三分支成功输出用于真实 serve：元素仅接受空对象', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec({
    '/api/arr': { post: { requestBody: jsonBody({ allOf: ARR_BRANCHES }) } },
  }));
  const config = await writeConfig(dir, 'scenes.json', sceneWith([postEndpoint('/api/arr')]));

  const imported = await runImport(api, config);
  assert.equal(imported.code, 0, `导入应成功，stderr:\n${imported.stderr}`);
  const outFile = await writeText(dir, 'out.json', imported.stdout);
  const server = await startServer(outFile);
  const post = (body: string) =>
    sendRequest(server.port, {
      method: 'POST',
      path: '/api/arr',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  try {
    for (const body of ['{}', '{"box":[]}', '{"box":[{},{}]}', '{"box":[{}],"extra":0}']) {
      const r = await post(body);
      assert.equal(r.status, SCENE_STATUS, `应接受 ${body}，实际：${r.status} ${r.body}`);
    }
    const rejected: Array<{ body: string; pointer: string }> = [
      { body: '{"box":[{"x":"s"}]}', pointer: '/box/0/x' },
      { body: '{"box":[{"x":1}]}', pointer: '/box/0/x' },
      { body: '{"box":[{},{"y":2}]}', pointer: '/box/1/y' },
    ];
    for (const c of rejected) {
      const r = await post(c.body);
      assert.equal(r.status, 400, `${c.body} 应被 400 拒绝，实际：${r.status} ${r.body}`);
      const report = JSON.parse(r.body) as { problems: Array<{ pointer: string }> };
      assert.deepEqual(report.problems.map((p) => p.pointer), [c.pointer]);
    }
  } finally {
    await server.close();
  }
});

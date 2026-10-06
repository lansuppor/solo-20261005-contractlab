// OpenAPI 请求正文约定导入（import 子命令）的回归测试
//
// 覆盖：基本转换与显式 additionalProperties、接口顺序与 responses 保留、
// 未声明请求体时移除旧规则、共享/缺失/外部/循环 $ref（引用链定位）、
// 纯对象 allOf 交集（同名字段递归相交、number∩integer、必填合并、额外字段取严、
// 空交集拒绝）、特殊字段名保留、未选操作与不可达定义不参与转换、
// 各类非法输入退出 2 且 stdout 为空，以及导入结果可直接用于 serve 与 compare。

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import {
  SCENE_BODY,
  SCENE_STATUS,
  makeTempDir,
  runCli,
  runCompare,
  sceneResponse,
  sendRequest,
  startServer,
  writeConfig,
  writeText,
} from './helpers.ts';

function runImport(openapiFile: string, configFile: string): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return runCli(['import', '--openapi', openapiFile, '--config', configFile]);
}

// 最小合法场景：单个 POST 接口 + 一个可辨认的场景响应
function scenarioWith(endpoints: unknown[]): unknown {
  return { endpoints };
}

function postEndpoint(routePath: string, extra?: Record<string, unknown>): unknown {
  return { method: 'POST', path: routePath, responses: [sceneResponse()], ...extra };
}

// 最小合法 OpenAPI 文档骨架
function docWith(paths: unknown, components?: unknown): unknown {
  const doc: Record<string, unknown> = { openapi: '3.0.3', paths };
  if (components !== undefined) {
    doc.components = components;
  }
  return doc;
}

function jsonRequestBody(schema: unknown): unknown {
  return { required: true, content: { 'application/json': { schema } } };
}

// 解析 import 成功输出（断言退出码与可解析性后返回场景对象）
function parseImported(result: { code: number; stdout: string; stderr: string }): {
  endpoints: Record<string, unknown>[];
} {
  assert.equal(result.code, 0, `import 应成功退出 0，实际 ${result.code}\nstderr:\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { endpoints: Record<string, unknown>[] };
  assert.ok(Array.isArray(parsed.endpoints), '输出必须是含 endpoints 数组的场景对象');
  return parsed;
}

test('基本转换：仅替换 requestBody，保留接口顺序与 responses，显式输出额外字段策略', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const doc = docWith({
    '/api/order': {
      post: {
        requestBody: jsonRequestBody({
          type: 'object',
          properties: {
            id: { type: 'integer' },
            note: { type: 'string', title: '备注', description: '注释可忽略', example: 'x' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['id'],
          additionalProperties: false,
          nullable: false,
        }),
      },
    },
    '/api/user': { get: {} },
    '/api/echo': { post: {} },
  });
  const oldResponses = [{ status: 200, headers: { 'X-Old': '1' }, body: 'old', delay: 5 }];
  const scenario = scenarioWith([
    { method: 'POST', path: '/api/order', requestBody: { type: 'string' }, responses: [sceneResponse()] },
    { method: 'GET', path: '/api/user', responses: oldResponses },
    { method: 'POST', path: '/api/echo', requestBody: { type: 'integer' }, responses: [sceneResponse()] },
  ]);
  const apiFile = await writeConfig(dir, 'api.json', doc);
  const configFile = await writeConfig(dir, 'scenes.json', scenario);

  const result = parseImported(await runImport(apiFile, configFile));
  assert.equal(result.endpoints.length, 3, '接口数量不变');

  // 接口顺序与 method/path 保留
  assert.deepEqual(
    result.endpoints.map((ep) => `${ep.method} ${ep.path}`),
    ['POST /api/order', 'GET /api/user', 'POST /api/echo'],
  );

  // POST /api/order：旧规则被替换为文档约定
  assert.deepEqual(result.endpoints[0].requestBody, {
    type: 'object',
    fields: {
      id: { type: 'integer', required: true },
      note: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  });
  // responses 原样保留（含自定义头与延迟）
  assert.deepEqual(result.endpoints[1].responses, oldResponses);
  // GET 无 requestBody；POST 未声明请求体时移除旧规则
  assert.ok(!('requestBody' in result.endpoints[1]), 'GET 接口不得带 requestBody');
  assert.ok(!('requestBody' in result.endpoints[2]), '文档未声明请求体时应移除旧规则');
});

test('缺省 additionalProperties 按 OpenAPI 允许并显式输出 true', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const doc = docWith({
    '/a': { post: { requestBody: jsonRequestBody({ type: 'object', properties: { x: { type: 'number' } } }) } },
  });
  const apiFile = await writeConfig(dir, 'api.json', doc);
  const configFile = await writeConfig(dir, 'scenes.json', scenarioWith([postEndpoint('/a')]));

  const result = parseImported(await runImport(apiFile, configFile));
  assert.deepEqual(result.endpoints[0].requestBody, {
    type: 'object',
    fields: { x: { type: 'number' } },
    additionalProperties: true,
  });
});

test('共享 $ref 只转换一次且结果一致；嵌套引用链可达', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const doc = docWith(
    {
      '/a': { post: { requestBody: jsonRequestBody({ $ref: '#/components/schemas/Order' }) } },
      '/b': { post: { requestBody: jsonRequestBody({ $ref: '#/components/schemas/Order' }) } },
    },
    {
      schemas: {
        Order: {
          type: 'object',
          properties: { buyer: { $ref: '#/components/schemas/Buyer' } },
          required: ['buyer'],
        },
        Buyer: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    },
  );
  const apiFile = await writeConfig(dir, 'api.json', doc);
  const configFile = await writeConfig(
    dir,
    'scenes.json',
    scenarioWith([postEndpoint('/a'), postEndpoint('/b')]),
  );

  const result = parseImported(await runImport(apiFile, configFile));
  const expected = {
    type: 'object',
    fields: {
      buyer: {
        type: 'object',
        fields: { name: { type: 'string', required: true } },
        additionalProperties: true,
        required: true,
      },
    },
    additionalProperties: true,
  };
  assert.deepEqual(result.endpoints[0].requestBody, expected);
  assert.deepEqual(result.endpoints[1].requestBody, expected, '共享引用转换结果一致');
});

test('$ref 拒绝：目标缺失、外部引用、循环引用均定位引用链', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', scenarioWith([postEndpoint('/a')]));

  const cases: Array<{ name: string; schema: unknown; components?: unknown; expect: RegExp }> = [
    {
      name: '目标缺失',
      schema: { $ref: '#/components/schemas/Nope' },
      expect: /目标缺失.*#\/components\/schemas\/Nope/s,
    },
    {
      name: '外部引用',
      schema: { $ref: 'https://example.com/other.json#/Thing' },
      expect: /外部引用|本文件内/s,
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
      expect: /循环引用.*#\/components\/schemas\/A.*#\/components\/schemas\/B.*#\/components\/schemas\/A/s,
    },
    {
      name: '引用节点含其他字段',
      schema: { $ref: '#/components/schemas/A', type: 'object' },
      components: { schemas: { A: { type: 'object' } } },
      expect: /只含 \$ref|不得与其他字段并存/,
    },
  ];

  for (const c of cases) {
    const doc = docWith({ '/a': { post: { requestBody: jsonRequestBody(c.schema) } } }, c.components);
    const apiFile = await writeConfig(dir, `api-${c.name}.json`, doc);
    const result = await runImport(apiFile, configFile);
    assert.equal(result.code, 2, `${c.name}：应退出 2，实际 ${result.code}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(result.stderr.includes(apiFile), `${c.name}：stderr 应指明文件：\n${result.stderr}`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位引用链：\n${result.stderr}`);
  }
});

test('纯对象 allOf：同名字段递归交集、number∩integer 取 integer、必填合并、额外字段取严', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const doc = docWith(
    {
      '/x': {
        post: {
          requestBody: jsonRequestBody({
            allOf: [
              { $ref: '#/components/schemas/A' },
              { allOf: [{ $ref: '#/components/schemas/B' }], description: '嵌套组合' },
            ],
          }),
        },
      },
    },
    {
      schemas: {
        A: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'string' },
            z: { type: 'boolean' },
          },
          required: ['x'],
          additionalProperties: false,
        },
        B: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            z: { type: 'boolean' },
            w: { type: 'string' },
          },
          required: ['z'],
        },
      },
    },
  );
  const apiFile = await writeConfig(dir, 'api.json', doc);
  const configFile = await writeConfig(dir, 'scenes.json', scenarioWith([postEndpoint('/x')]));

  const result = parseImported(await runImport(apiFile, configFile));
  assert.deepEqual(result.endpoints[0].requestBody, {
    type: 'object',
    fields: {
      // number ∩ integer 取 integer；必填取并集
      x: { type: 'integer', required: true },
      y: { type: 'string' },
      z: { type: 'boolean', required: true },
      // w 仅 B 声明且 A 拒绝额外字段：交集中不得出现，从结果省略
    },
    additionalProperties: false,
  });
});

test('allOf 拒绝：空交集（标量冲突 / 必填字段被禁止）与非对象分支', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', scenarioWith([postEndpoint('/a')]));

  const cases: Array<{ name: string; schema: unknown; expect: RegExp }> = [
    {
      name: '同名字段标量冲突',
      schema: {
        allOf: [
          { type: 'object', properties: { x: { type: 'string' } } },
          { type: 'object', properties: { x: { type: 'integer' } } },
        ],
      },
      expect: /空交集.*"x"|"x".*空交集/s,
    },
    {
      name: '必填字段被另一分支禁止',
      schema: {
        allOf: [
          { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
          { type: 'object', additionalProperties: false },
        ],
      },
      expect: /空交集.*additionalProperties/s,
    },
    {
      name: '非对象分支',
      schema: { allOf: [{ type: 'object' }, { type: 'string' }] },
      expect: /纯对象|最终均须为 object/,
    },
    {
      name: '组合节点含其他关键字',
      schema: { allOf: [{ type: 'object' }], type: 'object' },
      expect: /未支持的关键字 "type"/,
    },
  ];

  for (const c of cases) {
    const doc = docWith({ '/a': { post: { requestBody: jsonRequestBody(c.schema) } } });
    const apiFile = await writeConfig(dir, `api-allof-${c.name}.json`, doc);
    const result = await runImport(apiFile, configFile);
    assert.equal(result.code, 2, `${c.name}：应退出 2，实际 ${result.code}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位原因：\n${result.stderr}`);
  }
});

test('特殊字段名（空名、__proto__、斜杠、波浪号）原样保留', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const doc = docWith({
    '/a': {
      post: {
        requestBody: jsonRequestBody({
          type: 'object',
          properties: {
            '': { type: 'string' },
            // 计算属性键：对象字面量中书写 '__proto__' 会触发原型 setter，
            // 必须用计算键才能构造名为 __proto__ 的自有字段
            ['__proto__']: { type: 'integer' },
            'a/b': { type: 'boolean' },
            'c~d': { type: 'number' },
          },
          required: ['__proto__', 'a/b'],
        }),
      },
    },
  });
  const apiFile = await writeConfig(dir, 'api.json', doc);
  const configFile = await writeConfig(dir, 'scenes.json', scenarioWith([postEndpoint('/a')]));

  const result = parseImported(await runImport(apiFile, configFile));
  const rule = result.endpoints[0].requestBody as { fields: Record<string, unknown> };
  assert.deepEqual(Object.keys(rule.fields), ['', '__proto__', 'a/b', 'c~d']);
  assert.deepEqual(rule.fields['__proto__'], { type: 'integer', required: true });
  assert.deepEqual(rule.fields['a/b'], { type: 'boolean', required: true });
  assert.deepEqual(rule.fields[''], { type: 'string' });
  assert.deepEqual(rule.fields['c~d'], { type: 'number' });
});

test('未选操作与不可达定义不参与转换', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const doc = docWith(
    {
      '/ok': { post: { requestBody: jsonRequestBody({ type: 'object' }) } },
      // 未被场景选中的操作：schema 含未支持关键字，不影响结果
      '/other': { post: { requestBody: jsonRequestBody({ type: 'string', format: 'date-time' }) } },
    },
    {
      schemas: {
        // 不可达定义：非法内容不参与转换
        Bad: { type: 'object', properties: { x: { $ref: '#/components/schemas/Nowhere' } } },
      },
    },
  );
  const apiFile = await writeConfig(dir, 'api.json', doc);
  const configFile = await writeConfig(dir, 'scenes.json', scenarioWith([postEndpoint('/ok')]));

  const result = parseImported(await runImport(apiFile, configFile));
  assert.deepEqual(result.endpoints[0].requestBody, {
    type: 'object',
    fields: {},
    additionalProperties: true,
  });
});

test('操作级拒绝：缺少操作、GET 声明正文、POST 缺 required、媒体类型不符', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);

  // 缺少对应操作
  {
    const apiFile = await writeConfig(dir, 'api-noop.json', docWith({ '/a': { get: {} } }));
    const configFile = await writeConfig(dir, 'scenes-noop.json', scenarioWith([postEndpoint('/a')]));
    const result = await runImport(apiFile, configFile);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('/a'), `stderr 应指明路径：\n${result.stderr}`);
  }

  // GET 声明 requestBody
  {
    const apiFile = await writeConfig(
      dir,
      'api-get.json',
      docWith({ '/a': { get: { requestBody: jsonRequestBody({ type: 'object' }) } } }),
    );
    const configFile = await writeConfig(dir, 'scenes-get.json', {
      endpoints: [{ method: 'GET', path: '/a', responses: [sceneResponse()] }],
    });
    const result = await runImport(apiFile, configFile);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.ok(/GET 操作不得声明 requestBody/.test(result.stderr), `stderr：\n${result.stderr}`);
  }

  // POST requestBody 缺 required: true
  {
    const doc = docWith({
      '/a': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } },
    });
    const apiFile = await writeConfig(dir, 'api-noreq.json', doc);
    const configFile = await writeConfig(dir, 'scenes-noreq.json', scenarioWith([postEndpoint('/a')]));
    const result = await runImport(apiFile, configFile);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.ok(/required.*true/.test(result.stderr), `stderr：\n${result.stderr}`);
  }

  // content 含多个媒体类型
  {
    const doc = docWith({
      '/a': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { type: 'object' } },
              'text/plain': { schema: { type: 'string' } },
            },
          },
        },
      },
    });
    const apiFile = await writeConfig(dir, 'api-media.json', doc);
    const configFile = await writeConfig(dir, 'scenes-media.json', scenarioWith([postEndpoint('/a')]));
    const result = await runImport(apiFile, configFile);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.ok(/application\/json/.test(result.stderr), `stderr：\n${result.stderr}`);
  }

  // 媒体类型缺 schema
  {
    const doc = docWith({
      '/a': { post: { requestBody: { required: true, content: { 'application/json': { example: {} } } } } },
    });
    const apiFile = await writeConfig(dir, 'api-noschema.json', doc);
    const configFile = await writeConfig(dir, 'scenes-noschema.json', scenarioWith([postEndpoint('/a')]));
    const result = await runImport(apiFile, configFile);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.ok(/schema/.test(result.stderr), `stderr：\n${result.stderr}`);
  }
});

test('schema 级拒绝：未支持关键字、nullable:true、必填未声明、数组缺 items、非法 additionalProperties', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', scenarioWith([postEndpoint('/a')]));

  const cases: Array<{ name: string; schema: unknown; expect: RegExp }> = [
    { name: '未支持关键字', schema: { type: 'string', minLength: 1 }, expect: /未支持的关键字 "minLength"/ },
    { name: 'nullable true', schema: { type: 'string', nullable: true }, expect: /nullable/ },
    { name: '缺 type', schema: { properties: {} }, expect: /type/ },
    { name: '非法 type', schema: { type: 'null' }, expect: /type/ },
    {
      name: '必填未在同层声明',
      schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['y'] },
      expect: /未在同层 properties 中声明/,
    },
    { name: '数组缺 items', schema: { type: 'array' }, expect: /items/ },
    {
      name: 'additionalProperties 非布尔',
      schema: { type: 'object', additionalProperties: { type: 'string' } },
      expect: /additionalProperties/,
    },
  ];

  for (const c of cases) {
    const doc = docWith({ '/a': { post: { requestBody: jsonRequestBody(c.schema) } } });
    const apiFile = await writeConfig(dir, `api-schema-${c.name}.json`, doc);
    const result = await runImport(apiFile, configFile);
    assert.equal(result.code, 2, `${c.name}：应退出 2，实际 ${result.code}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位原因：\n${result.stderr}`);
  }
});

test('输入文件失败：读取、JSON 解析、场景校验失败均退出 2 且 stdout 为空', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const apiFile = await writeConfig(dir, 'api.json', docWith({ '/a': { post: {} } }));
  const configFile = await writeConfig(dir, 'scenes.json', scenarioWith([postEndpoint('/a')]));

  // OpenAPI 文件不存在
  {
    const result = await runImport(path.join(dir, 'missing.json'), configFile);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('missing.json'), `stderr 应指明文件：\n${result.stderr}`);
  }

  // OpenAPI 非法 JSON
  {
    const bad = await writeText(dir, 'bad.json', '{ "paths": [ not-json');
    const result = await runImport(bad, configFile);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.ok(/JSON/i.test(result.stderr), `stderr：\n${result.stderr}`);
  }

  // 场景配置校验失败（未知字段）
  {
    const badScenario = await writeConfig(dir, 'bad-scenes.json', {
      endpoints: [{ method: 'POST', path: '/a', responses: [sceneResponse()], bogus: 1 }],
    });
    const result = await runImport(apiFile, badScenario);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(badScenario), `stderr 应指明场景文件：\n${result.stderr}`);
    assert.ok(/未知字段/.test(result.stderr), `stderr：\n${result.stderr}`);
  }

  // 场景文件非法 JSON
  {
    const badJson = await writeText(dir, 'bad-scenes-json.json', '{ nope');
    const result = await runImport(apiFile, badJson);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
  }
});

test('导入结果可直接用于 serve（真实请求校验生效）与 compare', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const doc = docWith({
    '/api/order': {
      post: {
        requestBody: jsonRequestBody({
          type: 'object',
          properties: { id: { type: 'integer' }, 'a/b': { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        }),
      },
    },
  });
  const apiFile = await writeConfig(dir, 'api.json', doc);
  const configFile = await writeConfig(
    dir,
    'scenes.json',
    scenarioWith([postEndpoint('/api/order')]),
  );

  const imported = parseImported(await runImport(apiFile, configFile));
  const importedFile = path.join(dir, 'imported.json');
  await writeFile(importedFile, `${JSON.stringify(imported, null, 2)}\n`, 'utf8');

  // serve：加载导入结果，正文校验生效
  const server = await startServer(importedFile);
  try {
    const bad = await sendRequest(server.port, {
      method: 'POST',
      path: '/api/order',
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":"oops"}',
    });
    assert.equal(bad.status, 400, `非法正文应 400，实际 ${bad.status}：${bad.body}`);

    const good = await sendRequest(server.port, {
      method: 'POST',
      path: '/api/order',
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":1,"a/b":"x"}',
    });
    assert.equal(good.status, SCENE_STATUS);
    assert.equal(good.body, SCENE_BODY);
  } finally {
    await server.close();
  }

  // compare：导入结果与自身比较必然兼容（证明输出是合法场景配置）
  const cmp = await runCompare(importedFile, importedFile);
  assert.equal(cmp.code, 0, `自比较应兼容退出 0，实际 ${cmp.code}\n${cmp.stderr}`);
  assert.ok(JSON.parse(cmp.stdout).compatible, '自比较报告应为兼容');
});

test('参数错误：缺少必填参数或未知参数退出 2', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', scenarioWith([postEndpoint('/a')]));

  for (const args of [
    ['import'],
    ['import', '--config', configFile],
    ['import', '--openapi', 'x.json'],
    ['import', '--openapi', 'x.json', '--config', configFile, '--bogus'],
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 2, `参数 ${args.join(' ')} 应退出 2，实际 ${result.code}`);
    assert.equal(result.stdout, '', '参数错误时 stdout 必须为空');
  }
});

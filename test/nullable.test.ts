// 请求正文可空约定（nullable）的回归测试
//
// 覆盖：
// - serve：根可空（正文 null 被接受并正常消费序列）、嵌套字段与数组元素可空、
//   必填字段即使可空也不能缺失、空正文不等于 null（解析阶段 400）、可空不放宽
//   媒体类型检查、非 null 继续检查全部原约束、拒绝不消费序列；
//   reload 成功原子替换规则并递增版本、失败保留旧状态；
// - serve 与 verify 对相同请求字节结论一致（含 null 正文、空正文、缺失字段）；
//   同一快照对照去掉可空的新场景结论翻转；replay 到相同配置全部相同；
// - compare：可空放宽兼容、可空收紧不兼容（反例为 null）、可空不掩盖非 null
//   约束变化、嵌套 null 反例包含必要父对象与其他必填字段；
//   每个反例真实重放到分别加载旧、新配置的本机服务（旧接受、新拒绝）；
//   非法 nullable 配置退出 2、stderr 可定位、stdout 为空；
// - import：基础 schema 的 nullable:true（递归字段、items、本文件内 $ref）转换
//   为规则 nullable:true；非布尔 nullable 与 allOf 组合节点 nullable:true 拒绝；
//   两个可空对象分支必填同名字段类型冲突 -> 成功导入为 type:"null"（仅剩 null），
//   任一分支不可空 -> 空交集拒绝；成功输出可直接用于 serve（null 接受、非 null
//   拒绝）。

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
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
  type RawRequest,
} from './helpers.ts';

// ---------------------------------------------------------------------------
// 共用配置
// ---------------------------------------------------------------------------

// 根可空 + 嵌套字段/数组元素可空；两个响应项用于观察序列消费
function nullableConfig(): unknown {
  return {
    endpoints: [
      {
        method: 'POST',
        path: '/n',
        requestBody: {
          type: 'object',
          nullable: true,
          fields: {
            id: { type: 'integer', required: true },
            note: { type: 'string', nullable: true },
            tags: { type: 'array', items: { type: 'string', nullable: true } },
          },
          additionalProperties: false,
        },
        responses: [
          { status: SCENE_STATUS, headers: {}, body: 'nullable-r1', delay: 0 },
          { status: SCENE_STATUS, headers: {}, body: 'nullable-r2', delay: 0 },
        ],
      },
    ],
  };
}

// 同一接口去掉全部可空（reload 与 verify 对照用）
function strictConfig(): unknown {
  return {
    endpoints: [
      {
        method: 'POST',
        path: '/n',
        requestBody: {
          type: 'object',
          fields: {
            id: { type: 'integer', required: true },
            note: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        responses: [{ status: SCENE_STATUS, headers: {}, body: 'strict-r1', delay: 0 }],
      },
    ],
  };
}

function postJson(
  port: number,
  path: string,
  body: string,
  headers: { readonly [name: string]: string } = { 'Content-Type': 'application/json' },
) {
  return sendRequest(port, { method: 'POST', path, headers, body });
}

function getSnapshot(port: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__contractlab/requests' }, (res) => {
      let data = '';
      res.setEncoding('utf8').on('data', (d: string) => (data += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// serve：可空的在线行为
// ---------------------------------------------------------------------------

test('serve：根与嵌套可空、缺失与空正文、拒绝不消费序列、reload 语义', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', nullableConfig());
  const server = await startServer(file);
  t.after(server.close);
  const post = (body: string, headers?: { readonly [name: string]: string }) =>
    postJson(server.port, '/n', body, headers);

  // 根可空：正文 null 被接受，消费序列第 1 项
  let res = await post('null');
  assert.equal(res.status, SCENE_STATUS, `根可空应接受 null：${res.body}`);
  assert.equal(res.body, 'nullable-r1');

  // 必填字段即使（根）可空也不能缺失：{} 缺 id -> 400 结构差异，不消费序列
  res = await post('{}');
  assert.equal(res.status, 400);
  let report = JSON.parse(res.body);
  assert.equal(report.stage, 'structure');
  assert.ok(
    report.problems.some((p: any) => p.pointer === '/id' && p.actual === 'missing'),
    `缺失必填字段应定位 /id：${res.body}`,
  );

  // 空正文不等于 null：解析阶段 400
  res = await post('');
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).stage, 'parse', `空正文应在解析阶段拒绝：${res.body}`);

  // 可空不放宽媒体类型检查
  res = await post('null', { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).stage, 'parse', `媒体类型不符应在解析阶段拒绝：${res.body}`);

  // 嵌套可空：note 与 tags 元素为 null 被接受；前面的 400 均未消费，本请求取第 2 项
  res = await post('{"id":1,"note":null,"tags":[null,"a"]}');
  assert.equal(res.status, SCENE_STATUS, `嵌套可空应接受 null：${res.body}`);
  assert.equal(res.body, 'nullable-r2', '之前的 400 不得消费序列');

  // 非 null 继续检查全部原约束：tags 元素 5 不是 string
  res = await post('{"id":1,"tags":[5]}');
  assert.equal(res.status, 400);
  report = JSON.parse(res.body);
  assert.ok(
    report.problems.some((p: any) => p.pointer === '/tags/0' && p.expected === 'string'),
    `非 null 元素应继续检查原约束：${res.body}`,
  );

  // 未声明可空的字段不接受 null
  res = await post('{"id":null}');
  assert.equal(res.status, 400);
  report = JSON.parse(res.body);
  assert.ok(
    report.problems.some((p: any) => p.pointer === '/id' && p.actual === 'null'),
    `不可空字段应拒绝 null：${res.body}`,
  );

  // 序列已耗尽：持续复用末项（再次证明之前的 400 都没有消费）
  res = await post('{"id":2}');
  assert.equal(res.status, SCENE_STATUS);
  assert.equal(res.body, 'nullable-r2');

  // reload 成功：新规则（去掉全部可空）原子替换、版本 +1、序列重置
  await writeConfig(dir, 'scenes.json', strictConfig());
  res = await sendRequest(server.port, {
    method: 'POST',
    path: '/__contractlab/reload',
    headers: {},
    body: '',
  });
  assert.deepEqual(JSON.parse(res.body), { ok: true, version: 2 });
  res = await post('null');
  assert.equal(res.status, 400, '新规则根不可空，null 应被拒绝');
  res = await post('{"id":1}');
  assert.equal(res.status, SCENE_STATUS);
  assert.equal(res.body, 'strict-r1', 'reload 成功后序列从头开始');

  // reload 失败（nullable 非布尔）：保留旧状态，旧规则继续生效
  await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/n',
        requestBody: { type: 'string', nullable: 'yes' },
        responses: [{ status: 200, headers: {}, body: 'x', delay: 0 }],
      },
    ],
  });
  res = await sendRequest(server.port, {
    method: 'POST',
    path: '/__contractlab/reload',
    headers: {},
    body: '',
  });
  const reloadResult = JSON.parse(res.body);
  assert.equal(reloadResult.ok, false, `非法 nullable 应使 reload 失败：${res.body}`);
  assert.equal(reloadResult.version, 2, 'reload 失败不得递增版本');
  assert.match(reloadResult.error, /nullable/);
  res = await post('null');
  assert.equal(res.status, 400, 'reload 失败后旧规则继续生效');
  res = await post('{"id":1}');
  assert.equal(res.status, SCENE_STATUS);
  assert.equal(res.body, 'strict-r1');
});

// ---------------------------------------------------------------------------
// serve 与 verify 一致；replay 行为保持
// ---------------------------------------------------------------------------

test('serve 与 verify 对相同请求字节结论一致；replay 到相同配置全部相同', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configFile = await writeConfig(dir, 'scenes.json', nullableConfig());
  const server = await startServer(configFile);
  t.after(server.close);

  // 产生一组覆盖 null 正文、缺失字段、空正文、嵌套可空、类型错误的真实请求
  await postJson(server.port, '/n', 'null'); // 接受（根可空）
  await postJson(server.port, '/n', '{}'); // 400（缺必填）
  await postJson(server.port, '/n', ''); // 400（空正文，解析阶段）
  await postJson(server.port, '/n', '{"id":1,"note":null}'); // 接受（嵌套可空）
  await postJson(server.port, '/n', '{"id":"x"}'); // 400（类型错误）

  const snapshot = await getSnapshot(server.port);
  const snapshotFile = await writeConfig(dir, 'snapshot.json', snapshot);

  // verify 对照同一份配置：在线/离线结论一致
  const verify = await runCli(['verify', '--requests', snapshotFile, '--config', configFile]);
  assert.equal(verify.code, 1, `存在拒绝，退出码应为 1\nstderr:\n${verify.stderr}`);
  const report = JSON.parse(verify.stdout);
  assert.equal(report.total, 5);
  assert.deepEqual(
    report.results.map((r: any) => r.outcome),
    ['passed', 'rejected', 'rejected', 'passed', 'rejected'],
    `verify 结论应与在线一致：${verify.stdout}`,
  );
  assert.deepEqual(
    report.results.map((r: any) => r.id),
    [1, 2, 3, 4, 5],
    '应按输入顺序保留原编号',
  );
  assert.equal(report.results[2].rejection.stage, 'parse', '空正文应在解析阶段拒绝');

  // 同一快照对照去掉可空的新场景：null 正文与 note:null 的结论翻转
  const strictFile = await writeConfig(dir, 'strict.json', strictConfig());
  const verifyStrict = await runCli(['verify', '--requests', snapshotFile, '--config', strictFile]);
  assert.equal(verifyStrict.code, 1);
  const strictReport = JSON.parse(verifyStrict.stdout);
  assert.deepEqual(
    strictReport.results.map((r: any) => r.outcome),
    ['rejected', 'rejected', 'rejected', 'rejected', 'rejected'],
    `去掉可空后结论应翻转：${verifyStrict.stdout}`,
  );

  // replay 到加载相同配置的另一台真实服务：全部相同（请求记录与重放行为保持）
  const server2 = await startServer(configFile);
  t.after(server2.close);
  const replay = await runCli([
    'replay',
    '--requests',
    snapshotFile,
    '--port',
    String(server2.port),
    '--timeout',
    '5000',
  ]);
  assert.equal(replay.code, 0, `相同配置重放应全部相同\nstdout:\n${replay.stdout}`);
  const replayReport = JSON.parse(replay.stdout);
  assert.equal(replayReport.total, 5);
  assert.ok(
    replayReport.results.every((r: any) => r.outcome === 'same'),
    `每条记录都应与计划响应一致：${replay.stdout}`,
  );
});

// ---------------------------------------------------------------------------
// compare：可空的集合包含判定与反例真实重放
// ---------------------------------------------------------------------------

test('compare：可空放宽兼容、收紧不兼容、不掩盖非 null 变化；反例真实重放', { timeout: 180_000 }, async (t) => {
  const dir = await makeTempDir(t);

  // 兼容组：新增可空（放宽）、双方同样可空、type:null -> 可空标量
  const compatOld = await writeConfig(dir, 'compat-old.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/c/widen',
        requestBody: { type: 'string' },
        responses: [sceneResponse()],
      },
      {
        method: 'POST',
        path: '/c/same',
        requestBody: { type: 'object', nullable: true, fields: {}, additionalProperties: false },
        responses: [sceneResponse()],
      },
      {
        method: 'POST',
        path: '/c/null-to-nullable',
        requestBody: { type: 'null' },
        responses: [sceneResponse()],
      },
    ],
  });
  const compatNew = await writeConfig(dir, 'compat-new.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/c/widen',
        requestBody: { type: 'string', nullable: true },
        responses: [sceneResponse()],
      },
      {
        method: 'POST',
        path: '/c/same',
        requestBody: { type: 'object', nullable: true, fields: {}, additionalProperties: false },
        responses: [sceneResponse()],
      },
      {
        method: 'POST',
        path: '/c/null-to-nullable',
        requestBody: { type: 'string', nullable: true },
        responses: [sceneResponse()],
      },
    ],
  });
  const compat = await runCompare(compatOld, compatNew);
  assert.equal(compat.code, 0, `可空放宽应兼容\nstderr:\n${compat.stderr}`);
  assert.equal(JSON.parse(compat.stdout).compatible, true);

  // 不兼容组
  const oldConfig = {
    endpoints: [
      {
        // 根可空收紧：反例为 null
        method: 'POST',
        path: '/i/root',
        requestBody: {
          type: 'object',
          nullable: true,
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      {
        // 嵌套字段可空收紧：反例须包含必要父对象与其他必填字段
        method: 'POST',
        path: '/i/nested',
        requestBody: {
          type: 'object',
          fields: {
            x: { type: 'string', nullable: true, required: true },
            y: { type: 'integer', required: true },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      {
        // 双方可空：非 null 约束变化（string -> integer）不得被掩盖
        method: 'POST',
        path: '/i/non-null-mask',
        requestBody: { type: 'string', nullable: true },
        responses: [sceneResponse()],
      },
    ],
  };
  const newConfig = {
    endpoints: [
      {
        method: 'POST',
        path: '/i/root',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      {
        method: 'POST',
        path: '/i/nested',
        requestBody: {
          type: 'object',
          fields: {
            x: { type: 'string', required: true },
            y: { type: 'integer', required: true },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      {
        method: 'POST',
        path: '/i/non-null-mask',
        requestBody: { type: 'integer', nullable: true },
        responses: [sceneResponse()],
      },
    ],
  };
  const oldFile = await writeConfig(dir, 'old.json', oldConfig);
  const newFile = await writeConfig(dir, 'new.json', newConfig);

  const result = await runCompare(oldFile, newFile);
  assert.equal(result.code, 1, `存在不兼容接口，退出码应为 1\nstderr:\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.compatible, false);
  const byKey = new Map<string, any>(
    report.endpoints.map((ep: any) => [`${ep.method} ${ep.path}`, ep]),
  );

  // 根可空收紧：反例就是 null 本身
  const root = byKey.get('POST /i/root');
  assert.equal(root.compatible, false);
  assert.equal(root.example.body, 'null', `根可空收紧的反例应为 null：${result.stdout}`);

  // 嵌套可空收紧：反例中 x 为 null，且包含必要父对象与其他必填字段 y
  const nested = byKey.get('POST /i/nested');
  assert.equal(nested.compatible, false);
  const nestedBody = JSON.parse(nested.example.body);
  assert.equal(nestedBody.x, null, `嵌套反例的 x 应为 null：${nested.example.body}`);
  assert.ok(
    Number.isInteger(nestedBody.y),
    `嵌套反例须包含其他必填字段 y：${nested.example.body}`,
  );
  assert.ok(
    nested.reasons.some((r: any) => r.pointer === '/x'),
    `原因应定位到 /x：${result.stdout}`,
  );

  // 双方可空：反例必须是非 null 值（可空不能掩盖非 null 约束变化）
  const mask = byKey.get('POST /i/non-null-mask');
  assert.equal(mask.compatible, false);
  assert.equal(typeof JSON.parse(mask.example.body), 'string', `反例应为非 null 字符串：${mask.example.body}`);

  // 反例真实重放：旧服务接受（场景成功响应），新服务 400
  const oldServer = await startServer(oldFile);
  t.after(oldServer.close);
  const newServer = await startServer(newFile);
  t.after(newServer.close);
  for (const key of ['POST /i/root', 'POST /i/nested', 'POST /i/non-null-mask']) {
    const example = byKey.get(key).example as RawRequest;
    const label = `${key} 的反例 ${example.method} ${example.path} 正文=${example.body}`;
    const oldRes = await sendRequest(oldServer.port, example);
    assert.equal(oldRes.status, SCENE_STATUS, `${label}\n旧服务应接受`);
    assert.equal(oldRes.body, SCENE_BODY, `${label}\n旧服务应返回场景正文`);
    const newRes = await sendRequest(newServer.port, example);
    assert.equal(newRes.status, 400, `${label}\n新服务应以 400 拒绝：${newRes.body}`);
    assert.equal(JSON.parse(newRes.body).error, 'invalid_request_body');
  }
});

test('compare/verify：非法 nullable 配置退出 2、stderr 可定位、stdout 为空', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const bad = await writeConfig(dir, 'bad.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/n',
        requestBody: { type: 'string', nullable: 'yes' },
        responses: [sceneResponse()],
      },
    ],
  });
  const good = await writeConfig(dir, 'good.json', {
    endpoints: [
      { method: 'POST', path: '/n', requestBody: { type: 'string' }, responses: [sceneResponse()] },
    ],
  });

  const compare = await runCompare(good, bad);
  assert.equal(compare.code, 2, `非法 nullable 应退出 2\nstdout:\n${compare.stdout}`);
  assert.equal(compare.stdout, '', '失败时 stdout 必须为空');
  assert.match(compare.stderr, /nullable/, `stderr 应定位 nullable：${compare.stderr}`);

  const snapshot = await writeConfig(dir, 'snapshot.json', { count: 0, records: [] });
  const verify = await runCli(['verify', '--requests', snapshot, '--config', bad]);
  assert.equal(verify.code, 2, `非法 nullable 应退出 2\nstdout:\n${verify.stdout}`);
  assert.equal(verify.stdout, '', '失败时 stdout 必须为空');
  assert.match(verify.stderr, /nullable/, `stderr 应定位 nullable：${verify.stderr}`);
});

// ---------------------------------------------------------------------------
// import：nullable:true 转换与 allOf 交集的 null 营救
// ---------------------------------------------------------------------------

function openapiWith(paths: Record<string, unknown>, components?: unknown): unknown {
  const doc: Record<string, unknown> = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths };
  if (components !== undefined) {
    doc.components = components;
  }
  return doc;
}

function jsonBody(schema: unknown): unknown {
  return { required: true, content: { 'application/json': { schema } } };
}

function sceneFor(paths: readonly string[]): unknown {
  return {
    endpoints: paths.map((p) => ({
      method: 'POST',
      path: p,
      responses: [sceneResponse()],
    })),
  };
}

test('import：基础 schema 的 nullable:true（递归字段、items、$ref）转换并可用于 serve', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', openapiWith(
    {
      '/nullable-basic': {
        post: {
          requestBody: jsonBody({
            type: 'object',
            nullable: true,
            properties: {
              name: { type: 'string', nullable: true },
              tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
            },
            required: ['name'],
          }),
        },
      },
    },
    { schemas: { Tag: { type: 'string', nullable: true } } },
  ));
  const scene = await writeConfig(dir, 'scene.json', sceneFor(['/nullable-basic']));

  const result = await runCli(['import', '--openapi', api, '--config', scene]);
  assert.equal(result.code, 0, `导入应成功\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.endpoints[0].requestBody, {
    type: 'object',
    nullable: true,
    fields: {
      name: { type: 'string', nullable: true, required: true },
      tags: { type: 'array', items: { type: 'string', nullable: true } },
    },
    additionalProperties: true,
  });

  // 输出可直接用于 serve：null 与各嵌套 null 被接受，非 null 约束不变
  const outFile = await writeConfig(dir, 'scene-out.json', output);
  const server = await startServer(outFile);
  t.after(server.close);
  let res = await postJson(server.port, '/nullable-basic', 'null');
  assert.equal(res.status, SCENE_STATUS, `根可空应接受 null：${res.body}`);
  res = await postJson(server.port, '/nullable-basic', '{"name":null,"tags":[null,"a"],"extra":1}');
  assert.equal(res.status, SCENE_STATUS, `嵌套可空应接受 null：${res.body}`);
  res = await postJson(server.port, '/nullable-basic', '{"name":1}');
  assert.equal(res.status, 400, `非 null 约束不变：${res.body}`);
  res = await postJson(server.port, '/nullable-basic', '{"name":"a","tags":[1]}');
  assert.equal(res.status, 400, `数组元素非 null 约束不变：${res.body}`);
});

test('import：非布尔 nullable 与 allOf 组合节点 nullable:true 拒绝', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const scene = await writeConfig(dir, 'scene.json', sceneFor(['/a']));

  const nonBoolean = await writeConfig(dir, 'api-nonbool.json', openapiWith({
    '/a': { post: { requestBody: jsonBody({ type: 'string', nullable: 'yes' }) } },
  }));
  let result = await runCli(['import', '--openapi', nonBoolean, '--config', scene]);
  assert.equal(result.code, 2, `非布尔 nullable 应退出 2\nstdout:\n${result.stdout}`);
  assert.equal(result.stdout, '', '失败时 stdout 必须为空');
  assert.match(result.stderr, /nullable/, `stderr 应定位 nullable：${result.stderr}`);

  const comboNullable = await writeConfig(dir, 'api-combo.json', openapiWith({
    '/a': {
      post: { requestBody: jsonBody({ nullable: true, allOf: [{ type: 'object' }] }) },
    },
  }));
  result = await runCli(['import', '--openapi', comboNullable, '--config', scene]);
  assert.equal(result.code, 2, `allOf 组合节点 nullable:true 应退出 2\nstdout:\n${result.stdout}`);
  assert.equal(result.stdout, '', '失败时 stdout 必须为空');
  assert.match(result.stderr, /nullable/, `stderr 应定位 nullable：${result.stderr}`);
});

test('import：可空对象分支交集仅剩 null 时输出 type:null；任一分支不可空则空交集拒绝', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);

  // 两个可空对象分支都要求 x，分别约束 string 与 integer：
  // 结构交集为空，但两支都可空 -> 交集恰为 {null}
  const branch = (type: string, nullable: boolean) => ({
    type: 'object',
    nullable,
    properties: { x: { type } },
    required: ['x'],
    additionalProperties: false,
  });
  const api = await writeConfig(dir, 'api.json', openapiWith({
    '/only-null': { post: { requestBody: jsonBody({ allOf: [branch('string', true), branch('integer', true)] }) } },
  }));
  const scene = await writeConfig(dir, 'scene.json', sceneFor(['/only-null']));

  const result = await runCli(['import', '--openapi', api, '--config', scene]);
  assert.equal(result.code, 0, `两支可空时应成功导入为仅接受 null\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.endpoints[0].requestBody,
    { type: 'null' },
    `交集仅剩 null 应输出 type:"null"：${result.stdout}`,
  );

  // 输出可直接 serve：null 被接受，任何非 null（含 {}、{"x":"s"}）被拒绝
  const outFile = await writeConfig(dir, 'scene-out.json', output);
  const server = await startServer(outFile);
  t.after(server.close);
  let res = await postJson(server.port, '/only-null', 'null');
  assert.equal(res.status, SCENE_STATUS, `仅接受 null：${res.body}`);
  res = await postJson(server.port, '/only-null', '{}');
  assert.equal(res.status, 400, `非 null 应拒绝：${res.body}`);
  res = await postJson(server.port, '/only-null', '{"x":"s"}');
  assert.equal(res.status, 400, `非 null 应拒绝：${res.body}`);

  // 任一分支不可空：交集为空，拒绝
  const apiMixed = await writeConfig(dir, 'api-mixed.json', openapiWith({
    '/only-null': { post: { requestBody: jsonBody({ allOf: [branch('string', true), branch('integer', false)] }) } },
  }));
  const mixed = await runCli(['import', '--openapi', apiMixed, '--config', scene]);
  assert.equal(mixed.code, 2, `任一分支不可空应以空交集拒绝\nstdout:\n${mixed.stdout}`);
  assert.equal(mixed.stdout, '', '失败时 stdout 必须为空');
  assert.match(mixed.stderr, /allOf/, `stderr 应定位 allOf 分支：${mixed.stderr}`);
});

test('import：字段级可空交集仅剩 null 时该字段为 type:null', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  // 两个开放对象分支的可选字段 x 分别为可空 string / 可空 integer：
  // x 的交集恰为 {null}，其余字段不受限
  const api = await writeConfig(dir, 'api.json', openapiWith({
    '/field-null': {
      post: {
        requestBody: jsonBody({
          allOf: [
            { type: 'object', properties: { x: { type: 'string', nullable: true } } },
            { type: 'object', properties: { x: { type: 'integer', nullable: true } } },
          ],
        }),
      },
    },
  }));
  const scene = await writeConfig(dir, 'scene.json', sceneFor(['/field-null']));

  const result = await runCli(['import', '--openapi', api, '--config', scene]);
  assert.equal(result.code, 0, `字段级交集仅剩 null 时应成功\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.endpoints[0].requestBody,
    {
      type: 'object',
      fields: { x: { type: 'null' } },
      additionalProperties: true,
    },
    `字段 x 应为 type:"null"：${result.stdout}`,
  );

  const outFile = await writeConfig(dir, 'scene-out.json', output);
  const server = await startServer(outFile);
  t.after(server.close);
  let res = await postJson(server.port, '/field-null', '{}');
  assert.equal(res.status, SCENE_STATUS, `x 可缺省：${res.body}`);
  res = await postJson(server.port, '/field-null', '{"x":null}');
  assert.equal(res.status, SCENE_STATUS, `x 可接受 null：${res.body}`);
  res = await postJson(server.port, '/field-null', '{"x":"s"}');
  assert.equal(res.status, 400, `x 的非 null 值应拒绝：${res.body}`);
  res = await postJson(server.port, '/field-null', '{"other":1}');
  assert.equal(res.status, SCENE_STATUS, `额外字段仍放行：${res.body}`);
});

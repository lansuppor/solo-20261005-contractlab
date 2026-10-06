// 请求正文可空约定（requestBody 规则节点的布尔 nullable）回归测试
//
// 覆盖：
// - serve：根可空与嵌套可空（字段、数组元素）；必填可空字段仍不得缺失；
//   null 被接受时不产生子节点差异，非 null 仍检查全部原约束；空正文不等于
//   null；可空不放宽媒体类型 / UTF-8 / JSON 检查；拒绝沿用差异报告且不消费
//   响应序列；非法可空规则（非布尔值、未知字段、数组缺 items）整份拒绝；
// - reload：成功原子替换规则与响应并递增版本，失败保留旧状态；
// - verify：与 serve 对相同请求字节结论一致（含空正文与缺失字段）；
// - compare：可空加宽兼容、移除可空不兼容（根与嵌套 null 反例，嵌套反例含
//   必要父对象与其他必填字段）、可空不掩盖非 null 约束变化；每个不兼容反例
//   原样重放到分别加载旧、新配置的真实本机服务（旧接受、新拒绝）；
// - import：基础 schema 的 nullable:true（根 / 递归字段 / items / 本文件内
//   $ref），非布尔值与 allOf 组合节点 nullable:true 拒绝；可空对象交集含
//   null 当且仅当全部分支可空——两个可空对象分支必填同名字段类型相交为空时
//   成功导入为仅接受 null（type:null），任一分支不可空则以空交集拒绝；
//   导入结果用于真实 serve 核对。

import assert from 'node:assert/strict';
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
  writeText,
  type RawRequest,
} from './helpers.ts';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function post(path: string, body: string): RawRequest {
  return { method: 'POST', path, headers: { ...JSON_HEADERS }, body };
}

function runImport(openapi: string, config: string) {
  return runCli(['import', '--openapi', openapi, '--config', config]);
}

function runVerify(requests: string, config: string) {
  return runCli(['verify', '--requests', requests, '--config', config]);
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

// 解析 400 差异报告
function parse400(body: string): {
  error: string;
  stage: string;
  problems: Array<{ pointer: string; expected: string; actual: string }>;
} {
  const report = JSON.parse(body);
  assert.equal(report.error, 'invalid_request_body', '400 应是正文校验拒绝');
  return report;
}

// ---------------------------------------------------------------------------
// serve：根可空与嵌套可空的在线校验
// ---------------------------------------------------------------------------

test('serve：根可空、嵌套可空、缺失与空正文、拒绝不消费序列', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const SECOND_STATUS = 288;
  const SECOND_BODY = 'contractlab-second-item';
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        // 根可空：null 与对象都接受；id 必填但不可空
        method: 'POST',
        path: '/n/root',
        requestBody: {
          type: 'object',
          nullable: true,
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [
          sceneResponse(),
          { status: SECOND_STATUS, headers: {}, body: SECOND_BODY, delay: 0 },
        ],
      },
      {
        // 嵌套可空：必填可空字段 a、可空对象 c（内含必填 x）、可空数组元素 b
        method: 'POST',
        path: '/n/nested',
        requestBody: {
          type: 'object',
          fields: {
            a: { type: 'string', nullable: true, required: true },
            c: {
              type: 'object',
              nullable: true,
              fields: { x: { type: 'integer', required: true } },
              additionalProperties: false,
            },
            b: { type: 'array', items: { type: 'integer', nullable: true } },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
    ],
  });
  const server = await startServer(config);
  t.after(server.close);

  // —— 根可空 ——
  // 先制造一次 400：不消费序列
  const missing = await sendRequest(server.port, post('/n/root', '{}'));
  assert.equal(missing.status, 400);
  const missingReport = parse400(missing.body);
  assert.equal(missingReport.stage, 'structure');
  assert.deepEqual(missingReport.problems, [
    { pointer: '/id', expected: 'integer（必填字段）', actual: 'missing' },
  ]);

  // 根为 null：被接受，且取得序列第 1 项（证明上面的 400 未消费）
  const rootNull = await sendRequest(server.port, post('/n/root', 'null'));
  assert.equal(rootNull.status, SCENE_STATUS, `根可空应接受 null：${rootNull.body}`);
  assert.equal(rootNull.body, SCENE_BODY);

  // 合格对象：取得序列第 2 项
  const rootObj = await sendRequest(server.port, post('/n/root', '{"id":1}'));
  assert.equal(rootObj.status, SECOND_STATUS, `应取得序列第 2 项：${rootObj.body}`);
  assert.equal(rootObj.body, SECOND_BODY);

  // 空正文不等于 null：解析阶段拒绝
  const empty = await sendRequest(server.port, post('/n/root', ''));
  assert.equal(empty.status, 400);
  assert.equal(parse400(empty.body).stage, 'parse', '空正文应是解析失败，不等于 null');

  // 可空不放宽媒体类型：text/plain 的 null 仍拒绝
  const wrongMedia = await sendRequest(server.port, {
    method: 'POST',
    path: '/n/root',
    headers: { 'Content-Type': 'text/plain' },
    body: 'null',
  });
  assert.equal(wrongMedia.status, 400);
  assert.equal(parse400(wrongMedia.body).stage, 'parse', '可空不放宽媒体类型检查');

  // 必填字段 id 不可空：null 值被拒绝
  const idNull = await sendRequest(server.port, post('/n/root', '{"id":null}'));
  assert.equal(idNull.status, 400);
  assert.deepEqual(parse400(idNull.body).problems, [
    { pointer: '/id', expected: 'integer', actual: 'null' },
  ]);

  // —— 嵌套可空 ——
  // 必填可空字段以 null 出现：接受
  const aNull = await sendRequest(server.port, post('/n/nested', '{"a":null}'));
  assert.equal(aNull.status, SCENE_STATUS, `必填可空字段接受 null：${aNull.body}`);

  // 必填可空字段缺失：仍拒绝（可空不等于可缺省）
  const aMissing = await sendRequest(server.port, post('/n/nested', '{}'));
  assert.equal(aMissing.status, 400);
  assert.deepEqual(parse400(aMissing.body).problems, [
    { pointer: '/a', expected: 'string（必填字段）', actual: 'missing' },
  ]);

  // 可空对象为 null：不产生子节点差异（c 的必填 x 不再检查）
  const cNull = await sendRequest(server.port, post('/n/nested', '{"a":"x","c":null}'));
  assert.equal(cNull.status, SCENE_STATUS, `可空对象为 null 时不应产生子节点差异：${cNull.body}`);

  // 非 null 继续检查全部原约束：c 为对象时必填 x 仍检查
  const cEmpty = await sendRequest(server.port, post('/n/nested', '{"a":"x","c":{}}'));
  assert.equal(cEmpty.status, 400);
  assert.deepEqual(parse400(cEmpty.body).problems, [
    { pointer: '/c/x', expected: 'integer（必填字段）', actual: 'missing' },
  ]);

  // 可空数组元素
  const itemsOk = await sendRequest(server.port, post('/n/nested', '{"a":"x","b":[1,null,2]}'));
  assert.equal(itemsOk.status, SCENE_STATUS, `可空数组元素接受 null：${itemsOk.body}`);

  // 非 null 元素仍按原约束检查
  const itemsBad = await sendRequest(server.port, post('/n/nested', '{"a":"x","b":[null,"s"]}'));
  assert.equal(itemsBad.status, 400);
  assert.deepEqual(parse400(itemsBad.body).problems, [
    { pointer: '/b/1', expected: 'integer', actual: 'string' },
  ]);
});

// ---------------------------------------------------------------------------
// 非法可空规则：整份拒绝（compare 退出 2、stderr 定位、stdout 为空）
// ---------------------------------------------------------------------------

test('非法可空规则整份拒绝：非布尔值、未知字段、数组缺 items', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const good = await writeConfig(dir, 'good.json', {
    endpoints: [{ method: 'POST', path: '/ok', responses: [sceneResponse()] }],
  });

  const cases: Array<{ name: string; rule: unknown; expect: RegExp }> = [
    {
      name: 'nullable 非布尔',
      rule: { type: 'string', nullable: 'yes' },
      expect: /endpoints\[0\]\.requestBody\.nullable 必须是布尔值/,
    },
    {
      name: '字段级 nullable 非布尔',
      rule: { type: 'object', fields: { a: { type: 'string', nullable: 1 } } },
      expect: /endpoints\[0\]\.requestBody\.fields\["a"\]\.nullable 必须是布尔值/,
    },
    {
      name: '可空数组缺 items',
      rule: { type: 'array', nullable: true },
      expect: /endpoints\[0\]\.requestBody\.items/,
    },
    {
      name: '可空规则含未知字段',
      rule: { type: 'string', nullable: true, minLength: 1 },
      expect: /endpoints\[0\]\.requestBody 含未知字段 "minLength"/,
    },
    {
      name: '可空数组元素的非法子规则',
      rule: { type: 'array', items: { type: 'integer', nullable: true, minimum: 0 } },
      expect: /endpoints\[0\]\.requestBody\.items 含未知字段 "minimum"/,
    },
  ];

  for (const [i, c] of cases.entries()) {
    const bad = await writeConfig(dir, `bad-${i}.json`, {
      endpoints: [
        { method: 'POST', path: '/x', requestBody: c.rule, responses: [sceneResponse()] },
      ],
    });
    const result = await runCompare(bad, good);
    assert.equal(result.code, 2, `${c.name}：应退出 2`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位规则位置：\n${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// reload：成功原子替换并递增版本，失败保留旧状态
// ---------------------------------------------------------------------------

test('reload：可空规则热更新成功替换、失败保留旧状态', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configPath = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/r',
        requestBody: { type: 'string' },
        responses: [sceneResponse()],
      },
    ],
  });
  const server = await startServer(configPath);
  t.after(server.close);

  // v1 不可空：null 被拒绝
  const before = await sendRequest(server.port, post('/r', 'null'));
  assert.equal(before.status, 400, '旧规则不可空，null 应被拒绝');

  // 成功 reload：规则原子替换为可空，版本 +1
  await writeText(
    dir,
    'scenes.json',
    `${JSON.stringify({
      endpoints: [
        {
          method: 'POST',
          path: '/r',
          requestBody: { type: 'string', nullable: true },
          responses: [sceneResponse()],
        },
      ],
    })}\n`,
  );
  const reload1 = await sendRequest(server.port, {
    method: 'POST',
    path: '/__contractlab/reload',
    headers: {},
    body: '',
  });
  assert.deepEqual(JSON.parse(reload1.body), { ok: true, version: 2 });

  const afterNull = await sendRequest(server.port, post('/r', 'null'));
  assert.equal(afterNull.status, SCENE_STATUS, `新规则应接受 null：${afterNull.body}`);
  const afterStr = await sendRequest(server.port, post('/r', '"txt"'));
  assert.equal(afterStr.status, SCENE_STATUS, `非 null 仍按原约束接受：${afterStr.body}`);

  // 失败 reload（nullable 非布尔）：保留旧状态与版本
  await writeText(
    dir,
    'scenes.json',
    `${JSON.stringify({
      endpoints: [
        {
          method: 'POST',
          path: '/r',
          requestBody: { type: 'string', nullable: 'yes' },
          responses: [sceneResponse()],
        },
      ],
    })}\n`,
  );
  const reload2 = await sendRequest(server.port, {
    method: 'POST',
    path: '/__contractlab/reload',
    headers: {},
    body: '',
  });
  const reload2Body = JSON.parse(reload2.body);
  assert.equal(reload2Body.ok, false, `非法可空规则应 reload 失败：${reload2.body}`);
  assert.equal(reload2Body.version, 2, '失败 reload 不得递增版本');

  // 旧（可空）状态继续生效
  const stillNull = await sendRequest(server.port, post('/r', 'null'));
  assert.equal(stillNull.status, SCENE_STATUS, `失败 reload 后旧规则继续生效：${stillNull.body}`);
  const health = await sendRequest(server.port, {
    method: 'GET',
    path: '/__contractlab/health',
    headers: {},
    body: '',
  });
  assert.deepEqual(JSON.parse(health.body), { status: 'ok', version: 2 });
});

// ---------------------------------------------------------------------------
// verify：与 serve 对相同请求字节结论一致
// ---------------------------------------------------------------------------

test('verify：可空规则下与在线结论一致（含空正文与缺失字段）', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/v',
        requestBody: {
          type: 'object',
          nullable: true,
          fields: {
            id: { type: 'integer', required: true },
            a: { type: 'string', nullable: true },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
    ],
  });
  const server = await startServer(config);
  t.after(server.close);

  // 在线结论：前两条接受，后三条拒绝（结构缺失 / 空正文解析 / 类型）
  const requests: RawRequest[] = [
    post('/v', 'null'),
    post('/v', '{"id":1,"a":null}'),
    post('/v', '{"a":null}'),
    post('/v', ''),
    post('/v', '{"id":"s"}'),
  ];
  const online: boolean[] = [];
  for (const req of requests) {
    const res = await sendRequest(server.port, req);
    online.push(res.status === SCENE_STATUS);
  }
  assert.deepEqual(online, [true, true, false, false, false], '在线结论应符合预期');

  // 快照 -> verify：对相同请求字节给出一致结论
  const snapshot = await sendRequest(server.port, {
    method: 'GET',
    path: '/__contractlab/requests',
    headers: {},
    body: '',
  });
  const snapshotFile = await writeText(dir, 'snapshot.json', snapshot.body);
  const result = await runVerify(snapshotFile, config);
  assert.equal(result.code, 1, `存在拒绝记录，退出码应为 1\nstderr:\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.total, 5);
  assert.equal(report.accepted, 2);
  assert.equal(report.rejected, 3);

  const records = JSON.parse(snapshot.body).records as Array<{
    id: number;
    bodyValidationPassed: boolean | null;
    bodyRejection: unknown;
  }>;
  assert.equal(records.length, 5);
  for (const record of records) {
    const entry = report.results.find((r: { id: number }) => r.id === record.id);
    assert.ok(entry !== undefined, `报告应包含记录 ${record.id}`);
    const expectedOutcome = record.bodyValidationPassed === true ? 'passed' : 'rejected';
    assert.equal(
      entry.outcome,
      expectedOutcome,
      `记录 ${record.id}：verify 结论应与在线一致（在线 bodyValidationPassed=${record.bodyValidationPassed}）`,
    );
    if (expectedOutcome === 'rejected') {
      assert.deepEqual(
        entry.rejection,
        record.bodyRejection,
        `记录 ${record.id}：verify 拒绝报告应与在线实际返回的差异报告一致`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// compare：可空包含关系与反例真实重放
// ---------------------------------------------------------------------------

test('compare：可空包含关系、null 反例定位与真实服务重放', { timeout: 180_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const oldConfig = {
    endpoints: [
      // 加宽：新增可空，兼容
      { method: 'POST', path: '/c/widen', requestBody: { type: 'string' }, responses: [sceneResponse()] },
      // type:null -> 可空 string：null 仍接受，兼容
      { method: 'POST', path: '/c/null-ok', requestBody: { type: 'null' }, responses: [sceneResponse()] },
      // 移除根可空：不兼容（反例为根 null）
      { method: 'POST', path: '/c/narrow', requestBody: { type: 'string', nullable: true }, responses: [sceneResponse()] },
      // 移除嵌套字段可空：不兼容（反例含必要父对象与其他必填字段）
      {
        method: 'POST',
        path: '/c/nested',
        requestBody: {
          type: 'object',
          fields: {
            id: { type: 'integer', required: true },
            buyer: {
              type: 'object',
              required: true,
              fields: {
                name: { type: 'string', required: true },
                tag: { type: 'string', nullable: true },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      // 可空不能掩盖非 null 收紧：number -> nullable integer，反例是非整数而非 null
      { method: 'POST', path: '/c/mask', requestBody: { type: 'number' }, responses: [sceneResponse()] },
      // 移除数组元素可空：不兼容（反例为含 null 的非空数组）
      {
        method: 'POST',
        path: '/c/items',
        requestBody: { type: 'array', items: { type: 'integer', nullable: true } },
        responses: [sceneResponse()],
      },
    ],
  };
  const newConfig = {
    endpoints: [
      { method: 'POST', path: '/c/widen', requestBody: { type: 'string', nullable: true }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/null-ok', requestBody: { type: 'string', nullable: true }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/narrow', requestBody: { type: 'string' }, responses: [sceneResponse()] },
      {
        method: 'POST',
        path: '/c/nested',
        requestBody: {
          type: 'object',
          fields: {
            id: { type: 'integer', required: true },
            buyer: {
              type: 'object',
              required: true,
              fields: {
                name: { type: 'string', required: true },
                tag: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      { method: 'POST', path: '/c/mask', requestBody: { type: 'integer', nullable: true }, responses: [sceneResponse()] },
      {
        method: 'POST',
        path: '/c/items',
        requestBody: { type: 'array', items: { type: 'integer' } },
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

  // 兼容接口
  for (const key of ['POST /c/widen', 'POST /c/null-ok']) {
    const ep = byKey.get(key);
    assert.equal(ep.compatible, true, `${key} 应判为兼容`);
    assert.equal(ep.reasons.length, 0, `${key} 不应有原因`);
  }

  // 不兼容接口：结论、原因指针与反例形状
  const incompatible = ['POST /c/narrow', 'POST /c/nested', 'POST /c/mask', 'POST /c/items'];
  for (const key of incompatible) {
    const ep = byKey.get(key);
    assert.ok(ep !== undefined, `报告应包含旧接口 ${key}`);
    assert.equal(ep.compatible, false, `${key} 应判为不兼容`);
    assert.ok(ep.reasons.length >= 1, `${key} 应至少给出一处原因`);
    assert.ok(ep.example !== undefined, `${key} 应给出完整请求反例`);
  }

  // 根 null 反例：正文就是 null
  const narrow = byKey.get('POST /c/narrow');
  assert.equal(narrow.example.body, 'null', '移除根可空的反例应为根 null');
  assert.ok(
    narrow.reasons.some((r: { pointer?: string }) => r.pointer === ''),
    `根可空变化的原因应定位到根（""）：${JSON.stringify(narrow.reasons)}`,
  );

  // 嵌套 null 反例：包含必要父对象与其他必填字段
  const nested = byKey.get('POST /c/nested');
  assert.ok(
    nested.reasons.some((r: { pointer?: string }) => r.pointer === '/buyer/tag'),
    `嵌套可空变化的原因应定位到 /buyer/tag：${JSON.stringify(nested.reasons)}`,
  );
  const nestedBody = JSON.parse(nested.example.body);
  assert.equal(typeof nestedBody.id, 'number', '嵌套反例应包含其他必填字段 id');
  assert.equal(typeof nestedBody.buyer?.name, 'string', '嵌套反例应包含父对象的必填字段 name');
  assert.equal(nestedBody.buyer?.tag, null, '嵌套反例的差异字段应为 null');

  // 可空不掩盖非 null 收紧：反例必须是非整数（旧接受、新拒绝），而不是 null
  const mask = byKey.get('POST /c/mask');
  const maskValue = JSON.parse(mask.example.body);
  assert.equal(typeof maskValue, 'number', 'number -> nullable integer 的反例应是数字');
  assert.ok(!Number.isInteger(maskValue), `反例应是非整数（null 会被新规则接受）：${mask.example.body}`);

  // 数组元素可空移除：反例是含 null 的非空数组
  const items = byKey.get('POST /c/items');
  assert.deepEqual(JSON.parse(items.example.body), [null], '元素可空移除的反例应为 [null]');

  // 真实重放：反例在旧服务被接受（场景成功响应），在新服务被正文校验拒绝（400）
  const oldServer = await startServer(oldFile);
  t.after(oldServer.close);
  const newServer = await startServer(newFile);
  t.after(newServer.close);

  for (const key of incompatible) {
    const example = byKey.get(key).example as RawRequest;
    const label = `${key} 的反例 ${example.method} ${example.path} 正文=${example.body}`;

    const oldRes = await sendRequest(oldServer.port, example);
    assert.equal(oldRes.status, SCENE_STATUS, `${label}\n旧服务应接受该请求`);
    assert.equal(oldRes.body, SCENE_BODY, `${label}\n旧服务应返回场景正文`);

    const newRes = await sendRequest(newServer.port, example);
    assert.equal(newRes.status, 400, `${label}\n新服务应以 400 拒绝：${newRes.body}`);
    const report400 = parse400(newRes.body);
    assert.equal(report400.stage, 'structure', `${label}\n拒绝应发生在结构比对阶段`);
  }
});

// ---------------------------------------------------------------------------
// import：nullable 转换（根 / 字段 / items / $ref）与真实 serve 核对
// ---------------------------------------------------------------------------

test('import：基础 schema 的 nullable:true（根、字段、items、$ref）', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec(
    {
      '/i/basic': {
        post: {
          requestBody: jsonBody({
            type: 'object',
            nullable: true,
            properties: {
              a: { type: 'string', nullable: true },
              b: { type: 'array', items: { $ref: '#/components/schemas/N' } },
            },
            required: ['a'],
          }),
        },
      },
    },
    { schemas: { N: { type: 'integer', nullable: true } } },
  ));
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/i/basic', responses: [sceneResponse()] }],
  });

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `导入应成功\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.endpoints[0].requestBody, {
    type: 'object',
    nullable: true,
    fields: {
      a: { type: 'string', nullable: true, required: true },
      b: { type: 'array', items: { type: 'integer', nullable: true } },
    },
    additionalProperties: true,
  });

  // 导入结果可直接用于真实 serve
  const imported = await writeText(dir, 'imported.json', result.stdout);
  const server = await startServer(imported);
  t.after(server.close);

  const rootNull = await sendRequest(server.port, post('/i/basic', 'null'));
  assert.equal(rootNull.status, SCENE_STATUS, `根可空应接受 null：${rootNull.body}`);
  const aNull = await sendRequest(server.port, post('/i/basic', '{"a":null}'));
  assert.equal(aNull.status, SCENE_STATUS, `必填可空字段接受 null：${aNull.body}`);
  const itemsNull = await sendRequest(server.port, post('/i/basic', '{"a":"x","b":[1,null]}'));
  assert.equal(itemsNull.status, SCENE_STATUS, `可空元素接受 null：${itemsNull.body}`);
  const aMissing = await sendRequest(server.port, post('/i/basic', '{}'));
  assert.equal(aMissing.status, 400, '必填可空字段仍不得缺失');
  const itemBad = await sendRequest(server.port, post('/i/basic', '{"a":"x","b":["s"]}'));
  assert.equal(itemBad.status, 400, '非 null 元素仍按原约束检查');
});

test('import：nullable 非法用法拒绝（非布尔、allOf 组合节点、引用节点带字段）', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/a', responses: [sceneResponse()] }],
  });

  const cases: Array<{ name: string; schema: unknown; expect: RegExp }> = [
    {
      name: 'nullable 非布尔',
      schema: { type: 'string', nullable: 1 },
      expect: /\.nullable.*必须是布尔值/,
    },
    {
      name: 'allOf 组合节点 nullable:true',
      schema: { nullable: true, allOf: [{ type: 'object' }, { type: 'object' }] },
      expect: /\.nullable.*组合节点/,
    },
    {
      name: '嵌套 allOf 组合节点 nullable:true',
      schema: { allOf: [{ allOf: [{ type: 'object' }], nullable: true }] },
      expect: /\.nullable.*组合节点/,
    },
    {
      name: '引用节点带 nullable',
      schema: { $ref: '#/components/schemas/N', nullable: true },
      expect: /引用节点不得包含其他字段/,
    },
  ];

  for (const [i, c] of cases.entries()) {
    const api = await writeConfig(
      dir,
      `api-${i}.json`,
      spec({ '/a': { post: { requestBody: jsonBody(c.schema) } } }, { schemas: { N: { type: 'string' } } }),
    );
    const result = await runImport(api, config);
    assert.equal(result.code, 2, `${c.name}：应退出 2\nstdout:\n${result.stdout}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位原因：\n${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// import：可空对象 allOf 交集——仅剩 null 时输出 type:null
// ---------------------------------------------------------------------------

test('import：可空对象交集仅剩 null 输出 type:null；任一分支不可空则空交集拒绝', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const branch = (nullable: boolean, xType: string): unknown => ({
    type: 'object',
    ...(nullable ? { nullable: true } : {}),
    properties: { x: { type: xType } },
    required: ['x'],
  });

  // 两个可空对象分支都要求 x，分别约束 string 与 integer：
  // 非 null 交集为空，但双方都接受 null -> 交集恰为 {null}
  const api = await writeConfig(dir, 'api.json', spec({
    '/i/inter': { post: { requestBody: jsonBody({ allOf: [branch(true, 'string'), branch(true, 'integer')] }) } },
    // 字段级版本：p 的交集同样仅剩 null
    '/i/field': {
      post: {
        requestBody: jsonBody({
          type: 'object',
          properties: { p: { allOf: [branch(true, 'string'), branch(true, 'integer')] } },
        }),
      },
    },
  }));
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      { method: 'POST', path: '/i/inter', responses: [sceneResponse()] },
      { method: 'POST', path: '/i/field', responses: [sceneResponse()] },
    ],
  });

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `全部分支可空时应成功导入为仅接受 null\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.endpoints[0].requestBody,
    { type: 'null' },
    '仅剩 null 的交集应输出 type:null',
  );
  assert.deepEqual(
    (output.endpoints[1].requestBody as { fields: Record<string, unknown> }).fields.p,
    { type: 'null' },
    '字段级仅剩 null 的交集同样输出 type:null',
  );

  // 导入结果用于真实 serve：仅接受 null
  const imported = await writeText(dir, 'imported.json', result.stdout);
  const server = await startServer(imported);
  t.after(server.close);

  const onlyNull = await sendRequest(server.port, post('/i/inter', 'null'));
  assert.equal(onlyNull.status, SCENE_STATUS, `交集结果应接受 null：${onlyNull.body}`);
  for (const body of ['{}', '{"x":1}', '{"x":"s"}']) {
    const res = await sendRequest(server.port, post('/i/inter', body));
    assert.equal(res.status, 400, `交集结果仅接受 null，${body} 应被拒绝`);
  }
  const fieldNull = await sendRequest(server.port, post('/i/field', '{"p":null}'));
  assert.equal(fieldNull.status, SCENE_STATUS, `字段级交集结果应接受 p 为 null：${fieldNull.body}`);
  const fieldObj = await sendRequest(server.port, post('/i/field', '{"p":{}}'));
  assert.equal(fieldObj.status, 400, '字段级交集结果仅接受 p 为 null');

  // 任一分支不可空：整体空交集，拒绝
  for (const [i, branches] of [
    [branch(false, 'string'), branch(true, 'integer')],
    [branch(true, 'string'), branch(false, 'integer')],
    [branch(false, 'string'), branch(false, 'integer')],
  ].entries()) {
    const badApi = await writeConfig(
      dir,
      `api-nonnullable-${i}.json`,
      spec({ '/i/inter': { post: { requestBody: jsonBody({ allOf: branches }) } } }),
    );
    const badConfig = await writeConfig(dir, `scenes-${i}.json`, {
      endpoints: [{ method: 'POST', path: '/i/inter', responses: [sceneResponse()] }],
    });
    const rejected = await runImport(badApi, badConfig);
    assert.equal(rejected.code, 2, `任一分支不可空时应以空交集拒绝（组合 ${i}）`);
    assert.equal(rejected.stdout, '', '失败时 stdout 必须为空');
    assert.ok(
      rejected.stderr.includes('交集为空') || rejected.stderr.includes('没有共同接受的值'),
      `stderr 应说明空交集原因：\n${rejected.stderr}`,
    );
    assert.ok(
      rejected.stderr.includes('paths["/i/inter"]'),
      `stderr 应定位操作位置：\n${rejected.stderr}`,
    );
  }
});

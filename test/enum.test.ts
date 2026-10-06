// 请求正文标量枚举（requestBody 标量节点的 enum 候选数组）回归测试
//
// 覆盖：
// - serve：根、字段、数组元素的枚举接受/拒绝；数字按数值相等（0 与 -0 等价，
//   不做类型转换）；可空不越过枚举（null 须列入枚举）；必填枚举字段不得缺失；
//   类型错误不重复报枚举错误；枚举拒绝沿用 structure 差异报告（RFC 6901 指针、
//   候选值、实际值）且不消费响应序列；媒体类型 / UTF-8 / JSON 检查不放宽；
// - 非法枚举规则（object/array 节点、空数组、类型不符、null 项无可空、非数组）
//   整份拒绝：compare 退出 2、stderr 定位、stdout 为空；
// - reload：成功原子替换规则与响应并递增版本，失败保留旧状态；
// - verify：与 serve 对相同请求字节结论一致；
// - compare：枚举增删、枚举与非枚举规则交叉（number 枚举全为整数时兼容非枚举
//   integer）、可空与枚举交集的精确包含判定；每个不兼容反例原样重放到分别
//   加载旧、新配置的真实本机服务（旧接受、新拒绝）；
// - import：基础标量 schema 的 enum（根 / 字段 / items / 本文件内 $ref）转换；
//   非法枚举拒绝；纯对象 allOf 同名字段递归求类型、枚举、可空交集（枚举交集、
//   number∩integer 带枚举、空交集仅剩 null 输出 type:null、可选字段空交集的
//   闭合省略与开放拒绝、分支换序结论一致）；导入结果用于真实 serve 核对。

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
// serve：枚举的在线校验（根 / 字段 / 数组元素 / 可空交集 / 不消费序列）
// ---------------------------------------------------------------------------

test('serve：枚举接受与拒绝、报告格式、类型错误不重复报枚举、拒绝不消费序列', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const SECOND_STATUS = 288;
  const SECOND_BODY = 'contractlab-second-item';
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        // 根枚举：string 候选
        method: 'POST',
        path: '/e/root',
        requestBody: { type: 'string', enum: ['created', 'paid'] },
        responses: [
          sceneResponse(),
          { status: SECOND_STATUS, headers: {}, body: SECOND_BODY, delay: 0 },
        ],
      },
      {
        // 字段与数组元素枚举；可空枚举；数字枚举（0 与 -0 等价）
        method: 'POST',
        path: '/e/nested',
        requestBody: {
          type: 'object',
          fields: {
            id: { type: 'integer', enum: [1, 2, 3], required: true },
            tag: { type: 'string', nullable: true, enum: ['x', null] },
            code: { type: 'string', nullable: true, enum: ['y'] },
            nums: { type: 'array', items: { type: 'number', enum: [0, 1.5] } },
            flag: { type: 'boolean', enum: [true] },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
    ],
  });
  const server = await startServer(config);
  t.after(server.close);

  // —— 根枚举 ——
  // 先制造一次 400：不消费序列
  const bad = await sendRequest(server.port, post('/e/root', '"archived"'));
  assert.equal(bad.status, 400);
  const badReport = parse400(bad.body);
  assert.equal(badReport.stage, 'structure');
  assert.deepEqual(badReport.problems, [
    { pointer: '', expected: '枚举 ["created","paid"] 之一', actual: '"archived"' },
  ]);

  // 合格请求取得序列第 1 项（证明上面的 400 未消费）
  const ok1 = await sendRequest(server.port, post('/e/root', '"created"'));
  assert.equal(ok1.status, SCENE_STATUS, `枚举候选应被接受：${ok1.body}`);
  assert.equal(ok1.body, SCENE_BODY);
  const ok2 = await sendRequest(server.port, post('/e/root', '"paid"'));
  assert.equal(ok2.status, SECOND_STATUS, `应取得序列第 2 项：${ok2.body}`);

  // 类型错误不重复报枚举错误：只有类型差异一条
  const wrongType = await sendRequest(server.port, post('/e/root', '1'));
  assert.equal(wrongType.status, 400);
  assert.deepEqual(parse400(wrongType.body).problems, [
    { pointer: '', expected: 'string', actual: 'number' },
  ]);

  // 枚举不放宽媒体类型检查
  const wrongMedia = await sendRequest(server.port, {
    method: 'POST',
    path: '/e/root',
    headers: { 'Content-Type': 'text/plain' },
    body: '"created"',
  });
  assert.equal(wrongMedia.status, 400);
  assert.equal(parse400(wrongMedia.body).stage, 'parse', '枚举不放宽媒体类型检查');

  // —— 嵌套枚举 ——
  // 全部候选命中（含可空字段为 null、数字 -0 等价 0）
  const nestedOk = await sendRequest(
    server.port,
    post('/e/nested', '{"id":2,"tag":null,"code":"y","nums":[0,-0,1.5],"flag":true}'),
  );
  assert.equal(nestedOk.status, SCENE_STATUS, `枚举候选（含 null 与 -0）应被接受：${nestedOk.body}`);

  // 可选枚举字段可缺省
  const omitted = await sendRequest(server.port, post('/e/nested', '{"id":1}'));
  assert.equal(omitted.status, SCENE_STATUS, `可选枚举字段可缺省：${omitted.body}`);

  // 必填枚举字段不得缺失
  const missing = await sendRequest(server.port, post('/e/nested', '{"tag":"x"}'));
  assert.equal(missing.status, 400);
  assert.deepEqual(parse400(missing.body).problems, [
    { pointer: '/id', expected: 'integer（必填字段）', actual: 'missing' },
  ]);

  // 可空不越过枚举：code 可空但枚举不含 null
  const nullNotListed = await sendRequest(server.port, post('/e/nested', '{"id":1,"code":null}'));
  assert.equal(nullNotListed.status, 400);
  assert.deepEqual(parse400(nullNotListed.body).problems, [
    { pointer: '/code', expected: '枚举 ["y"] 之一', actual: 'null' },
  ]);

  // 多处枚举差异一次列全（字段 + 数组元素下标 + 布尔候选）
  const multi = await sendRequest(
    server.port,
    post('/e/nested', '{"id":9,"tag":"z","nums":[0,2],"flag":false}'),
  );
  assert.equal(multi.status, 400);
  assert.deepEqual(parse400(multi.body).problems, [
    { pointer: '/id', expected: '枚举 [1,2,3] 之一', actual: '9' },
    { pointer: '/tag', expected: '枚举 ["x",null] 之一', actual: '"z"' },
    { pointer: '/nums/1', expected: '枚举 [0,1.5] 之一', actual: '2' },
    { pointer: '/flag', expected: '枚举 [true] 之一', actual: 'false' },
  ]);

  // 数组元素类型错误同样不重复报枚举错误
  const itemType = await sendRequest(server.port, post('/e/nested', '{"id":1,"nums":["0"]}'));
  assert.equal(itemType.status, 400);
  assert.deepEqual(parse400(itemType.body).problems, [
    { pointer: '/nums/0', expected: 'number', actual: 'string' },
  ]);
});

// ---------------------------------------------------------------------------
// 非法枚举规则：整份拒绝（compare 退出 2、stderr 定位、stdout 为空）
// ---------------------------------------------------------------------------

test('非法枚举规则整份拒绝：object/array 节点、空数组、类型不符、null 项无可空', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const good = await writeConfig(dir, 'good.json', {
    endpoints: [{ method: 'POST', path: '/ok', responses: [sceneResponse()] }],
  });

  const cases: Array<{ name: string; rule: unknown; expect: RegExp }> = [
    {
      name: 'object 节点禁止 enum',
      rule: { type: 'object', enum: ['a'] },
      expect: /endpoints\[0\]\.requestBody 含未知字段 "enum"/,
    },
    {
      name: 'array 节点禁止 enum',
      rule: { type: 'array', items: { type: 'string' }, enum: [['a']] },
      expect: /endpoints\[0\]\.requestBody 含未知字段 "enum"/,
    },
    {
      name: 'enum 为空数组',
      rule: { type: 'string', enum: [] },
      expect: /endpoints\[0\]\.requestBody\.enum 必须是非空数组/,
    },
    {
      name: 'enum 不是数组',
      rule: { type: 'string', enum: 'a' },
      expect: /endpoints\[0\]\.requestBody\.enum 必须是非空数组/,
    },
    {
      name: 'string 枚举含数字（不做类型转换）',
      rule: { type: 'string', enum: ['a', 1] },
      expect: /endpoints\[0\]\.requestBody\.enum\[1\] 必须是 string/,
    },
    {
      name: 'integer 枚举含非整数',
      rule: { type: 'integer', enum: [1, 0.5] },
      expect: /endpoints\[0\]\.requestBody\.enum\[1\] 必须是 integer/,
    },
    {
      name: 'number 枚举含字符串数字（不做类型转换）',
      rule: { type: 'number', enum: ['1'] },
      expect: /endpoints\[0\]\.requestBody\.enum\[0\] 必须是 number/,
    },
    {
      name: 'boolean 枚举含 0',
      rule: { type: 'boolean', enum: [true, 0] },
      expect: /endpoints\[0\]\.requestBody\.enum\[1\] 必须是 boolean/,
    },
    {
      name: 'null 项要求可空',
      rule: { type: 'string', enum: ['a', null] },
      expect: /endpoints\[0\]\.requestBody\.enum\[1\] 为 null/,
    },
    {
      name: 'type:null 枚举含非 null 项',
      rule: { type: 'null', enum: [null, 0] },
      expect: /endpoints\[0\]\.requestBody\.enum\[1\] 必须是 null/,
    },
    {
      name: '嵌套字段的非法枚举',
      rule: { type: 'object', fields: { a: { type: 'integer', enum: ['x'] } } },
      expect: /endpoints\[0\]\.requestBody\.fields\["a"\]\.enum\[0\] 必须是 integer/,
    },
    {
      name: '数组元素的非法枚举',
      rule: { type: 'array', items: { type: 'string', enum: [] } },
      expect: /endpoints\[0\]\.requestBody\.items\.enum 必须是非空数组/,
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

test('reload：枚举规则热更新成功替换、失败保留旧状态', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const configPath = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/r',
        requestBody: { type: 'string', enum: ['a'] },
        responses: [sceneResponse()],
      },
    ],
  });
  const server = await startServer(configPath);
  t.after(server.close);

  // v1：仅 "a" 被接受
  const before = await sendRequest(server.port, post('/r', '"b"'));
  assert.equal(before.status, 400, '旧枚举不含 "b"，应被拒绝');

  // 成功 reload：枚举原子替换，版本 +1
  await writeText(
    dir,
    'scenes.json',
    `${JSON.stringify({
      endpoints: [
        {
          method: 'POST',
          path: '/r',
          requestBody: { type: 'string', enum: ['a', 'b'] },
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

  const afterB = await sendRequest(server.port, post('/r', '"b"'));
  assert.equal(afterB.status, SCENE_STATUS, `新枚举应接受 "b"：${afterB.body}`);
  const afterC = await sendRequest(server.port, post('/r', '"c"'));
  assert.equal(afterC.status, 400, '新枚举仍拒绝 "c"');

  // 失败 reload（object 节点带 enum）：保留旧状态与版本
  await writeText(
    dir,
    'scenes.json',
    `${JSON.stringify({
      endpoints: [
        {
          method: 'POST',
          path: '/r',
          requestBody: { type: 'object', enum: ['a'] },
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
  assert.equal(reload2Body.ok, false, `非法枚举规则应 reload 失败：${reload2.body}`);
  assert.equal(reload2Body.version, 2, '失败 reload 不得递增版本');

  // 旧（v2）枚举继续生效
  const stillB = await sendRequest(server.port, post('/r', '"b"'));
  assert.equal(stillB.status, SCENE_STATUS, `失败 reload 后旧规则继续生效：${stillB.body}`);
  const stillC = await sendRequest(server.port, post('/r', '"c"'));
  assert.equal(stillC.status, 400, '失败 reload 后旧枚举仍拒绝 "c"');
});

// ---------------------------------------------------------------------------
// verify：与 serve 对相同请求字节结论一致
// ---------------------------------------------------------------------------

test('verify：枚举规则下与在线结论一致', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/v',
        requestBody: {
          type: 'object',
          fields: {
            id: { type: 'integer', enum: [1, 2], required: true },
            tag: { type: 'string', nullable: true, enum: ['x', null] },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
    ],
  });
  const server = await startServer(config);
  t.after(server.close);

  const requests: RawRequest[] = [
    post('/v', '{"id":1,"tag":null}'),
    post('/v', '{"id":2}'),
    post('/v', '{"id":3}'),
    post('/v', '{"id":1,"code":null}'),
    post('/v', '{"id":"1"}'),
  ];
  const online: boolean[] = [];
  for (const req of requests) {
    const res = await sendRequest(server.port, req);
    online.push(res.status === SCENE_STATUS);
  }
  assert.deepEqual(online, [true, true, false, false, false], '在线结论应符合预期');

  // 快照 -> verify：对相同请求字节给出一致结论（含完全一致的拒绝报告）
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
// compare：枚举包含关系与反例真实重放
// ---------------------------------------------------------------------------

test('compare：枚举包含关系、交叉比较与反例真实服务重放', { timeout: 180_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const oldConfig = {
    endpoints: [
      // 枚举扩充：兼容
      { method: 'POST', path: '/c/grow', requestBody: { type: 'string', enum: ['a'] }, responses: [sceneResponse()] },
      // 移除枚举：兼容
      { method: 'POST', path: '/c/drop', requestBody: { type: 'string', enum: ['a', 'b'] }, responses: [sceneResponse()] },
      // number 枚举全为整数 -> 非枚举 integer：兼容
      { method: 'POST', path: '/c/int-ok', requestBody: { type: 'number', enum: [1, 2, 3] }, responses: [sceneResponse()] },
      // 枚举值删去：不兼容
      { method: 'POST', path: '/c/shrink', requestBody: { type: 'string', enum: ['a', 'b'] }, responses: [sceneResponse()] },
      // 新增枚举限制：不兼容
      { method: 'POST', path: '/c/introduce', requestBody: { type: 'string' }, responses: [sceneResponse()] },
      // number 枚举含非整数 -> integer：不兼容（反例为非整数枚举值）
      { method: 'POST', path: '/c/int-bad', requestBody: { type: 'number', enum: [1, 0.5] }, responses: [sceneResponse()] },
      // boolean 枚举收紧：不兼容（反例为 false）
      { method: 'POST', path: '/c/bool', requestBody: { type: 'boolean' }, responses: [sceneResponse()] },
      // 移除含 null 的枚举可空：不兼容（反例为 null）
      { method: 'POST', path: '/c/nullable', requestBody: { type: 'string', nullable: true, enum: ['x', null] }, responses: [sceneResponse()] },
      // 嵌套字段枚举收紧：不兼容（反例含必要父对象与必填字段）
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
              fields: { state: { type: 'string', enum: ['new', 'paid'], required: true } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      // 数组元素枚举收紧：不兼容（反例为非空数组）
      {
        method: 'POST',
        path: '/c/items',
        requestBody: { type: 'array', items: { type: 'integer', enum: [1, 2] } },
        responses: [sceneResponse()],
      },
    ],
  };
  const newConfig = {
    endpoints: [
      { method: 'POST', path: '/c/grow', requestBody: { type: 'string', enum: ['a', 'b'] }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/drop', requestBody: { type: 'string' }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/int-ok', requestBody: { type: 'integer' }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/shrink', requestBody: { type: 'string', enum: ['a'] }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/introduce', requestBody: { type: 'string', enum: ['a', 'b'] }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/int-bad', requestBody: { type: 'integer' }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/bool', requestBody: { type: 'boolean', enum: [true] }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/nullable', requestBody: { type: 'string', enum: ['x'] }, responses: [sceneResponse()] },
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
              fields: { state: { type: 'string', enum: ['new'], required: true } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      {
        method: 'POST',
        path: '/c/items',
        requestBody: { type: 'array', items: { type: 'integer', enum: [1] } },
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
  for (const key of ['POST /c/grow', 'POST /c/drop', 'POST /c/int-ok']) {
    const ep = byKey.get(key);
    assert.equal(ep.compatible, true, `${key} 应判为兼容`);
    assert.equal(ep.reasons.length, 0, `${key} 不应有原因`);
  }

  // 不兼容接口：结论、原因与反例形状
  const incompatible = [
    'POST /c/shrink',
    'POST /c/introduce',
    'POST /c/int-bad',
    'POST /c/bool',
    'POST /c/nullable',
    'POST /c/nested',
    'POST /c/items',
  ];
  for (const key of incompatible) {
    const ep = byKey.get(key);
    assert.ok(ep !== undefined, `报告应包含旧接口 ${key}`);
    assert.equal(ep.compatible, false, `${key} 应判为不兼容`);
    assert.ok(ep.reasons.length >= 1, `${key} 应至少给出一处原因`);
    assert.ok(ep.example !== undefined, `${key} 应给出完整请求反例`);
  }

  // 枚举值删去：反例是被删的候选值
  assert.equal(JSON.parse(byKey.get('POST /c/shrink').example.body), 'b');
  // 新增枚举限制：反例是不在候选中的旧允许值
  const introduced = JSON.parse(byKey.get('POST /c/introduce').example.body);
  assert.equal(typeof introduced, 'string');
  assert.ok(!['a', 'b'].includes(introduced), `反例应不在新枚举候选中：${introduced}`);
  // number 枚举含非整数 -> integer：反例必须是非整数枚举值（整数会被新规则接受）
  assert.equal(JSON.parse(byKey.get('POST /c/int-bad').example.body), 0.5);
  // boolean 枚举收紧：反例为 false
  assert.equal(JSON.parse(byKey.get('POST /c/bool').example.body), false);
  // 移除含 null 的枚举可空：反例为 null
  assert.equal(byKey.get('POST /c/nullable').example.body, 'null');
  // 嵌套字段枚举收紧：反例含必要父对象与必填字段，差异字段为被删候选
  const nested = byKey.get('POST /c/nested');
  assert.ok(
    nested.reasons.some((r: { pointer?: string }) => r.pointer === '/buyer/state'),
    `嵌套枚举变化的原因应定位到 /buyer/state：${JSON.stringify(nested.reasons)}`,
  );
  const nestedBody = JSON.parse(nested.example.body);
  assert.equal(typeof nestedBody.id, 'number', '嵌套反例应包含其他必填字段 id');
  assert.equal(nestedBody.buyer?.state, 'paid', '嵌套反例的差异字段应为被删枚举值');
  // 数组元素枚举收紧：反例为含被删候选的非空数组
  assert.deepEqual(JSON.parse(byKey.get('POST /c/items').example.body), [2]);

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
// import：基础标量 schema 的 enum（根 / 字段 / items / $ref）与真实 serve 核对
// ---------------------------------------------------------------------------

test('import：标量 schema 的 enum（根、字段、items、$ref）与真实 serve 核对', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec(
    {
      '/i/root': {
        post: { requestBody: jsonBody({ type: 'string', enum: ['created', 'paid'] }) },
      },
      '/i/basic': {
        post: {
          requestBody: jsonBody({
            type: 'object',
            properties: {
              id: { type: 'integer', enum: [1, 2, 3] },
              n: { $ref: '#/components/schemas/Num' },
              tag: { type: 'string', nullable: true, enum: ['x', null] },
              nums: { type: 'array', items: { type: 'number', enum: [0, 1.5] } },
            },
            required: ['id'],
          }),
        },
      },
    },
    { schemas: { Num: { type: 'number', enum: [0, 1.5] } } },
  ));
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      { method: 'POST', path: '/i/root', responses: [sceneResponse()] },
      { method: 'POST', path: '/i/basic', responses: [sceneResponse()] },
    ],
  });

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `导入应成功\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.endpoints[0].requestBody, {
    type: 'string',
    enum: ['created', 'paid'],
  });
  assert.deepEqual(output.endpoints[1].requestBody, {
    type: 'object',
    fields: {
      id: { type: 'integer', enum: [1, 2, 3], required: true },
      n: { type: 'number', enum: [0, 1.5] },
      tag: { type: 'string', nullable: true, enum: ['x', null] },
      nums: { type: 'array', items: { type: 'number', enum: [0, 1.5] } },
    },
    additionalProperties: true,
  });

  // 导入结果可直接用于真实 serve
  const imported = await writeText(dir, 'imported.json', result.stdout);
  const server = await startServer(imported);
  t.after(server.close);

  const rootOk = await sendRequest(server.port, post('/i/root', '"paid"'));
  assert.equal(rootOk.status, SCENE_STATUS, `根枚举候选应被接受：${rootOk.body}`);
  const rootBad = await sendRequest(server.port, post('/i/root', '"archived"'));
  assert.equal(rootBad.status, 400, '根枚举外的值应被拒绝');

  const nestedOk = await sendRequest(
    server.port,
    post('/i/basic', '{"id":2,"n":1.5,"tag":null,"nums":[0,-0,1.5]}'),
  );
  assert.equal(nestedOk.status, SCENE_STATUS, `导入的枚举规则应接受候选值：${nestedOk.body}`);
  const nestedBad = await sendRequest(server.port, post('/i/basic', '{"id":4}'));
  assert.equal(nestedBad.status, 400, '导入的枚举规则应拒绝候选外的值');
  const itemBad = await sendRequest(server.port, post('/i/basic', '{"id":1,"nums":[2]}'));
  assert.equal(itemBad.status, 400, '导入的数组元素枚举应拒绝候选外的元素');
});

test('import：非法 enum 拒绝（空数组、类型不符、null 项无可空、object/array 与组合节点）', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/a', responses: [sceneResponse()] }],
  });

  const cases: Array<{ name: string; schema: unknown; expect: RegExp }> = [
    {
      name: 'enum 为空数组',
      schema: { type: 'string', enum: [] },
      expect: /\.enum：必须是非空数组/,
    },
    {
      name: 'enum 不是数组',
      schema: { type: 'string', enum: 'a' },
      expect: /\.enum：必须是非空数组/,
    },
    {
      name: 'integer 枚举含非整数',
      schema: { type: 'integer', enum: [1, 0.5] },
      expect: /\.enum\[1\]：必须是 integer/,
    },
    {
      name: 'string 枚举含数字（不做类型转换）',
      schema: { type: 'string', enum: ['a', 1] },
      expect: /\.enum\[1\]：必须是 string/,
    },
    {
      name: 'null 项要求 nullable:true',
      schema: { type: 'string', enum: ['a', null] },
      expect: /\.enum\[1\]：为 null/,
    },
    {
      name: 'object schema 禁止 enum',
      schema: { type: 'object', enum: ['a'] },
      expect: /含未支持的关键字 "enum"/,
    },
    {
      name: 'array schema 禁止 enum',
      schema: { type: 'array', items: { type: 'string' }, enum: [['a']] },
      expect: /含未支持的关键字 "enum"/,
    },
    {
      name: 'allOf 组合节点禁止 enum',
      schema: { allOf: [{ type: 'object' }, { type: 'object' }], enum: ['a'] },
      expect: /组合节点仅允许 allOf/,
    },
    {
      name: '引用节点带 enum',
      schema: { $ref: '#/components/schemas/N', enum: ['a'] },
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
// import：纯对象 allOf 的枚举交集
// ---------------------------------------------------------------------------

test('import：allOf 同名字段递归求类型、枚举、可空交集（换序结论一致）', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);

  // 同名字段枚举交集 + number∩integer 带枚举；分支换序结论一致
  const branchA = {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['new', 'paid', 'archived'] },
      n: { type: 'number', enum: [1, 0.5] },
    },
    required: ['state', 'n'],
  };
  const branchB = {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['paid', 'archived', 'done'] },
      n: { type: 'integer' },
    },
    required: ['state'],
  };
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/i/inter', responses: [sceneResponse()] }],
  });

  const outputs: unknown[] = [];
  for (const [i, branches] of [[branchA, branchB], [branchB, branchA]].entries()) {
    const api = await writeConfig(
      dir,
      `api-order-${i}.json`,
      spec({ '/i/inter': { post: { requestBody: jsonBody({ allOf: branches }) } } }),
    );
    const result = await runImport(api, config);
    assert.equal(result.code, 0, `分支顺序 ${i}：导入应成功\nstderr:\n${result.stderr}`);
    outputs.push(JSON.parse(result.stdout));
  }
  assert.deepEqual(outputs[0], outputs[1], '分支换序不应改变导入结论');
  const rule = (outputs[0] as { endpoints: Array<{ requestBody: unknown }> }).endpoints[0]
    .requestBody;
  assert.deepEqual(rule, {
    type: 'object',
    fields: {
      // 枚举交集 ["paid","archived"]（顺序取首个声明分支的候选顺序）
      state: { type: 'string', enum: ['paid', 'archived'], required: true },
      // number 枚举 [1, 0.5] ∩ integer 取 integer 枚举 [1]
      n: { type: 'integer', enum: [1], required: true },
    },
    additionalProperties: true,
  });

  // 导入结果用于真实 serve
  const imported = await writeText(dir, 'imported.json', JSON.stringify(outputs[0]));
  const server = await startServer(imported);
  t.after(server.close);
  const ok = await sendRequest(server.port, post('/i/inter', '{"state":"paid","n":1}'));
  assert.equal(ok.status, SCENE_STATUS, `交集候选应被接受：${ok.body}`);
  const badState = await sendRequest(server.port, post('/i/inter', '{"state":"new","n":1}'));
  assert.equal(badState.status, 400, '被另一分支枚举排除的值应被拒绝');
  const badN = await sendRequest(server.port, post('/i/inter', '{"state":"paid","n":0.5}'));
  assert.equal(badN.status, 400, '被类型交集排除的枚举值应被拒绝');
});

test('import：枚举交集为空——全部分支可空输出 type:null，任一分支不可空则拒绝', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const branch = (nullable: boolean, values: string[]): unknown => ({
    type: 'object',
    ...(nullable ? { nullable: true } : {}),
    properties: { x: { type: 'string', enum: values } },
    required: ['x'],
  });

  // 两个可空对象分支的必填同名字段枚举交集为空：非 null 交集为空，双方都接受
  // null -> 交集恰为 {null}
  const api = await writeConfig(dir, 'api.json', spec({
    '/i/nullonly': { post: { requestBody: jsonBody({ allOf: [branch(true, ['a']), branch(true, ['b'])] }) } },
  }));
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/i/nullonly', responses: [sceneResponse()] }],
  });

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `全部分支可空时应成功导入为仅接受 null\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.endpoints[0].requestBody, { type: 'null' }, '仅剩 null 的交集应输出 type:null');

  // 导入结果用于真实 serve：仅接受 null
  const imported = await writeText(dir, 'imported.json', result.stdout);
  const server = await startServer(imported);
  t.after(server.close);
  const onlyNull = await sendRequest(server.port, post('/i/nullonly', 'null'));
  assert.equal(onlyNull.status, SCENE_STATUS, `交集结果应接受 null：${onlyNull.body}`);
  for (const body of ['{}', '{"x":"a"}', '{"x":"b"}']) {
    const res = await sendRequest(server.port, post('/i/nullonly', body));
    assert.equal(res.status, 400, `交集结果仅接受 null，${body} 应被拒绝`);
  }

  // 任一分支不可空：整体空交集，拒绝
  for (const [i, branches] of [
    [branch(false, ['a']), branch(true, ['b'])],
    [branch(true, ['a']), branch(false, ['b'])],
    [branch(false, ['a']), branch(false, ['b'])],
  ].entries()) {
    const badApi = await writeConfig(
      dir,
      `api-nonnullable-${i}.json`,
      spec({ '/i/nullonly': { post: { requestBody: jsonBody({ allOf: branches }) } } }),
    );
    const rejected = await runImport(badApi, config);
    assert.equal(rejected.code, 2, `任一分支不可空时应以空交集拒绝（组合 ${i}）`);
    assert.equal(rejected.stdout, '', '失败时 stdout 必须为空');
    assert.ok(
      rejected.stderr.includes('枚举候选的交集为空'),
      `stderr 应说明枚举空交集原因：\n${rejected.stderr}`,
    );
    assert.ok(
      rejected.stderr.includes('paths["/i/nullonly"]'),
      `stderr 应定位操作位置：\n${rejected.stderr}`,
    );
  }
});

test('import：可选字段枚举交集为空——闭合对象省略该字段，开放对象无法表达则拒绝', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/i/opt', responses: [sceneResponse()] }],
  });

  // 闭合对象：可选字段 x 的枚举交集为空 -> 结果不声明 x 即“禁止出现”，可表达
  const closedApi = await writeConfig(dir, 'api-closed.json', spec({
    '/i/opt': {
      post: {
        requestBody: jsonBody({
          allOf: [
            {
              type: 'object',
              properties: { x: { type: 'string', enum: ['a'] } },
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { x: { type: 'string', enum: ['b'] } },
              additionalProperties: false,
            },
          ],
        }),
      },
    },
  }));
  const closed = await runImport(closedApi, config);
  assert.equal(closed.code, 0, `闭合对象应成功（省略被禁止的可选字段）\nstderr:\n${closed.stderr}`);
  const closedRule = JSON.parse(closed.stdout).endpoints[0].requestBody;
  assert.deepEqual(closedRule, { type: 'object', fields: {}, additionalProperties: false });

  // 导入结果用于真实 serve：x 出现即拒绝，省略则接受
  const imported = await writeText(dir, 'imported-closed.json', closed.stdout);
  const server = await startServer(imported);
  t.after(server.close);
  const omitted = await sendRequest(server.port, post('/i/opt', '{}'));
  assert.equal(omitted.status, SCENE_STATUS, `省略被禁止字段应被接受：${omitted.body}`);
  for (const body of ['{"x":"a"}', '{"x":"b"}']) {
    const res = await sendRequest(server.port, post('/i/opt', body));
    assert.equal(res.status, 400, `被禁止字段 ${body} 应被拒绝`);
  }

  // 开放对象：无法表达“仅禁止该字段、其他字段任意” -> 拒绝
  const openApi = await writeConfig(dir, 'api-open.json', spec({
    '/i/opt': {
      post: {
        requestBody: jsonBody({
          allOf: [
            { type: 'object', properties: { x: { type: 'string', enum: ['a'] } } },
            { type: 'object', properties: { x: { type: 'string', enum: ['b'] } } },
          ],
        }),
      },
    },
  }));
  const open = await runImport(openApi, config);
  assert.equal(open.code, 2, '开放对象应以无法表达拒绝');
  assert.equal(open.stdout, '', '失败时 stdout 必须为空');
  assert.ok(
    open.stderr.includes('无法表达'),
    `stderr 应说明无法表达原因：\n${open.stderr}`,
  );
});

test('import：数组元素枚举交集为空以无法表达拒绝；可达非法枚举不因字段被禁止而忽略', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/i/arr', responses: [sceneResponse()] }],
  });

  // 数组元素枚举交集为空：交集仅剩空数组，现有规则种类无法表达 -> 拒绝
  // （两个对象分支的同名数组字段，其元素枚举相交为空）
  const arrApi = await writeConfig(dir, 'api-arr.json', spec({
    '/i/arr': {
      post: {
        requestBody: jsonBody({
          allOf: [
            {
              type: 'object',
              properties: { arr: { type: 'array', items: { type: 'string', enum: ['a'] } } },
              required: ['arr'],
            },
            {
              type: 'object',
              properties: { arr: { type: 'array', items: { type: 'string', enum: ['b'] } } },
              required: ['arr'],
            },
          ],
        }),
      },
    },
  }));
  const arr = await runImport(arrApi, config);
  assert.equal(arr.code, 2, '数组元素枚举交集为空应以无法表达拒绝');
  assert.equal(arr.stdout, '', '失败时 stdout 必须为空');
  assert.ok(
    arr.stderr.includes('无法表达'),
    `stderr 应说明无法表达原因：\n${arr.stderr}`,
  );

  // 可选字段 x 被封闭分支禁止出现（不进入结果），但声明分支中 x 的枚举非法：
  // 可达非法枚举不因字段最终被禁止而忽略
  const badEnumApi = await writeConfig(dir, 'api-bad-enum.json', spec({
    '/i/arr': {
      post: {
        requestBody: jsonBody({
          allOf: [
            { type: 'object', properties: { x: { type: 'integer', enum: [0.5] } } },
            { type: 'object', additionalProperties: false },
          ],
        }),
      },
    },
  }));
  const badEnum = await runImport(badEnumApi, config);
  assert.equal(badEnum.code, 2, '被禁止字段中的非法枚举仍应拒绝');
  assert.equal(badEnum.stdout, '', '失败时 stdout 必须为空');
  assert.ok(
    /\.enum\[0\]：必须是 integer/.test(badEnum.stderr),
    `stderr 应定位非法枚举：\n${badEnum.stderr}`,
  );
});

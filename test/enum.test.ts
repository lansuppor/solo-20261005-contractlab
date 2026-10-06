// 请求正文标量枚举（requestBody 标量节点的 enum 候选值）回归测试
//
// 覆盖：
// - serve：根、字段、数组元素的枚举校验；数字按数值相等（0 与 -0 等价）、
//   不做类型转换；可空不越过枚举（接受 null 须将其列入 enum）；类型错误不
//   重复报枚举错误；枚举拒绝沿用 structure 差异报告（RFC 6901 位置、候选值、
//   实际值）且不消费响应序列；
// - 非法枚举规则整份拒绝：object/array 节点附 enum、空枚举、非数组、枚举项
//   类型不符、null 项出现在不可空节点、integer 枚举含非整数（compare 退出 2、
//   stderr 定位、stdout 为空）；
// - reload：成功原子替换规则与响应、版本递增并重置序列；失败保留旧状态；
// - verify：与 serve 对相同请求字节结论一致；
// - compare：枚举增删、枚举与非枚举规则交叉（number 枚举全为整数时兼容非枚举
//   integer）、可空变化；不兼容反例（含必要父对象与必填字段）原样重放到分别
//   加载旧、新配置的真实本机服务（旧接受、新拒绝）；
// - import：基础标量 schema 的 enum（根 / 字段 / items / 本文件内 $ref）、
//   非法枚举拒绝（空数组、项类型不符、null 项不可空、object/array schema、
//   allOf 组合节点）、纯对象 allOf 同名字段的枚举交集（分支换序结论不变、
//   枚举与非枚举相交、交集为空的三种情形、可空且 null 在各方枚举中时交集
//   含 null、可达非法枚举不因字段被禁止而忽略），导入结果用于真实 serve 核对。

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
// serve：根、字段、数组元素的枚举校验与差异报告
// ---------------------------------------------------------------------------

test('serve：枚举接受/拒绝、数值相等、不做类型转换、拒绝不消费序列', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const SECOND_STATUS = 288;
  const SECOND_BODY = 'contractlab-enum-second';
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        // 根标量枚举
        method: 'POST',
        path: '/e/root',
        requestBody: { type: 'string', enum: ['created', 'paid'] },
        responses: [
          sceneResponse(),
          { status: SECOND_STATUS, headers: {}, body: SECOND_BODY, delay: 0 },
        ],
      },
      {
        // 字段与数组元素枚举；数字枚举含 -0（与 0 数值相等）
        method: 'POST',
        path: '/e/nested',
        requestBody: {
          type: 'object',
          fields: {
            n: { type: 'integer', enum: [1, 2, -0], required: true },
            tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
            note: { type: 'string', nullable: true, enum: ['x', null] },
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
  // 先制造一次枚举拒绝：不消费序列
  const bad = await sendRequest(server.port, post('/e/root', '"shipped"'));
  assert.equal(bad.status, 400);
  const badReport = parse400(bad.body);
  assert.equal(badReport.stage, 'structure');
  assert.deepEqual(badReport.problems, [
    { pointer: '', expected: '枚举候选值之一 ["created","paid"]', actual: '"shipped"' },
  ]);

  // 合格请求取得序列第 1 项（证明上面的 400 未消费）
  const ok1 = await sendRequest(server.port, post('/e/root', '"created"'));
  assert.equal(ok1.status, SCENE_STATUS, `枚举内值应被接受：${ok1.body}`);
  assert.equal(ok1.body, SCENE_BODY);
  const ok2 = await sendRequest(server.port, post('/e/root', '"paid"'));
  assert.equal(ok2.status, SECOND_STATUS, `合格请求应取得序列第 2 项：${ok2.body}`);

  // 类型错误不重复报枚举错误：只有类型差异一条
  const wrongType = await sendRequest(server.port, post('/e/root', '1'));
  assert.equal(wrongType.status, 400);
  assert.deepEqual(parse400(wrongType.body).problems, [
    { pointer: '', expected: 'string', actual: 'number' },
  ]);

  // —— 嵌套枚举 ——
  // 数值相等：-0 与 0 等价（枚举含 -0，发送 0 同样接受）
  const zero = await sendRequest(server.port, post('/e/nested', '{"n":0}'));
  assert.equal(zero.status, SCENE_STATUS, `0 与 -0 等价：${zero.body}`);
  const negZero = await sendRequest(server.port, post('/e/nested', '{"n":-0}'));
  assert.equal(negZero.status, SCENE_STATUS, `-0 与 0 等价：${negZero.body}`);

  // 不做类型转换：字符串 "1" 不等于数字 1（类型错误，仅一条）
  const noCoercion = await sendRequest(server.port, post('/e/nested', '{"n":"1"}'));
  assert.equal(noCoercion.status, 400);
  assert.deepEqual(parse400(noCoercion.body).problems, [
    { pointer: '/n', expected: 'integer', actual: 'string' },
  ]);

  // 数组元素枚举：列出全部差异（含元素下标）
  const itemsBad = await sendRequest(
    server.port,
    post('/e/nested', '{"n":1,"tags":["a","c","b","d"]}'),
  );
  assert.equal(itemsBad.status, 400);
  assert.deepEqual(parse400(itemsBad.body).problems, [
    { pointer: '/tags/1', expected: '枚举候选值之一 ["a","b"]', actual: '"c"' },
    { pointer: '/tags/3', expected: '枚举候选值之一 ["a","b"]', actual: '"d"' },
  ]);

  // 可空且 null 列入枚举：接受 null
  const noteNull = await sendRequest(server.port, post('/e/nested', '{"n":2,"note":null}'));
  assert.equal(noteNull.status, SCENE_STATUS, `null 列入枚举且可空：应接受：${noteNull.body}`);

  // 可空不越过枚举：候选值之外的字符串仍拒绝
  const noteBad = await sendRequest(server.port, post('/e/nested', '{"n":2,"note":"y"}'));
  assert.equal(noteBad.status, 400);
  assert.deepEqual(parse400(noteBad.body).problems, [
    { pointer: '/note', expected: '枚举候选值之一 ["x",null]', actual: '"y"' },
  ]);

  // 必填枚举字段缺失：仍是缺失差异（必填不能缺失）
  const missing = await sendRequest(server.port, post('/e/nested', '{}'));
  assert.equal(missing.status, 400);
  assert.deepEqual(parse400(missing.body).problems, [
    { pointer: '/n', expected: 'integer（必填字段）', actual: 'missing' },
  ]);
});

test('serve：可空节点枚举不含 null 时拒绝 null；枚举不放宽媒体类型与解析检查', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/e/nullable',
        requestBody: { type: 'string', nullable: true, enum: ['a', 'b'] },
        responses: [sceneResponse()],
      },
    ],
  });
  const server = await startServer(config);
  t.after(server.close);

  // 可空但枚举不含 null：null 被拒绝（可空不越过枚举）
  const nullRes = await sendRequest(server.port, post('/e/nullable', 'null'));
  assert.equal(nullRes.status, 400);
  assert.deepEqual(parse400(nullRes.body).problems, [
    { pointer: '', expected: '枚举候选值之一 ["a","b"]', actual: 'null' },
  ]);

  // 枚举内值仍接受
  const ok = await sendRequest(server.port, post('/e/nullable', '"a"'));
  assert.equal(ok.status, SCENE_STATUS, `枚举内值应被接受：${ok.body}`);

  // 枚举不放宽媒体类型检查：text/plain 的枚举内值仍是解析阶段拒绝
  const wrongMedia = await sendRequest(server.port, {
    method: 'POST',
    path: '/e/nullable',
    headers: { 'Content-Type': 'text/plain' },
    body: '"a"',
  });
  assert.equal(wrongMedia.status, 400);
  assert.equal(parse400(wrongMedia.body).stage, 'parse', '枚举不放宽媒体类型检查');

  // 空正文仍是解析失败，不等于 null
  const empty = await sendRequest(server.port, post('/e/nullable', ''));
  assert.equal(empty.status, 400);
  assert.equal(parse400(empty.body).stage, 'parse', '空正文不等于 null');
});

// ---------------------------------------------------------------------------
// 非法枚举规则：整份拒绝（compare 退出 2、stderr 定位、stdout 为空）
// ---------------------------------------------------------------------------

test('非法枚举规则整份拒绝：object/array 节点、空枚举、项类型不符、null 项不可空', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const good = await writeConfig(dir, 'good.json', {
    endpoints: [{ method: 'POST', path: '/ok', responses: [sceneResponse()] }],
  });

  const cases: Array<{ name: string; rule: unknown; expect: RegExp }> = [
    {
      name: 'object 节点禁止 enum',
      rule: { type: 'object', enum: ['a'] },
      expect: /endpoints\[0\]\.requestBody.*enum 仅允许附加在标量节点/,
    },
    {
      name: 'array 节点禁止 enum',
      rule: { type: 'array', items: { type: 'string' }, enum: [['a']] },
      expect: /endpoints\[0\]\.requestBody.*enum 仅允许附加在标量节点/,
    },
    {
      name: '空枚举',
      rule: { type: 'string', enum: [] },
      expect: /endpoints\[0\]\.requestBody\.enum 必须是非空数组/,
    },
    {
      name: 'enum 非数组',
      rule: { type: 'string', enum: 'a' },
      expect: /endpoints\[0\]\.requestBody\.enum 必须是非空数组/,
    },
    {
      name: '枚举项类型不符',
      rule: { type: 'string', enum: ['a', 1] },
      expect: /endpoints\[0\]\.requestBody\.enum\[1\]/,
    },
    {
      name: 'integer 枚举含非整数',
      rule: { type: 'integer', enum: [1, 0.5] },
      expect: /endpoints\[0\]\.requestBody\.enum\[1\]/,
    },
    {
      name: '不可空节点枚举含 null',
      rule: { type: 'string', enum: ['a', null] },
      expect: /endpoints\[0\]\.requestBody\.enum\[1\]/,
    },
    {
      name: '字段级非法枚举',
      rule: { type: 'object', fields: { a: { type: 'number', enum: ['x'] } } },
      expect: /endpoints\[0\]\.requestBody\.fields\["a"\]\.enum\[0\]/,
    },
    {
      name: '数组元素非法枚举',
      rule: { type: 'array', items: { type: 'boolean', enum: [true, 1] } },
      expect: /endpoints\[0\]\.requestBody\.items\.enum\[1\]/,
    },
    {
      name: 'type:null 枚举含非 null',
      rule: { type: 'null', enum: [null, 'x'] },
      expect: /endpoints\[0\]\.requestBody\.enum\[1\]/,
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
// reload：成功原子替换（版本递增、序列重置），失败保留旧状态
// ---------------------------------------------------------------------------

test('reload：枚举规则热更新成功替换、失败保留旧状态', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const SECOND_STATUS = 288;
  const SECOND_BODY = 'contractlab-enum-reload-second';
  const configPath = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/r',
        requestBody: { type: 'string', enum: ['a'] },
        responses: [
          sceneResponse(),
          { status: SECOND_STATUS, headers: {}, body: SECOND_BODY, delay: 0 },
        ],
      },
    ],
  });
  const server = await startServer(configPath);
  t.after(server.close);

  // v1：枚举内值接受（消费序列第 1 项），枚举外值拒绝
  const before = await sendRequest(server.port, post('/r', '"a"'));
  assert.equal(before.status, SCENE_STATUS);
  const rejected = await sendRequest(server.port, post('/r', '"b"'));
  assert.equal(rejected.status, 400, '旧枚举应拒绝 "b"');

  // 成功 reload：枚举原子替换，版本 +1，序列重置（再次取得第 1 项）
  await writeText(
    dir,
    'scenes.json',
    `${JSON.stringify({
      endpoints: [
        {
          method: 'POST',
          path: '/r',
          requestBody: { type: 'string', enum: ['b'] },
          responses: [
            sceneResponse(),
            { status: SECOND_STATUS, headers: {}, body: SECOND_BODY, delay: 0 },
          ],
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
  assert.equal(afterB.status, SCENE_STATUS, `新枚举应接受 "b" 且序列已重置：${afterB.body}`);
  assert.equal(afterB.body, SCENE_BODY, '序列重置后应再次取得第 1 项');
  const afterA = await sendRequest(server.port, post('/r', '"a"'));
  assert.equal(afterA.status, 400, '新枚举应拒绝 "a"');

  // 失败 reload（空枚举）：保留旧状态与版本
  await writeText(
    dir,
    'scenes.json',
    `${JSON.stringify({
      endpoints: [
        {
          method: 'POST',
          path: '/r',
          requestBody: { type: 'string', enum: [] },
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
  assert.equal(reload2Body.ok, false, `非法枚举应 reload 失败：${reload2.body}`);
  assert.equal(reload2Body.version, 2, '失败 reload 不得递增版本');
  assert.ok(reload2Body.error.includes('enum'), `失败原因应定位枚举：${reload2Body.error}`);

  // 旧（v2）规则继续生效
  const stillB = await sendRequest(server.port, post('/r', '"b"'));
  assert.equal(stillB.status, SECOND_STATUS, `失败 reload 后旧规则继续生效：${stillB.body}`);
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
            state: { type: 'string', enum: ['created', 'paid'], required: true },
            note: { type: 'string', nullable: true, enum: ['x', null] },
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
    post('/v', '{"state":"paid","note":null}'),
    post('/v', '{"state":"shipped"}'),
    post('/v', '{"state":1}'),
    post('/v', '{"state":"created","note":"y"}'),
  ];
  const online: boolean[] = [];
  for (const req of requests) {
    const res = await sendRequest(server.port, req);
    online.push(res.status === SCENE_STATUS);
  }
  assert.deepEqual(online, [true, false, false, false], '在线结论应符合预期');

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
  assert.equal(report.total, 4);
  assert.equal(report.accepted, 1);
  assert.equal(report.rejected, 3);

  const records = JSON.parse(snapshot.body).records as Array<{
    id: number;
    bodyValidationPassed: boolean | null;
    bodyRejection: unknown;
  }>;
  for (const record of records) {
    const entry = report.results.find((r: { id: number }) => r.id === record.id);
    assert.ok(entry !== undefined, `报告应包含记录 ${record.id}`);
    const expectedOutcome = record.bodyValidationPassed === true ? 'passed' : 'rejected';
    assert.equal(entry.outcome, expectedOutcome, `记录 ${record.id}：verify 结论应与在线一致`);
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

test('compare：枚举增删、与非枚举交叉、可空变化；反例真实重放', { timeout: 180_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const oldConfig = {
    endpoints: [
      // number 枚举全为整数 -> 非枚举 integer：兼容
      { method: 'POST', path: '/c/int-enum', requestBody: { type: 'number', enum: [1, 2] }, responses: [sceneResponse()] },
      // 移除枚举：更宽松，兼容
      { method: 'POST', path: '/c/remove', requestBody: { type: 'string', enum: ['a'] }, responses: [sceneResponse()] },
      // 布尔全枚举 -> 无枚举：兼容
      { method: 'POST', path: '/c/bool-full', requestBody: { type: 'boolean', enum: [true, false] }, responses: [sceneResponse()] },
      // 新增枚举：不兼容
      { method: 'POST', path: '/c/add', requestBody: { type: 'string' }, responses: [sceneResponse()] },
      // 枚举含非整数 -> integer：不兼容
      { method: 'POST', path: '/c/fraction', requestBody: { type: 'number', enum: [0.5, 1] }, responses: [sceneResponse()] },
      // 嵌套字段枚举收紧：反例保留必要父对象与必填字段
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
                state: { type: 'string', enum: ['created', 'paid'] },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      // 可空枚举移除 null：不兼容（反例为 null）
      {
        method: 'POST',
        path: '/c/null-removed',
        requestBody: { type: 'string', nullable: true, enum: ['x', null] },
        responses: [sceneResponse()],
      },
      // 数组元素枚举收紧：反例为非空数组
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
      { method: 'POST', path: '/c/int-enum', requestBody: { type: 'integer' }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/remove', requestBody: { type: 'string' }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/bool-full', requestBody: { type: 'boolean' }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/add', requestBody: { type: 'string', enum: ['a', 'b'] }, responses: [sceneResponse()] },
      { method: 'POST', path: '/c/fraction', requestBody: { type: 'integer' }, responses: [sceneResponse()] },
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
                state: { type: 'string', enum: ['created'] },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      {
        method: 'POST',
        path: '/c/null-removed',
        requestBody: { type: 'string', nullable: true, enum: ['x'] },
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
  for (const key of ['POST /c/int-enum', 'POST /c/remove', 'POST /c/bool-full']) {
    const ep = byKey.get(key);
    assert.equal(ep.compatible, true, `${key} 应判为兼容`);
    assert.equal(ep.reasons.length, 0, `${key} 不应有原因`);
  }

  // 不兼容接口：结论、原因与反例
  const incompatible = [
    'POST /c/add',
    'POST /c/fraction',
    'POST /c/nested',
    'POST /c/null-removed',
    'POST /c/items',
  ];
  for (const key of incompatible) {
    const ep = byKey.get(key);
    assert.ok(ep !== undefined, `报告应包含旧接口 ${key}`);
    assert.equal(ep.compatible, false, `${key} 应判为不兼容`);
    assert.ok(ep.reasons.length >= 1, `${key} 应至少给出一处原因`);
    assert.ok(ep.example !== undefined, `${key} 应给出完整请求反例`);
  }

  // 枚举含非整数 -> integer：反例必须是非整数（0.5）
  const fraction = byKey.get('POST /c/fraction');
  assert.equal(JSON.parse(fraction.example.body), 0.5, '反例应是旧枚举中的非整数');

  // 嵌套枚举收紧：反例含必要父对象与其他必填字段，差异字段取旧枚举中被移除的值
  const nested = byKey.get('POST /c/nested');
  assert.ok(
    nested.reasons.some((r: { pointer?: string }) => r.pointer === '/buyer/state'),
    `嵌套枚举收紧的原因应定位到 /buyer/state：${JSON.stringify(nested.reasons)}`,
  );
  const nestedBody = JSON.parse(nested.example.body);
  assert.equal(typeof nestedBody.id, 'number', '嵌套反例应包含其他必填字段 id');
  assert.equal(typeof nestedBody.buyer?.name, 'string', '嵌套反例应包含父对象必填字段 name');
  assert.equal(nestedBody.buyer?.state, 'paid', '差异字段应取被新枚举移除的旧候选值');

  // 可空枚举移除 null：反例为根 null
  const nullRemoved = byKey.get('POST /c/null-removed');
  assert.equal(nullRemoved.example.body, 'null', '移除枚举中的 null，反例应为根 null');

  // 数组元素枚举收紧：反例为含被移除候选值的非空数组
  const items = byKey.get('POST /c/items');
  assert.deepEqual(JSON.parse(items.example.body), [2], '元素枚举收紧的反例应为 [2]');

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
    assert.equal(parse400(newRes.body).stage, 'structure', `${label}\n拒绝应发生在结构比对阶段`);
  }
});

// ---------------------------------------------------------------------------
// import：基础标量 schema 的 enum（根 / 字段 / items / $ref）与真实 serve 核对
// ---------------------------------------------------------------------------

test('import：基础标量 schema 的 enum（根、字段、items、$ref）', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const api = await writeConfig(dir, 'api.json', spec(
    {
      '/i/enum': {
        post: {
          requestBody: jsonBody({
            type: 'object',
            properties: {
              state: { type: 'string', enum: ['created', 'paid', 'paid'] },
              n: { type: 'number', enum: [1, 0.5] },
              tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
              note: { type: 'string', nullable: true, enum: ['x', null] },
            },
            required: ['state'],
          }),
        },
      },
    },
    { schemas: { Tag: { type: 'string', enum: ['a', 'b'] } } },
  ));
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/i/enum', responses: [sceneResponse()] }],
  });

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `导入应成功\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.endpoints[0].requestBody, {
    type: 'object',
    fields: {
      state: { type: 'string', enum: ['created', 'paid'], required: true },
      n: { type: 'number', enum: [1, 0.5] },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      note: { type: 'string', nullable: true, enum: ['x', null] },
    },
    additionalProperties: true,
  });

  // 导入结果可直接用于真实 serve
  const imported = await writeText(dir, 'imported.json', result.stdout);
  const server = await startServer(imported);
  t.after(server.close);

  const ok = await sendRequest(
    server.port,
    post('/i/enum', '{"state":"paid","n":0.5,"tags":["a","b"],"note":null,"extra":1}'),
  );
  assert.equal(ok.status, SCENE_STATUS, `枚举内值（含 null 与额外字段）应被接受：${ok.body}`);
  const badState = await sendRequest(server.port, post('/i/enum', '{"state":"shipped"}'));
  assert.equal(badState.status, 400, '枚举外值应被拒绝');
  assert.deepEqual(parse400(badState.body).problems, [
    { pointer: '/state', expected: '枚举候选值之一 ["created","paid"]', actual: '"shipped"' },
  ]);
  const badItem = await sendRequest(server.port, post('/i/enum', '{"state":"paid","tags":["c"]}'));
  assert.equal(badItem.status, 400, '数组元素枚举外值应被拒绝');
  const badN = await sendRequest(server.port, post('/i/enum', '{"state":"paid","n":2}'));
  assert.equal(badN.status, 400, '数字枚举外值应被拒绝');
});

test('import：非法枚举拒绝（空数组、项类型不符、null 项不可空、object/array schema、组合节点）', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/a', responses: [sceneResponse()] }],
  });

  const cases: Array<{ name: string; schema: unknown; expect: RegExp }> = [
    {
      name: '空枚举',
      schema: { type: 'string', enum: [] },
      expect: /\.enum.*必须是非空数组/,
    },
    {
      name: '枚举项类型不符',
      schema: { type: 'integer', enum: [1, 'x'] },
      expect: /\.enum\[1\]/,
    },
    {
      name: 'null 项不可空',
      schema: { type: 'string', enum: ['a', null] },
      expect: /\.enum\[1\]/,
    },
    {
      name: 'object schema 禁止 enum',
      schema: { type: 'object', enum: ['a'] },
      expect: /未支持的关键字 "enum"/,
    },
    {
      name: 'array schema 禁止 enum',
      schema: { type: 'array', items: { type: 'string' }, enum: [['a']] },
      expect: /未支持的关键字 "enum"/,
    },
    {
      name: 'allOf 组合节点禁止 enum',
      schema: { allOf: [{ type: 'object' }, { type: 'object' }], enum: ['a'] },
      expect: /组合节点.*"enum"/,
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
// import：allOf 同名字段的枚举交集
// ---------------------------------------------------------------------------

test('import：allOf 枚举交集（换序不变、枚举与非枚举相交、可空含 null）', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [
      { method: 'POST', path: '/i/inter', responses: [sceneResponse()] },
      { method: 'POST', path: '/i/num', responses: [sceneResponse()] },
      { method: 'POST', path: '/i/nullable', responses: [sceneResponse()] },
    ],
  });

  // 同名字段枚举交集：["a","b"] ∩ ["b","c"] = ["b"]；分支换序结论不变
  const mkBranches = (first: string[], second: string[]): unknown => ({
    allOf: [
      { type: 'object', properties: { s: { type: 'string', enum: first } }, required: ['s'] },
      { type: 'object', properties: { s: { type: 'string', enum: second } }, required: ['s'] },
    ],
  });
  const api = await writeConfig(dir, 'api.json', spec({
    '/i/inter': { post: { requestBody: jsonBody(mkBranches(['a', 'b'], ['b', 'c'])) } },
    // number 枚举 ∩ 非枚举 integer：{1, 1.5} ∩ integer = integer 枚举 [1]
    '/i/num': {
      post: {
        requestBody: jsonBody({
          allOf: [
            { type: 'object', properties: { n: { type: 'number', enum: [1, 1.5] } }, required: ['n'] },
            { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
          ],
        }),
      },
    },
    // 双方可空且 null 在各自枚举中：交集含 null（输出枚举含 null 且 nullable）
    '/i/nullable': {
      post: {
        requestBody: jsonBody({
          allOf: [
            { type: 'object', properties: { s: { type: 'string', nullable: true, enum: ['a', null] } }, required: ['s'] },
            { type: 'object', properties: { s: { type: 'string', nullable: true, enum: ['a', 'b', null] } }, required: ['s'] },
          ],
        }),
      },
    },
  }));
  const result = await runImport(api, config);
  assert.equal(result.code, 0, `导入应成功\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  const fieldsOf = (index: number): Record<string, unknown> =>
    (output.endpoints[index].requestBody as { fields: Record<string, unknown> }).fields;

  assert.deepEqual(fieldsOf(0).s, { type: 'string', enum: ['b'], required: true });
  assert.deepEqual(fieldsOf(1).n, { type: 'integer', enum: [1], required: true });
  assert.deepEqual(fieldsOf(2).s, {
    type: 'string',
    nullable: true,
    enum: ['a', null],
    required: true,
  });

  // 分支换序：接受集合一致
  const swapped = await writeConfig(dir, 'api-swapped.json', spec({
    '/i/inter': { post: { requestBody: jsonBody(mkBranches(['b', 'c'], ['a', 'b'])) } },
    '/i/num': {
      post: {
        requestBody: jsonBody({
          allOf: [
            { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
            { type: 'object', properties: { n: { type: 'number', enum: [1, 1.5] } }, required: ['n'] },
          ],
        }),
      },
    },
    '/i/nullable': {
      post: {
        requestBody: jsonBody({
          allOf: [
            { type: 'object', properties: { s: { type: 'string', nullable: true, enum: ['a', 'b', null] } }, required: ['s'] },
            { type: 'object', properties: { s: { type: 'string', nullable: true, enum: ['a', null] } }, required: ['s'] },
          ],
        }),
      },
    },
  }));
  const swappedResult = await runImport(swapped, config);
  assert.equal(swappedResult.code, 0, `换序写法应同样成功\nstderr:\n${swappedResult.stderr}`);
  assert.deepEqual(
    JSON.parse(swappedResult.stdout).endpoints,
    output.endpoints,
    '分支换序不应改变导入结果（接受集合一致）',
  );

  // 导入结果用于真实 serve 核对
  const imported = await writeText(dir, 'imported.json', result.stdout);
  const server = await startServer(imported);
  t.after(server.close);

  const inter = await sendRequest(server.port, post('/i/inter', '{"s":"b"}'));
  assert.equal(inter.status, SCENE_STATUS, `交集候选值应被接受：${inter.body}`);
  for (const body of ['{"s":"a"}', '{"s":"c"}']) {
    const res = await sendRequest(server.port, post('/i/inter', body));
    assert.equal(res.status, 400, `交集外的原枚举值 ${body} 应被拒绝`);
  }
  const numInt = await sendRequest(server.port, post('/i/num', '{"n":1}'));
  assert.equal(numInt.status, SCENE_STATUS, `交集整数值应被接受：${numInt.body}`);
  const numFraction = await sendRequest(server.port, post('/i/num', '{"n":1.5}'));
  assert.equal(numFraction.status, 400, 'number 枚举中的非整数不在交集中');
  const numOther = await sendRequest(server.port, post('/i/num', '{"n":2}'));
  assert.equal(numOther.status, 400, '非枚举整数不在交集中');
  const nullOk = await sendRequest(server.port, post('/i/nullable', '{"s":null}'));
  assert.equal(nullOk.status, SCENE_STATUS, `交集含 null 应接受 null：${nullOk.body}`);
  const nullB = await sendRequest(server.port, post('/i/nullable', '{"s":"b"}'));
  assert.equal(nullB.status, 400, '仅一方枚举含有的候选值不在交集中');
});

test('import：枚举交集为空的三种情形与可达非法枚举不忽略', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/a', responses: [sceneResponse()] }],
  });

  const cases: Array<{ name: string; schema: unknown; expect: RegExp }> = [
    {
      name: '必填字段枚举交集为空：整体空交集拒绝',
      schema: {
        allOf: [
          { type: 'object', properties: { s: { type: 'string', enum: ['a'] } }, required: ['s'] },
          { type: 'object', properties: { s: { type: 'string', enum: ['b'] } }, required: ['s'] },
        ],
      },
      expect: /没有共同接受的值|交集为空/,
    },
    {
      name: '可选字段枚举交集为空且各分支开放：非空但无法表达',
      schema: {
        allOf: [
          { type: 'object', properties: { s: { type: 'string', enum: ['a'] } } },
          { type: 'object', properties: { s: { type: 'string', enum: ['b'] } } },
        ],
      },
      expect: /无法表达/,
    },
    {
      name: '数组元素枚举交集为空：仅剩空数组，无法表达',
      schema: {
        allOf: [
          { type: 'object', properties: { t: { type: 'array', items: { type: 'string', enum: ['a'] } } }, required: ['t'] },
          { type: 'object', properties: { t: { type: 'array', items: { type: 'string', enum: ['b'] } } }, required: ['t'] },
        ],
      },
      expect: /无法表达/,
    },
    {
      name: '可达非法枚举不因字段最终被禁止而忽略',
      schema: {
        allOf: [
          // s 被第二支（封闭且未声明）禁止出现；但第一支中 s 的枚举非法，仍须拒绝
          { type: 'object', properties: { s: { type: 'string', enum: [1] } } },
          { type: 'object', additionalProperties: false },
        ],
      },
      expect: /\.enum\[0\]/,
    },
  ];

  for (const [i, c] of cases.entries()) {
    const api = await writeConfig(
      dir,
      `api-${i}.json`,
      spec({ '/a': { post: { requestBody: jsonBody(c.schema) } } }),
    );
    const result = await runImport(api, config);
    assert.equal(result.code, 2, `${c.name}：应退出 2\nstdout:\n${result.stdout}`);
    assert.equal(result.stdout, '', `${c.name}：失败时 stdout 必须为空`);
    assert.ok(c.expect.test(result.stderr), `${c.name}：stderr 应定位原因：\n${result.stderr}`);
    assert.ok(
      result.stderr.includes('paths["/a"]'),
      `${c.name}：stderr 应定位操作位置：\n${result.stderr}`,
    );
  }

  // 可选字段枚举交集为空、结果闭合：省略该字段即可精确表达，成功导入
  const api = await writeConfig(dir, 'api-closed.json', spec({
    '/a': {
      post: {
        requestBody: jsonBody({
          allOf: [
            { type: 'object', properties: { s: { type: 'string', enum: ['a'] } }, additionalProperties: false },
            { type: 'object', properties: { s: { type: 'string', enum: ['b'] } }, additionalProperties: false },
          ],
        }),
      },
    },
  }));
  const result = await runImport(api, config);
  assert.equal(result.code, 0, `闭合对象可省略交集为空的可选字段\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.endpoints[0].requestBody,
    { type: 'object', fields: {}, additionalProperties: false },
    '交集为空的可选字段应被省略（闭合对象禁止其出现）',
  );

  const imported = await writeText(dir, 'imported.json', result.stdout);
  const server = await startServer(imported);
  t.after(server.close);
  const empty = await sendRequest(server.port, post('/a', '{}'));
  assert.equal(empty.status, SCENE_STATUS, `空对象应被接受：${empty.body}`);
  const withS = await sendRequest(server.port, post('/a', '{"s":"a"}'));
  assert.equal(withS.status, 400, '被省略的字段不得出现');
});

test('import：可空分支枚举交集为空仅剩 null 输出 type:null；任一分支不可空则空交集拒绝', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const config = await writeConfig(dir, 'scenes.json', {
    endpoints: [{ method: 'POST', path: '/a', responses: [sceneResponse()] }],
  });

  // 两个可空对象分支的必填同名字段枚举相交为空：非 null 交集为空，
  // 但双方都接受 null -> 交集恰为 {null}（纯对象 allOf 分支须为对象，
  // 枚举驱动的空交集经可空救援后输出 type:null）
  const branch = (nullable: boolean, enumValues: string[]): unknown => ({
    type: 'object',
    ...(nullable ? { nullable: true } : {}),
    properties: { s: { type: 'string', enum: enumValues } },
    required: ['s'],
  });
  const api = await writeConfig(dir, 'api.json', spec({
    '/a': {
      post: {
        requestBody: jsonBody({
          type: 'object',
          properties: { p: { allOf: [branch(true, ['a']), branch(true, ['b'])] } },
          required: ['p'],
        }),
      },
    },
  }));

  const result = await runImport(api, config);
  assert.equal(result.code, 0, `交集仅剩 null 应成功导入\nstderr:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    (output.endpoints[0].requestBody as { fields: Record<string, unknown> }).fields.p,
    { type: 'null', required: true },
    '仅剩 null 的交集应输出 type:null',
  );

  const imported = await writeText(dir, 'imported.json', result.stdout);
  const server = await startServer(imported);
  t.after(server.close);
  const onlyNull = await sendRequest(server.port, post('/a', '{"p":null}'));
  assert.equal(onlyNull.status, SCENE_STATUS, `交集结果应接受 null：${onlyNull.body}`);
  for (const body of ['{"p":{"s":"a"}}', '{"p":{"s":"b"}}', '{"p":{}}']) {
    const res = await sendRequest(server.port, post('/a', body));
    assert.equal(res.status, 400, `交集结果仅接受 null，${body} 应被拒绝`);
  }

  // 任一分支不可空：整体空交集拒绝（可空不能补救非 null 空交集）
  const variants: Array<{ name: string; branches: unknown[] }> = [
    {
      name: '一方不可空',
      branches: [branch(true, ['a']), branch(false, ['b'])],
    },
    {
      name: '双方不可空',
      branches: [branch(false, ['a']), branch(false, ['b'])],
    },
  ];
  for (const [i, v] of variants.entries()) {
    const badApi = await writeConfig(
      dir,
      `api-null-${i}.json`,
      spec({
        '/a': {
          post: {
            requestBody: jsonBody({
              type: 'object',
              properties: { p: { allOf: v.branches } },
              required: ['p'],
            }),
          },
        },
      }),
    );
    const rejected = await runImport(badApi, config);
    assert.equal(rejected.code, 2, `${v.name}：应以空交集拒绝`);
    assert.equal(rejected.stdout, '', '失败时 stdout 必须为空');
    assert.ok(
      rejected.stderr.includes('交集为空') || rejected.stderr.includes('没有共同接受的值'),
      `${v.name}：stderr 应说明空交集原因：\n${rejected.stderr}`,
    );
  }
});

// 典型变更场景的回归测试 + 报告反例的真实重放
//
// 场景（每个都是一对真实场景配置文件 + 一次真实 compare 运行）：
// 不兼容组：
//   1. 双方都允许额外字段，但新版新增可选字段限制取值（additionalProperties 均为 true）
//   2. 必填字段嵌套收紧（嵌套对象内新增必填字段）
//   3. 删除带正文规则的 POST 接口
//   4. 启用正文规则（旧接口无 requestBody，新版启用）
//   5. 特殊字段名：空字段名、__proto__、含斜杠与波浪号的字段名
//      （断言原因中 JSON Pointer 的转义与定位，不断言自然语言措辞与原因排序）
// 兼容组：
//   6. 移除正文规则（更宽松）
//   7. 新增接口
//   8. 仅修改响应（状态/正文/延迟）
//
// 对每个不兼容接口：把报告给出的完整请求反例（方法、路径、请求头、原始正文）
// 原样发送到分别加载旧、新配置的真实本机服务（端口 0，实际监听地址）：
//   - 旧服务必须返回场景配置的可辨认成功响应（299 + contractlab-scene-success）；
//   - 新服务必须返回正文校验 400（且 stage 与变更相符）或接口不存在 404。
// 不使用独立解释器代替实际重放。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCENE_BODY,
  SCENE_STATUS,
  makeTempDir,
  runCompare,
  sceneResponse,
  sendRequest,
  startServer,
  writeConfig,
  type RawRequest,
} from './helpers.ts';

// 特殊字段名场景：字段表必须是无原型对象，否则 "__proto__" 键会被原型 setter 吞掉
function specialNameFields(required: boolean): Record<string, unknown> {
  const fields: Record<string, unknown> = Object.create(null);
  for (const name of ['', '__proto__', 'a/b', 'a~b']) {
    fields[name] = required ? { type: 'string', required: true } : { type: 'string' };
  }
  return fields;
}

const OLD_CONFIG = {
  endpoints: [
    {
      // 场景 1：双方允许额外字段
      method: 'POST',
      path: '/scn/extra-field',
      requestBody: { type: 'object', additionalProperties: true },
      responses: [sceneResponse()],
    },
    {
      // 场景 2：嵌套必填对象
      method: 'POST',
      path: '/scn/nested-required',
      requestBody: {
        type: 'object',
        fields: {
          buyer: {
            type: 'object',
            required: true,
            fields: { name: { type: 'string', required: true } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      responses: [sceneResponse()],
    },
    {
      // 场景 3：将被删除的带正文规则 POST 接口
      method: 'POST',
      path: '/scn/deleted',
      requestBody: {
        type: 'object',
        fields: { id: { type: 'integer', required: true } },
        additionalProperties: false,
      },
      responses: [sceneResponse()],
    },
    {
      // 场景 4：旧版不校验正文
      method: 'POST',
      path: '/scn/enable-rule',
      responses: [sceneResponse()],
    },
    {
      // 场景 5：特殊字段名（全部可选）
      method: 'POST',
      path: '/scn/special-names',
      requestBody: {
        type: 'object',
        fields: specialNameFields(false),
        additionalProperties: false,
      },
      responses: [sceneResponse()],
    },
  ],
};

const NEW_CONFIG = {
  endpoints: [
    {
      // 场景 1：新增可选字段 level，限制旧版自由的额外字段取值
      method: 'POST',
      path: '/scn/extra-field',
      requestBody: {
        type: 'object',
        fields: { level: { type: 'integer' } },
        additionalProperties: true,
      },
      responses: [sceneResponse()],
    },
    {
      // 场景 2：嵌套对象内新增必填字段 email
      method: 'POST',
      path: '/scn/nested-required',
      requestBody: {
        type: 'object',
        fields: {
          buyer: {
            type: 'object',
            required: true,
            fields: {
              name: { type: 'string', required: true },
              email: { type: 'string', required: true },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      responses: [sceneResponse()],
    },
    // 场景 3：/scn/deleted 在新配置中不存在
    {
      // 场景 4：新版启用正文规则
      method: 'POST',
      path: '/scn/enable-rule',
      requestBody: {
        type: 'object',
        fields: { id: { type: 'integer', required: true } },
        additionalProperties: false,
      },
      responses: [sceneResponse()],
    },
    {
      // 场景 5：特殊字段名全部变为必填
      method: 'POST',
      path: '/scn/special-names',
      requestBody: {
        type: 'object',
        fields: specialNameFields(true),
        additionalProperties: false,
      },
      responses: [sceneResponse()],
    },
  ],
};

// 每个不兼容接口在新服务上的预期拒绝方式（与变更相符）
const EXPECTED_REJECTION: Record<string, { status: number; stage?: string }> = {
  'POST /scn/extra-field': { status: 400, stage: 'structure' },
  'POST /scn/nested-required': { status: 400, stage: 'structure' },
  'POST /scn/deleted': { status: 404 },
  'POST /scn/enable-rule': { status: 400, stage: 'structure' },
  'POST /scn/special-names': { status: 400, stage: 'structure' },
};

// 每个不兼容接口预期出现的原因指针（只断言转义与定位，不断言措辞与排序）
const EXPECTED_POINTERS: Record<string, string[]> = {
  'POST /scn/extra-field': ['/level'],
  'POST /scn/nested-required': ['/buyer/email'],
  'POST /scn/enable-rule': [''],
  'POST /scn/special-names': ['/', '/__proto__', '/a~1b', '/a~0b'],
};

test('不兼容场景：报告结论、原因指针定位与反例真实重放', { timeout: 180_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const oldFile = await writeConfig(dir, 'old.json', OLD_CONFIG);
  const newFile = await writeConfig(dir, 'new.json', NEW_CONFIG);

  const result = await runCompare(oldFile, newFile);
  assert.equal(result.code, 1, `存在不兼容接口，退出码应为 1\nstderr:\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.compatible, false);
  assert.equal(report.endpoints.length, OLD_CONFIG.endpoints.length, '报告应覆盖每个旧接口');

  const byKey = new Map<string, any>(
    report.endpoints.map((ep: any) => [`${ep.method} ${ep.path}`, ep]),
  );

  // 全部 5 个场景接口都应判为不兼容
  for (const key of Object.keys(EXPECTED_REJECTION)) {
    const ep = byKey.get(key);
    assert.ok(ep !== undefined, `报告应包含旧接口 ${key}`);
    assert.equal(ep.compatible, false, `${key} 应判为不兼容`);
    assert.ok(ep.reasons.length >= 1, `${key} 应至少给出一处原因`);
    assert.ok(ep.example !== undefined, `${key} 应给出完整请求反例`);
  }

  // 原因指针的转义与定位（接口删除是接口级原因，不带 pointer 字段）
  for (const [key, pointers] of Object.entries(EXPECTED_POINTERS)) {
    const ep = byKey.get(key);
    const actual = new Set<string>(
      ep.reasons.filter((r: any) => typeof r.pointer === 'string').map((r: any) => r.pointer),
    );
    for (const p of pointers) {
      assert.ok(
        actual.has(p),
        `${key} 的原因中应包含 JSON Pointer ${JSON.stringify(p)}，实际为 ${JSON.stringify([...actual])}`,
      );
    }
  }
  const deleted = byKey.get('POST /scn/deleted');
  for (const reason of deleted.reasons) {
    assert.ok(
      !('pointer' in reason),
      `接口删除属于接口级原因，不应携带 pointer 字段：${JSON.stringify(reason)}`,
    );
  }

  // 真实重放：分别加载旧、新配置的本机服务（端口 0，取实际监听地址）
  const oldServer = await startServer(oldFile);
  t.after(oldServer.close);
  const newServer = await startServer(newFile);
  t.after(newServer.close);

  for (const [key, rejection] of Object.entries(EXPECTED_REJECTION)) {
    const ep = byKey.get(key);
    const example = ep.example as RawRequest;
    const label = `场景 ${key} 的反例请求 ${example.method} ${example.path} 正文=${example.body}`;

    // 旧服务：必须按场景配置返回可辨认的成功响应
    const oldRes = await sendRequest(oldServer.port, example);
    assert.equal(oldRes.status, SCENE_STATUS, `${label}\n旧服务应接受该请求并返回场景成功响应`);
    assert.equal(oldRes.body, SCENE_BODY, `${label}\n旧服务应返回场景正文`);

    // 新服务：必须按变更相符的阶段拒绝（400 正文校验 / 404 接口不存在）
    const newRes = await sendRequest(newServer.port, example);
    assert.equal(
      newRes.status,
      rejection.status,
      `${label}\n新服务应以 ${rejection.status} 拒绝，实际为 ${newRes.status}：${newRes.body}`,
    );
    assert.notEqual(newRes.body, SCENE_BODY, `${label}\n新服务不应返回场景成功正文`);
    if (rejection.status === 400) {
      const bodyReport = JSON.parse(newRes.body);
      assert.equal(bodyReport.error, 'invalid_request_body', `${label}\n400 应是正文校验拒绝`);
      assert.equal(
        bodyReport.stage,
        rejection.stage,
        `${label}\n拒绝阶段应为 ${rejection.stage}（与该变更相符）`,
      );
    }
  }
});

test('兼容场景：移除正文规则、新增接口、仅修改响应', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const oldConfig = {
    endpoints: [
      {
        // 移除正文规则（更宽松）
        method: 'POST',
        path: '/scn/remove-rule',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
      {
        // 原样保留的 GET 接口
        method: 'GET',
        path: '/scn/unchanged-get',
        responses: [sceneResponse()],
      },
      {
        // 仅响应将被修改的接口
        method: 'POST',
        path: '/scn/response-only',
        responses: [sceneResponse()],
      },
    ],
  };
  const newConfig = {
    endpoints: [
      { method: 'POST', path: '/scn/remove-rule', responses: [sceneResponse()] },
      { method: 'GET', path: '/scn/unchanged-get', responses: [sceneResponse()] },
      {
        // 仅修改响应：状态、正文、延迟都不同
        method: 'POST',
        path: '/scn/response-only',
        responses: [{ status: 503, headers: {}, body: 'totally-different', delay: 5 }],
      },
      {
        // 新增接口不破坏兼容
        method: 'GET',
        path: '/scn/added',
        responses: [sceneResponse()],
      },
    ],
  };
  const oldFile = await writeConfig(dir, 'old.json', oldConfig);
  const newFile = await writeConfig(dir, 'new.json', newConfig);

  const result = await runCompare(oldFile, newFile);
  assert.equal(result.code, 0, `全部兼容，退出码应为 0\nstderr:\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.compatible, true);
  assert.equal(report.endpoints.length, oldConfig.endpoints.length, '报告只覆盖旧接口');
  for (const ep of report.endpoints) {
    assert.equal(ep.compatible, true, `${ep.method} ${ep.path} 应判为兼容`);
    assert.equal(ep.reasons.length, 0, `${ep.method} ${ep.path} 不应有原因`);
  }
});

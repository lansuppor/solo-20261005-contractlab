// 明确的回归场景：真实 compare 报告 + 真实本机服务重放。
//
// 每个场景构造一对旧/新配置，断言：
// 1. compare 的退出码、整体结论与逐接口结论；
// 2. 不兼容接口的原因以 RFC 6901 JSON Pointer 定位（含转义），
//    只断言指针集合与“接口级原因无 pointer”，不固定自然语言措辞、
//    不固定原因排序、不固定反例正文的具体取值；
// 3. 把报告给出的完整请求反例**原样**发送到分别加载旧、新配置的真实
//    本机服务（端口 0，解析实际监听地址）：旧服务必须返回配置的成功
//    响应（统一的可辨认状态与正文 SCENARIO_STATUS / SCENARIO_BODY，
//    避免把场景自带错误误判为校验拒绝），新服务必须返回正文校验 400
//    （阶段与该变更相符）或接口不存在 404。不使用独立解释器代替重放。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeTempDir,
  runCompare,
  sendExample,
  startService,
  writeConfig,
} from './helpers.ts';

// 场景中所有接口统一使用的可辨认成功响应
const SCENARIO_STATUS = 200;
const SCENARIO_BODY = 'contractlab:scenario-ok';
const OK_RESPONSE = { status: SCENARIO_STATUS, headers: {}, body: SCENARIO_BODY, delay: 0 };

interface EndpointExpectation {
  method: string;
  path: string;
  compatible: boolean;
  // 不兼容时：报告原因应出现的 pointer 集合（顺序不限）；undefined 表示不检查
  pointers?: string[];
  // 不兼容时：所有原因都不得携带 pointer（接口级原因，如接口删除）
  reasonsWithoutPointer?: boolean;
  // 重放期望：新服务返回 404（接口已删除）
  removedInNew?: boolean;
  // 重放期望：新服务 400 的 stage，以及 400 报告 problems 中必须出现的指针
  expectedStage?: 'parse' | 'structure';
  problemPointers?: string[];
}

interface Scenario {
  name: string;
  oldConfig: unknown;
  newConfig: unknown;
  expectedCompatible: boolean;
  endpoints: EndpointExpectation[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'extra-field-now-constrained：双方都允许额外字段，新版新增可选字段限制取值',
    oldConfig: {
      endpoints: [
        {
          method: 'POST',
          path: '/api/profile',
          requestBody: { type: 'object', additionalProperties: true },
          responses: [OK_RESPONSE],
        },
      ],
    },
    newConfig: {
      endpoints: [
        {
          method: 'POST',
          path: '/api/profile',
          requestBody: {
            type: 'object',
            fields: { score: { type: 'integer' } },
            additionalProperties: true,
          },
          responses: [OK_RESPONSE],
        },
      ],
    },
    expectedCompatible: false,
    endpoints: [
      {
        method: 'POST',
        path: '/api/profile',
        compatible: false,
        pointers: ['/score'],
        expectedStage: 'structure',
        problemPointers: ['/score'],
      },
    ],
  },
  {
    name: 'nested-required-tightening：必填字段的嵌套子字段收紧为必填',
    oldConfig: {
      endpoints: [
        {
          method: 'POST',
          path: '/api/order',
          requestBody: {
            type: 'object',
            fields: {
              buyer: {
                type: 'object',
                required: true,
                fields: { name: { type: 'string' } },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          responses: [OK_RESPONSE],
        },
      ],
    },
    newConfig: {
      endpoints: [
        {
          method: 'POST',
          path: '/api/order',
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
          responses: [OK_RESPONSE],
        },
      ],
    },
    expectedCompatible: false,
    endpoints: [
      {
        method: 'POST',
        path: '/api/order',
        compatible: false,
        pointers: ['/buyer/name'],
        expectedStage: 'structure',
        problemPointers: ['/buyer/name'],
      },
    ],
  },
  {
    name: 'post-endpoint-removed：删除带正文规则的 POST 接口',
    oldConfig: {
      endpoints: [
        {
          method: 'POST',
          path: '/api/submit',
          requestBody: {
            type: 'object',
            fields: { id: { type: 'integer', required: true } },
            additionalProperties: false,
          },
          responses: [OK_RESPONSE],
        },
        { method: 'GET', path: '/api/keep', responses: [OK_RESPONSE] },
      ],
    },
    newConfig: {
      endpoints: [{ method: 'GET', path: '/api/keep', responses: [OK_RESPONSE] }],
    },
    expectedCompatible: false,
    endpoints: [
      {
        method: 'POST',
        path: '/api/submit',
        compatible: false,
        reasonsWithoutPointer: true,
        removedInNew: true,
      },
      { method: 'GET', path: '/api/keep', compatible: true },
    ],
  },
  {
    name: 'body-rule-added：旧接口无正文规则，新版启用 requestBody',
    oldConfig: {
      endpoints: [{ method: 'POST', path: '/api/echo', responses: [OK_RESPONSE] }],
    },
    newConfig: {
      endpoints: [
        {
          method: 'POST',
          path: '/api/echo',
          requestBody: {
            type: 'object',
            fields: { id: { type: 'integer', required: true } },
            additionalProperties: false,
          },
          responses: [OK_RESPONSE],
        },
      ],
    },
    expectedCompatible: false,
    endpoints: [
      {
        method: 'POST',
        path: '/api/echo',
        compatible: false,
        pointers: [''], // 根指针：差异在正文整体
        expectedStage: 'structure',
        problemPointers: [''],
      },
    ],
  },
  {
    name: 'body-rule-removed：移除正文规则（更宽松），判为兼容',
    oldConfig: {
      endpoints: [
        {
          method: 'POST',
          path: '/api/echo',
          requestBody: {
            type: 'object',
            fields: { id: { type: 'integer', required: true } },
            additionalProperties: false,
          },
          responses: [OK_RESPONSE],
        },
      ],
    },
    newConfig: {
      endpoints: [{ method: 'POST', path: '/api/echo', responses: [OK_RESPONSE] }],
    },
    expectedCompatible: true,
    endpoints: [{ method: 'POST', path: '/api/echo', compatible: true }],
  },
  {
    name: 'endpoint-added-and-response-changed：新增接口 + 仅修改响应，判为兼容',
    oldConfig: {
      endpoints: [{ method: 'GET', path: '/api/a', responses: [OK_RESPONSE] }],
    },
    newConfig: {
      endpoints: [
        {
          method: 'GET',
          path: '/api/a',
          responses: [
            { status: 201, headers: { 'X-Changed': 'yes' }, body: 'changed', delay: 5 },
          ],
        },
        {
          method: 'POST',
          path: '/api/b',
          requestBody: { type: 'object', additionalProperties: true },
          responses: [OK_RESPONSE],
        },
      ],
    },
    expectedCompatible: true,
    endpoints: [{ method: 'GET', path: '/api/a', compatible: true }],
  },
  {
    name: 'special-field-names：空字段名、__proto__、斜杠与波浪号字段名的必填收紧',
    // 手写 JSON 文本：避免 JS 对象字面量把 "__proto__" 当作原型 setter 吞掉
    oldConfig: `{
      "endpoints": [
        {
          "method": "POST",
          "path": "/api/names",
          "requestBody": {
            "type": "object",
            "fields": {
              "": { "type": "string" },
              "__proto__": { "type": "string" },
              "a/b": { "type": "string" },
              "a~b": { "type": "string" }
            },
            "additionalProperties": false
          },
          "responses": [
            { "status": ${SCENARIO_STATUS}, "headers": {}, "body": "${SCENARIO_BODY}", "delay": 0 }
          ]
        }
      ]
    }`,
    newConfig: `{
      "endpoints": [
        {
          "method": "POST",
          "path": "/api/names",
          "requestBody": {
            "type": "object",
            "fields": {
              "": { "type": "string", "required": true },
              "__proto__": { "type": "string", "required": true },
              "a/b": { "type": "string", "required": true },
              "a~b": { "type": "string", "required": true }
            },
            "additionalProperties": false
          },
          "responses": [
            { "status": ${SCENARIO_STATUS}, "headers": {}, "body": "${SCENARIO_BODY}", "delay": 0 }
          ]
        }
      ]
    }`,
    expectedCompatible: false,
    endpoints: [
      {
        method: 'POST',
        path: '/api/names',
        compatible: false,
        // RFC 6901 转义："" -> "/"，"a/b" -> "/a~1b"，"a~b" -> "/a~0b"
        pointers: ['/', '/__proto__', '/a~1b', '/a~0b'],
        expectedStage: 'structure',
        problemPointers: ['/', '/__proto__', '/a~1b', '/a~0b'],
      },
    ],
  },
];

for (const scenario of SCENARIOS) {
  test(`场景 ${scenario.name}`, { timeout: 60_000 }, async (t) => {
    const dir = await makeTempDir(t);
    const oldFile = await writeConfig(dir, 'old.json', scenario.oldConfig);
    const newFile = await writeConfig(dir, 'new.json', scenario.newConfig);

    const result = await runCompare(oldFile, newFile);
    assert.equal(result.timedOut, false, `${scenario.name}：compare 超时`);
    assert.equal(
      result.code,
      scenario.expectedCompatible ? 0 : 1,
      `${scenario.name}：退出码，stderr=${result.stderr}`,
    );
    const report = JSON.parse(result.stdout);
    assert.equal(report.compatible, scenario.expectedCompatible, `${scenario.name}：整体结论`);

    for (const expectation of scenario.endpoints) {
      const label = `${scenario.name}：${expectation.method} ${expectation.path}`;
      const ep = report.endpoints.find(
        (entry: { method: string; path: string }) =>
          entry.method === expectation.method && entry.path === expectation.path,
      );
      assert.ok(ep, `${label}：报告缺少该接口`);
      assert.equal(ep.compatible, expectation.compatible, `${label}：接口结论`);

      if (expectation.pointers !== undefined) {
        const actual = ep.reasons.map((reason: { pointer?: string }) => reason.pointer);
        assert.deepEqual(
          new Set(actual),
          new Set(expectation.pointers),
          `${label}：原因的 JSON Pointer 集合（转义与定位）`,
        );
      }
      if (expectation.reasonsWithoutPointer) {
        assert.ok(ep.reasons.length > 0, `${label}：至少一处原因`);
        for (const reason of ep.reasons) {
          assert.equal(
            Object.prototype.hasOwnProperty.call(reason, 'pointer'),
            false,
            `${label}：接口级原因不得携带 pointer`,
          );
        }
      }
    }

    if (scenario.expectedCompatible) {
      return; // 无不兼容接口，无需重放
    }

    // 重放：报告给出的每个不兼容接口反例，原样发往真实的旧、新服务
    const oldService = await startService(oldFile);
    const newService = await startService(newFile);
    t.after(async () => {
      await oldService.close();
      await newService.close();
    });
    try {
      const incompatible = report.endpoints.filter(
        (entry: { compatible: boolean }) => !entry.compatible,
      );
      assert.ok(incompatible.length > 0, `${scenario.name}：应存在不兼容接口`);
      for (const ep of incompatible) {
        const label = `${scenario.name}：重放 ${ep.method} ${ep.path}`;
        const expectation = scenario.endpoints.find(
          (item) => item.method === ep.method && item.path === ep.path,
        );
        assert.ok(expectation, `${label}：缺少场景期望`);
        assert.ok(ep.example, `${label}：报告应给出完整请求反例`);

        // 旧服务：必须返回配置的成功响应（可辨认状态与正文）
        const oldResponse = await sendExample(oldService.port, ep.example);
        assert.equal(
          oldResponse.status,
          SCENARIO_STATUS,
          `${label}：旧服务应返回场景成功状态，请求=${ep.example.body}`,
        );
        assert.equal(
          oldResponse.body,
          SCENARIO_BODY,
          `${label}：旧服务应返回场景成功正文，请求=${ep.example.body}`,
        );

        // 新服务：接口不存在 404，或正文校验 400 且拒绝阶段与变更相符
        const newResponse = await sendExample(newService.port, ep.example);
        if (expectation.removedInNew) {
          assert.equal(
            newResponse.status,
            404,
            `${label}：新服务应返回 404（接口已删除），请求=${ep.example.body}`,
          );
        } else {
          assert.equal(
            newResponse.status,
            400,
            `${label}：新服务应返回 400（正文校验拒绝），请求=${ep.example.body}`,
          );
          const rejection = JSON.parse(newResponse.body);
          assert.equal(rejection.error, 'invalid_request_body', `${label}：400 报告 error`);
          assert.equal(
            rejection.stage,
            expectation.expectedStage,
            `${label}：拒绝阶段应与该变更相符`,
          );
          if (expectation.problemPointers) {
            const actual = new Set(
              rejection.problems.map((problem: { pointer: string }) => problem.pointer),
            );
            for (const pointer of expectation.problemPointers) {
              assert.ok(
                actual.has(pointer),
                `${label}：400 报告 problems 应包含指针 ${JSON.stringify(pointer)}，实际 ${JSON.stringify([...actual])}`,
              );
            }
          }
        }
      }
    } finally {
      await oldService.close();
      await newService.close();
    }
  });
}

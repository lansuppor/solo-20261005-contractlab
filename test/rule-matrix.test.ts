// 规则包含关系矩阵回归测试
//
// 方法：构造一组确定性的小型递归规则对（旧规则 → 新规则），对每一对：
//   1. 用独立参考实现 accepts()（test/helpers.ts，仅依据 README 语义编写，
//      不调用产品代码）在有限代表值域 domainFor() 上穷举；
//   2. 域中被旧规则接受的值若全部被新规则接受，则期望“兼容”，否则期望“不兼容”；
//   3. 把全部规则对装进一对真实场景配置文件，运行真实 compare 命令，
//      核对逐接口结论、整体结论与退出码。
//
// 受测规则范围（矩阵交叉覆盖）：
// - 全部现有标量类型 string/number/integer/boolean/null 的两两组合（5×5），
//   含 integer → number（兼容）与 number → integer（不兼容）的双向变化；
// - object 的必填/可选字段变化（可选→必填、必填→可选、新增/删除声明字段）；
// - additionalProperties 两种策略的全部组合（false→true、true→false、
//   双方 true 时新版新增可选字段限制取值、双方 false 时新增可选字段）；
// - 对象嵌套对象（嵌套必填收紧、嵌套字段类型收紧）、数组嵌套标量、
//   数组嵌套对象（元素字段收紧）；
// - object/array/标量之间的类型替换；
// - 可空（nullable）：根、字段、数组元素的可空放宽/收紧、type:"null" 与可空
//   标量的互转、双方可空时非 null 约束变化仍被检出。
//
// 代表值域为何能区分这些规则对：域内含整数与非整数（区分 integer/number）、
// 字段缺失与 null（区分“必填缺失”与 null 类型）、空与非空数组（元素收紧只在
// 非空数组上可见）、已声明字段的删除/替换变体与未声明额外字段（区分
// additionalProperties 两种策略及新增字段约束）、递归到第 2 层的嵌套结构。
// 每一对的期望都由该域穷举得出；这是对**本矩阵规则对**的充分见证域，
// 并不声称有限检查能证明任意递归规则的包含关系。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accepts,
  domainFor,
  makeTempDir,
  runCompare,
  sceneResponse,
  writeConfig,
  type RuleJson,
} from './helpers.ts';

interface RulePair {
  readonly name: string;
  readonly oldRule: RuleJson;
  readonly newRule: RuleJson;
}

const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null'] as const;

// 标量 5×5：兼容当且仅当类型相同，或 integer 放宽为 number
const scalarPairs: RulePair[] = [];
for (const oldType of SCALAR_TYPES) {
  for (const newType of SCALAR_TYPES) {
    scalarPairs.push({
      name: `scalar:${oldType}->${newType}`,
      oldRule: { type: oldType },
      newRule: { type: newType },
    });
  }
}

const structuredPairs: RulePair[] = [
  {
    name: 'field-widen:integer->number',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'number', required: true } },
      additionalProperties: false,
    },
  },
  {
    name: 'field-narrow:number->integer',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'number', required: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
  },
  {
    name: 'optional->required',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'integer' } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
  },
  {
    name: 'required->optional',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'integer' } },
      additionalProperties: false,
    },
  },
  {
    name: 'additionalProperties:false->true',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: true,
    },
  },
  {
    name: 'additionalProperties:true->false',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: true,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
  },
  {
    // 双方都允许额外字段，但新版新增的可选字段限制了旧版原本自由的取值
    name: 'both-open:new-optional-field-constrains',
    oldRule: { type: 'object', additionalProperties: true },
    newRule: {
      type: 'object',
      fields: { b: { type: 'integer' } },
      additionalProperties: true,
    },
  },
  {
    // 双方都拒绝额外字段，新版新增可选字段：旧版请求本就不含它，兼容
    name: 'both-closed:new-optional-field',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true }, b: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'declared-field-removed:closed',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'integer' } },
      additionalProperties: false,
    },
    newRule: { type: 'object', fields: {}, additionalProperties: false },
  },
  {
    name: 'declared-field-removed:open',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'integer' } },
      additionalProperties: false,
    },
    newRule: { type: 'object', fields: {}, additionalProperties: true },
  },
  {
    name: 'nested:field-type-tightened',
    oldRule: {
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
    newRule: {
      type: 'object',
      fields: {
        buyer: {
          type: 'object',
          required: true,
          fields: { name: { type: 'integer', required: true } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'nested:new-required-field',
    oldRule: {
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
    newRule: {
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
  },
  {
    name: 'array-items:integer->number',
    oldRule: { type: 'array', items: { type: 'integer' } },
    newRule: { type: 'array', items: { type: 'number' } },
  },
  {
    name: 'array-items:number->integer',
    oldRule: { type: 'array', items: { type: 'number' } },
    newRule: { type: 'array', items: { type: 'integer' } },
  },
  {
    name: 'array-of-objects:item-field-widened',
    oldRule: { type: 'array', items: { type: 'object', fields: { id: { type: 'integer', required: true } }, additionalProperties: false } },
    newRule: { type: 'array', items: { type: 'object', fields: { id: { type: 'number', required: true } }, additionalProperties: false } },
  },
  {
    name: 'array-of-objects:item-field-narrowed',
    oldRule: { type: 'array', items: { type: 'object', fields: { id: { type: 'number', required: true } }, additionalProperties: false } },
    newRule: { type: 'array', items: { type: 'object', fields: { id: { type: 'integer', required: true } }, additionalProperties: false } },
  },
  {
    name: 'type-change:object->array',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
    newRule: { type: 'array', items: { type: 'integer' } },
  },
  {
    name: 'type-change:array->object',
    oldRule: { type: 'array', items: { type: 'integer' } },
    newRule: { type: 'object', fields: {}, additionalProperties: false },
  },
  {
    name: 'type-change:scalar->object',
    oldRule: { type: 'string' },
    newRule: { type: 'object', fields: {}, additionalProperties: false },
  },
  {
    // 字段缺失与 null 的区分：旧版可选 null 字段，新版改为可选 string 字段
    name: 'null-vs-string:optional-field',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'null' } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'identical:empty-closed-object',
    oldRule: { type: 'object', fields: {}, additionalProperties: false },
    newRule: { type: 'object', fields: {}, additionalProperties: false },
  },
];

// 可空（nullable）规则对：null 接受性的放宽/收紧，以及可空不掩盖非 null 约束变化
const nullablePairs: RulePair[] = [
  {
    // 新增可空是放宽：兼容
    name: 'nullable:string->nullable-string',
    oldRule: { type: 'string' },
    newRule: { type: 'string', nullable: true },
  },
  {
    // 去掉可空是收紧：null 成为反例
    name: 'nullable:nullable-string->string',
    oldRule: { type: 'string', nullable: true },
    newRule: { type: 'string' },
  },
  {
    name: 'nullable:nullable-integer->nullable-number',
    oldRule: { type: 'integer', nullable: true },
    newRule: { type: 'number', nullable: true },
  },
  {
    // 双方可空也不掩盖 number -> integer 的收紧
    name: 'nullable:nullable-number->nullable-integer',
    oldRule: { type: 'number', nullable: true },
    newRule: { type: 'integer', nullable: true },
  },
  {
    // type:null 只接受 null；可空 string 是其超集
    name: 'nullable:null->nullable-string',
    oldRule: { type: 'null' },
    newRule: { type: 'string', nullable: true },
  },
  {
    name: 'nullable:nullable-string->null',
    oldRule: { type: 'string', nullable: true },
    newRule: { type: 'null' },
  },
  {
    // 可空不掩盖非 null 类型变化
    name: 'nullable:nullable-string->nullable-integer',
    oldRule: { type: 'string', nullable: true },
    newRule: { type: 'integer', nullable: true },
  },
  {
    // 嵌套字段可空收紧：{a:null} 成为反例
    name: 'nullable-field:optional-nullable->non-nullable',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'string', nullable: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'nullable-field:required-nullable->required-nullable',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'string', nullable: true, required: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'string', nullable: true, required: true } },
      additionalProperties: false,
    },
  },
  {
    // 数组元素可空收紧：[null] 成为反例
    name: 'nullable-array-items:nullable->non-nullable',
    oldRule: { type: 'array', items: { type: 'string', nullable: true } },
    newRule: { type: 'array', items: { type: 'string' } },
  },
  {
    // 根对象可空收紧：null 成为反例
    name: 'nullable-root-object:nullable->non-nullable',
    oldRule: {
      type: 'object',
      nullable: true,
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
  },
];

const ALL_PAIRS: readonly RulePair[] = [...scalarPairs, ...structuredPairs, ...nullablePairs];

test('规则包含关系矩阵：逐接口、整体结论与退出码', { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir(t);

  // 每个规则对一个 POST 接口（requestBody 仅允许 POST），路径按序编号
  const toEndpoint = (rule: RuleJson, index: number): unknown => ({
    method: 'POST',
    path: `/matrix/${index}`,
    requestBody: rule,
    responses: [sceneResponse()],
  });
  const oldFile = await writeConfig(dir, 'old.json', {
    endpoints: ALL_PAIRS.map((p, i) => toEndpoint(p.oldRule, i)),
  });
  const newFile = await writeConfig(dir, 'new.json', {
    endpoints: ALL_PAIRS.map((p, i) => toEndpoint(p.newRule, i)),
  });

  // 独立期望：穷举代表值域中被旧规则接受的值，检查新规则是否全部接受
  const expected = ALL_PAIRS.map((p) => {
    const domain = domainFor(p.oldRule, p.newRule);
    const acceptedOld = domain.filter((v) => accepts(p.oldRule, v));
    assert.ok(
      acceptedOld.length > 0,
      `代表值域中应存在被旧规则接受的值（用例 ${p.name}，旧规则 ${JSON.stringify(p.oldRule)}）`,
    );
    const witness = acceptedOld.find((v) => !accepts(p.newRule, v));
    return { compatible: witness === undefined, witness };
  });
  const expectedOverall = expected.every((e) => e.compatible);

  const result = await runCompare(oldFile, newFile);
  assert.equal(
    result.code,
    expectedOverall ? 0 : 1,
    `退出码应符合整体结论（期望${expectedOverall ? '兼容=0' : '不兼容=1'}）\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.stderr, '', 'compare 成功运行时不应向 stderr 输出');

  let report: any;
  try {
    report = JSON.parse(result.stdout);
  } catch (e) {
    assert.fail(`compare 的 stdout 应是完整 JSON 报告：${String(e)}\nstdout:\n${result.stdout}`);
  }
  assert.equal(report.compatible, expectedOverall, '整体结论应与代表值域穷举结果一致');
  assert.equal(report.endpoints.length, ALL_PAIRS.length, '报告应覆盖每个旧接口');

  for (const [i, pair] of ALL_PAIRS.entries()) {
    const ep = report.endpoints[i];
    const exp = expected[i];
    const where =
      `规则组合 ${pair.name}（接口 POST /matrix/${i}）\n` +
      `旧规则: ${JSON.stringify(pair.oldRule)}\n新规则: ${JSON.stringify(pair.newRule)}\n` +
      (exp.compatible ? '' : `域内见证值（旧接受、新拒绝）: ${JSON.stringify(exp.witness)}\n`);
    assert.equal(ep.method, 'POST', where);
    assert.equal(ep.path, `/matrix/${i}`, where);
    assert.equal(
      ep.compatible,
      exp.compatible,
      `${where}逐接口结论不一致：报告=${ep.compatible}，独立穷举期望=${exp.compatible}`,
    );
    if (!exp.compatible) {
      assert.ok(ep.reasons.length >= 1, `${where}不兼容接口应至少给出一处原因`);
      assert.ok(ep.example !== undefined, `${where}不兼容接口应给出完整请求反例`);
    }
  }
});

test('相同文件比较：一切规则自包含，整体兼容、退出码 0', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'same.json', {
    endpoints: ALL_PAIRS.slice(0, 5).map((p, i) => ({
      method: 'POST',
      path: `/self/${i}`,
      requestBody: p.oldRule,
      responses: [sceneResponse()],
    })),
  });
  const result = await runCompare(file, file);
  assert.equal(result.code, 0, `自比较应兼容退出 0\nstderr:\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.compatible, true);
  assert.ok(report.endpoints.every((ep: any) => ep.compatible && ep.reasons.length === 0));
});

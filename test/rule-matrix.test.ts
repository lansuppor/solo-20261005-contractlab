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
// - nullable 可空约定：根/字段/数组元素的可空增减、可空与 integer/number
//   双向变化的组合、type:null 与可空标量之间的两个方向；
// - 标量枚举 enum：枚举增删、顺序与重复无关、枚举与非枚举规则交叉
//   （number 枚举全整数兼容非枚举 integer、无限域对有限枚举不兼容）、
//   布尔全枚举等价、可空与枚举的交集（可空不越过枚举）、字段与数组元素枚举。
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
  // nullable：可空只在原接受集合上加入 null，不掩盖非 null 约束变化
  {
    name: 'nullable:add-root',
    oldRule: { type: 'string' },
    newRule: { type: 'string', nullable: true },
  },
  {
    name: 'nullable:remove-root',
    oldRule: { type: 'string', nullable: true },
    newRule: { type: 'string' },
  },
  {
    name: 'nullable:integer->number-both-nullable',
    oldRule: { type: 'integer', nullable: true },
    newRule: { type: 'number', nullable: true },
  },
  {
    name: 'nullable:integer->number-new-not-nullable',
    oldRule: { type: 'integer', nullable: true },
    newRule: { type: 'number' },
  },
  {
    name: 'nullable:number->integer-both-nullable',
    oldRule: { type: 'number', nullable: true },
    newRule: { type: 'integer', nullable: true },
  },
  {
    name: 'nullable:object-root-added',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      nullable: true,
      fields: { a: { type: 'integer', required: true } },
      additionalProperties: false,
    },
  },
  {
    name: 'nullable:object-root-removed',
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
  {
    name: 'nullable:field-added',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'string', required: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'string', required: true, nullable: true } },
      additionalProperties: false,
    },
  },
  {
    name: 'nullable:field-removed',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'string', required: true, nullable: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'string', required: true } },
      additionalProperties: false,
    },
  },
  {
    name: 'nullable:array-items-added',
    oldRule: { type: 'array', items: { type: 'integer' } },
    newRule: { type: 'array', items: { type: 'integer', nullable: true } },
  },
  {
    name: 'nullable:array-items-removed',
    oldRule: { type: 'array', items: { type: 'integer', nullable: true } },
    newRule: { type: 'array', items: { type: 'integer' } },
  },
  {
    // type:null 附加 nullable 不改变接受集合（仍只接受 null）
    name: 'nullable:null-type-with-nullable-flag',
    oldRule: { type: 'null' },
    newRule: { type: 'null', nullable: true },
  },
  {
    // null 类型放宽为可空 string：null 仍被接受，兼容
    name: 'nullable:null->nullable-string',
    oldRule: { type: 'null' },
    newRule: { type: 'string', nullable: true },
  },
  {
    // 可空 string 收紧为 null 类型：非 null 字符串不再接受
    name: 'nullable:nullable-string->null',
    oldRule: { type: 'string', nullable: true },
    newRule: { type: 'null' },
  },
  // 标量枚举：接受集合为类型及可空集合与枚举集合的交集；枚举值均取自
  // 代表值域（'txt'/''/0/1/0.5/true/false/null），保证域内必有见证
  {
    // 新增枚举限制：旧版任意字符串，新版仅 'txt'
    name: 'enum:add-string',
    oldRule: { type: 'string' },
    newRule: { type: 'string', enum: ['txt'] },
  },
  {
    // 移除枚举限制：更宽松
    name: 'enum:remove-string',
    oldRule: { type: 'string', enum: ['txt'] },
    newRule: { type: 'string' },
  },
  {
    // 枚举候选值相同、顺序与重复不同：语义不变
    name: 'enum:order-and-duplicates-irrelevant',
    oldRule: { type: 'integer', enum: [1, 0] },
    newRule: { type: 'integer', enum: [0, 1, 0] },
  },
  {
    // number 枚举全为整数：兼容非枚举 integer（枚举 ⊆ integer）
    name: 'enum:number-all-integers->integer',
    oldRule: { type: 'number', enum: [0, 1] },
    newRule: { type: 'integer' },
  },
  {
    // number 枚举含非整数：对 integer 不兼容
    name: 'enum:number-with-fraction->integer',
    oldRule: { type: 'number', enum: [0.5, 1] },
    newRule: { type: 'integer' },
  },
  {
    // integer 枚举放宽为非枚举 number：枚举 ⊆ number
    name: 'enum:integer-enum->number',
    oldRule: { type: 'integer', enum: [0, 1] },
    newRule: { type: 'number' },
  },
  {
    // 非枚举 integer 收紧为 number 枚举：无限域对有限枚举，不兼容
    name: 'enum:integer->number-enum',
    oldRule: { type: 'integer' },
    newRule: { type: 'number', enum: [0] },
  },
  {
    // 布尔全枚举与无枚举等价
    name: 'enum:boolean-full',
    oldRule: { type: 'boolean' },
    newRule: { type: 'boolean', enum: [true, false] },
  },
  {
    // 布尔部分枚举：丢失 false
    name: 'enum:boolean-partial',
    oldRule: { type: 'boolean' },
    newRule: { type: 'boolean', enum: [true] },
  },
  {
    // 可空且 null 列入枚举：对可空无枚举兼容（子集）
    name: 'enum:nullable-enum->nullable-open',
    oldRule: { type: 'string', nullable: true, enum: ['txt', null] },
    newRule: { type: 'string', nullable: true },
  },
  {
    // 可空无枚举收紧为可空枚举：非枚举字符串丢失
    name: 'enum:nullable-open->nullable-enum',
    oldRule: { type: 'string', nullable: true },
    newRule: { type: 'string', nullable: true, enum: ['txt', null] },
  },
  {
    // 可空不越过枚举：候选值中移除 null 即不再接受 null
    name: 'enum:null-removed-from-enum',
    oldRule: { type: 'string', nullable: true, enum: ['txt', null] },
    newRule: { type: 'string', nullable: true, enum: ['txt'] },
  },
  {
    // type:null 附枚举 [null]：接受集合不变
    name: 'enum:null-type-with-enum',
    oldRule: { type: 'null' },
    newRule: { type: 'null', enum: [null] },
  },
  {
    // 字段级枚举收紧
    name: 'enum:field-tightened',
    oldRule: {
      type: 'object',
      fields: { a: { type: 'string', required: true } },
      additionalProperties: false,
    },
    newRule: {
      type: 'object',
      fields: { a: { type: 'string', required: true, enum: ['txt'] } },
      additionalProperties: false,
    },
  },
  {
    // 数组元素枚举收紧
    name: 'enum:array-items-tightened',
    oldRule: { type: 'array', items: { type: 'integer' } },
    newRule: { type: 'array', items: { type: 'integer', enum: [1] } },
  },
];

const ALL_PAIRS: readonly RulePair[] = [...scalarPairs, ...structuredPairs];

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

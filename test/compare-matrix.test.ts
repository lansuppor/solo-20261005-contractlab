// 离线兼容报告的自动回归：规则组矩阵 × 真实 compare 命令。
//
// 受测规则范围
// ------------
// 确定性的小型无环规则（嵌套深度 ≤ 3），分 5 组交叉覆盖：
// - scalar：全部 5 种标量类型两两组合（含 integer -> number 放宽与
//   number -> integer 收紧两个方向）；
// - fields：object 的必填/可选字段、字段类型收紧、字段增删；
// - additionalProperties：true/false 两种策略的全部组合，含“双方都允许额外
//   字段、但新版新增可选字段限制取值”的情形；
// - nested：对象与数组相互嵌套（数组元素为对象、对象字段为数组、数组套数组、
//   开放对象套开放对象）；
// - cross：标量 / 封闭对象 / 开放对象 / 数组之间的跨种类类型变化。
//
// 期望值如何计算（独立性）
// ------------------------
// 每对规则的期望包含关系由测试侧的独立语义（helpers.ts 中的 accepts）在
// 有限代表值域 pairDomain 上穷举得出：旧规则接受的每个代表值都必须也被新
// 规则接受。不调用产品的校验、比较或反例构造函数来计算期望。
//
// 代表值域为何能区分这些规则对
// ----------------------------
// 本规则语言中，一次拒绝总能归因到单个位置：标量类型不符、必填字段缺失、
// 未声明的额外字段、数组元素不符（递归到子位置）。代表值域对每个位置都
// 准备了对应的“最小证人”：
// - 标量位置：5 个代表值恰好区分 5 种标量类型的接受集（含整数 0 与非整数
//   0.5 之分），任意两种标量规则接受集不同则必有代表值落在差集中；
// - object 位置：每个双方声明的字段取“缺省 / 每个字段代表值”的笛卡尔积
//   （区分字段缺失与 null —— null 本身是代表值之一），另加一个双方都未
//   声明的额外字段（缺省 / 0 / "s"），区分 additionalProperties 两种策略；
// - array 位置：空数组（双方必同时接受）与单元素非空数组（元素取元素对域
//   的每个代表值），元素规则的任何接受差异都会以 [证人] 的形式出现；
// - 跨种类：object 位置补数组形状、array 位置补对象形状，标量代表值则同时
//   充当“非复合”形状。
// 对本文件列出的这些规则对（无环、深度 ≤ 3、字段数 ≤ 2、额外字段名固定为
// zz_extra），若 L(旧) ⊄ L(新)，上述构造保证域中存在被旧接受、被新拒绝的
// 代表值；因此域上的包含判定与这些规则对的真实包含关系一致。
//
// 局限声明：这是对**本文件列出的有限规则组**的有限检查，不是对任意递归
// 规则的包含关系证明；规则组变更时须重新评估上述论证是否仍然成立。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accepts,
  domainInclusive,
  makeTempDir,
  runCompare,
  writeConfig,
  type RuleJson,
} from './helpers.ts';

const OK_RESPONSE = { status: 200, headers: {}, body: 'ok', delay: 0 };

interface RulePair {
  label: string;
  oldRule: RuleJson;
  newRule: RuleJson;
}

interface RuleGroup {
  name: string;
  pairs: RulePair[];
}

// 组内规则两两组合（含自身），生成 nameA -> nameB 的规则对
function crossPairs(rules: Record<string, RuleJson>): RulePair[] {
  const pairs: RulePair[] = [];
  for (const [oldName, oldRule] of Object.entries(rules)) {
    for (const [newName, newRule] of Object.entries(rules)) {
      pairs.push({ label: `${oldName} -> ${newName}`, oldRule, newRule });
    }
  }
  return pairs;
}

const SCALAR_RULES: Record<string, RuleJson> = {
  string: { type: 'string' },
  number: { type: 'number' },
  integer: { type: 'integer' },
  boolean: { type: 'boolean' },
  null: { type: 'null' },
};

const FIELD_RULES: Record<string, RuleJson> = {
  'req-string': {
    type: 'object',
    fields: { a: { type: 'string', required: true } },
    additionalProperties: false,
  },
  'opt-string': {
    type: 'object',
    fields: { a: { type: 'string' } },
    additionalProperties: false,
  },
  'req-integer': {
    type: 'object',
    fields: { a: { type: 'integer', required: true } },
    additionalProperties: false,
  },
  'req-string-opt-number': {
    type: 'object',
    fields: { a: { type: 'string', required: true }, b: { type: 'number' } },
    additionalProperties: false,
  },
  'no-fields': { type: 'object', additionalProperties: false },
};

const AP_RULES: Record<string, RuleJson> = {
  'open-plain': {
    type: 'object',
    fields: { a: { type: 'string', required: true } },
    additionalProperties: true,
  },
  'closed-plain': {
    type: 'object',
    fields: { a: { type: 'string', required: true } },
    additionalProperties: false,
  },
  'open-with-opt-integer': {
    type: 'object',
    fields: { a: { type: 'string', required: true }, b: { type: 'integer' } },
    additionalProperties: true,
  },
  'open-empty': { type: 'object', additionalProperties: true },
};

const NESTED_RULES: Record<string, RuleJson> = {
  'arr-obj-id-int': {
    type: 'array',
    items: {
      type: 'object',
      fields: { id: { type: 'integer', required: true } },
      additionalProperties: false,
    },
  },
  'arr-obj-id-num': {
    type: 'array',
    items: {
      type: 'object',
      fields: { id: { type: 'number', required: true } },
      additionalProperties: false,
    },
  },
  'obj-list-string': {
    type: 'object',
    fields: { list: { type: 'array', items: { type: 'string' }, required: true } },
    additionalProperties: false,
  },
  'obj-list-integer': {
    type: 'object',
    fields: { list: { type: 'array', items: { type: 'integer' }, required: true } },
    additionalProperties: false,
  },
  'arr-arr-integer': { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
  'obj-obj-open': {
    type: 'object',
    fields: {
      obj: {
        type: 'object',
        fields: { x: { type: 'boolean' } },
        additionalProperties: true,
        required: true,
      },
    },
    additionalProperties: true,
  },
};

const CROSS_RULES: Record<string, RuleJson> = {
  string: { type: 'string' },
  integer: { type: 'integer' },
  'closed-object': FIELD_RULES['req-string'] as RuleJson,
  'open-object': { type: 'object', additionalProperties: true },
  'integer-array': { type: 'array', items: { type: 'integer' } },
};

const GROUPS: RuleGroup[] = [
  { name: 'scalar', pairs: crossPairs(SCALAR_RULES) },
  { name: 'fields', pairs: crossPairs(FIELD_RULES) },
  { name: 'additionalProperties', pairs: crossPairs(AP_RULES) },
  { name: 'nested', pairs: crossPairs(NESTED_RULES) },
  { name: 'cross', pairs: crossPairs(CROSS_RULES) },
];

interface EndpointExpectation {
  pair: RulePair;
  expected: boolean;
}

for (const group of GROUPS) {
  test(
    `规则组 ${group.name}：${group.pairs.length} 对规则的包含关系与 compare 报告一致`,
    { timeout: 60_000 },
    async (t) => {
      const dir = await makeTempDir(t);
      const makeEndpoints = (key: 'oldRule' | 'newRule') =>
        group.pairs.map((pair, i) => ({
          method: 'POST',
          path: `/case/${group.name}/${i}`,
          requestBody: pair[key],
          responses: [OK_RESPONSE],
        }));
      const oldFile = await writeConfig(dir, 'old.json', { endpoints: makeEndpoints('oldRule') });
      const newFile = await writeConfig(dir, 'new.json', { endpoints: makeEndpoints('newRule') });

      // 期望：测试侧独立语义在代表值域上的包含判定
      const expectedByPath = new Map<string, EndpointExpectation>(
        group.pairs.map((pair, i) => [
          `/case/${group.name}/${i}`,
          { pair, expected: domainInclusive(pair.oldRule, pair.newRule) },
        ]),
      );
      const allCompatible = [...expectedByPath.values()].every((entry) => entry.expected);

      const result = await runCompare(oldFile, newFile);
      assert.equal(result.timedOut, false, `规则组 ${group.name}：compare 超时`);
      assert.equal(
        result.code,
        allCompatible ? 0 : 1,
        `规则组 ${group.name}：退出码应为 ${allCompatible ? 0 : 1}，stderr=${result.stderr}`,
      );

      const report = JSON.parse(result.stdout);
      assert.equal(report.compatible, allCompatible, `规则组 ${group.name}：整体结论`);
      assert.equal(
        report.endpoints.length,
        group.pairs.length,
        `规则组 ${group.name}：报告应覆盖每个旧接口`,
      );

      for (const ep of report.endpoints) {
        const entry = expectedByPath.get(ep.path);
        assert.ok(entry, `规则组 ${group.name}：报告出现未知接口 ${ep.path}`);
        const { pair, expected } = entry;
        const where = `规则组 ${group.name}，规则对 ${pair.label}`;
        assert.equal(
          ep.compatible,
          expected,
          `${where}：期望${expected ? '兼容' : '不兼容'}，报告给出相反结论`,
        );
        if (expected) {
          assert.equal(ep.reasons.length, 0, `${where}：兼容接口不应给出原因`);
        } else {
          assert.ok(ep.reasons.length > 0, `${where}：不兼容接口至少给出一处原因`);
          assert.ok(ep.example, `${where}：不兼容接口应给出完整请求反例`);
          assert.equal(ep.example.method, 'POST', `${where}：反例方法`);
          assert.equal(ep.example.path, ep.path, `${where}：反例路径`);
          assert.equal(
            ep.example.headers['Content-Type'],
            'application/json',
            `${where}：反例须带 JSON 媒体类型`,
          );
          // 反例一致性：报告给出的正文必须确实被旧规则接受、被新规则拒绝
          // （用测试侧独立语义核对，不固定反例正文的具体取值）
          const body = JSON.parse(ep.example.body);
          assert.ok(
            accepts(pair.oldRule, body),
            `${where}：反例 ${ep.example.body} 必须被旧规则接受`,
          );
          assert.ok(
            !accepts(pair.newRule, body),
            `${where}：反例 ${ep.example.body} 必须被新规则拒绝`,
          );
        }
      }
    },
  );
}

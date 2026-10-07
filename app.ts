// contractlab —— 可热更新的本地接口场景服务
//
// 运行环境：Node.js 24（内置 TypeScript 类型擦除，可直接 `node app.ts`），
// 无任何外部运行依赖。
//
// 行为约定（详见 README.md）：
// - 业务接口由“方法 + 绝对路径”唯一标识，查询串不参与匹配，不支持路径模板；
// - 请求被完整接收后，才按当前配置匹配接口并同步“预留”响应序列的下一项，
//   序列耗尽后持续返回末项；预留之后客户端断开，仍计为一次消费；
// - POST /__contractlab/reload 重新读取同一配置文件：新配置全部有效时才
//   原子替换全部接口、重置全部序列并递增版本号；失败时现状不变；
// - 在途请求持有预留时的旧响应快照（状态码/响应头/正文/延迟/版本），
//   完成时不会推进新序列；
// - POST 接口可附加可选的 requestBody 正文结构规则：请求完整接收后先校验
//   媒体类型与 JSON 结构，不符时返回 400 差异报告，不发送场景响应、不消费序列；
//   校验通过才按“完整接收”顺序预留响应项。任意规则节点可附布尔 nullable：
//   true 在原接受集合上加入 null（必填字段仍不得缺失，空正文不等于 null）；
//   标量节点可附非空 enum 候选数组：接受集合为“类型及可空集合”与枚举集合的
//   交集（可空不越过枚举；object/array 节点禁止 enum）。
// - 已声明 requestBody 的 POST 接口还可配置有序响应分支 branches：每支含接口内
//   唯一非空标识 id、非空等值条件集合 when（RFC 6901 指针 -> 字符串/有限数字/
//   布尔/null，支持根、对象自有字段与数组下标，保留空字段名、__proto__ 与 ~0/~1
//   转义）与非空响应序列 responses；接口原 responses 成为无分支命中时的兜底序列。
//   请求通过全部正文校验后按同一配置快照选择：指针取值不存在或无法遍历即不命中
//   （缺失不同于 null、不做类型转换、0 与 -0 相等），全部条件满足才命中该支；
//   多支命中取第一支，无命中取兜底。各分支与兜底独立计数，不改写请求字节。
// - 管理入口 GET /__contractlab/requests 查询本次进程内的请求记录（一致快照、
//   不推进序列），POST /__contractlab/requests/clear 清空记录；记录只存在内存中，
//   管理范围（/__contractlab 本身及 /__contractlab/ 前缀）的请求一律不记录。
// - compare 子命令：离线比较旧、新两份场景文件，判断沿用旧接口约定的客户端
//   是否仍能调用新版；报告写 stdout，不启动监听、不修改文件。
// - import 子命令：读取本地 OpenAPI 3.0 JSON 与现有场景配置，按“方法 + 字面
//   路径”选择文档操作，仅用操作 requestBody 转换出的正文规则替换各接口的
//   requestBody（保留接口顺序与 responses），新场景 JSON 写 stdout。
// - verify 子命令：离线批量请求校验。读取 GET /__contractlab/requests 的完整
//   JSON 快照与一份场景配置，按输入顺序保留原编号逐条重新判定（仅依据记录中的
//   原始请求重新计算，不信任原版本、匹配/校验结论、计划响应与发送状态）；
//   报告写 stdout，不监听、不发送请求、不修改文件。
// - replay 子命令：本机请求重放与响应差异报告。读取同一份请求记录快照，
//   按输入顺序把每条记录的原始请求逐条重放到 127.0.0.1 的指定端口
//   （每条只尝试一次、不跟随重定向、每条有覆盖完整收发的总超时），
//   仅比较实际响应的状态码与正文和记录中的计划响应；可选 --strategy
//   比较策略按“方法 + 字面路径”为接口选择正文 JSON 语义比较（忽略键序、
//   排版与指定的 RFC 6901 忽略指针），未选中的接口仍按原始字节比较；
//   报告写 stdout，不监听、不修改文件。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const APP_NAME = 'contractlab';

// 管理入口（保留前缀，业务接口不得使用）
const ADMIN_PREFIX = '/__contractlab/';
const ADMIN_BASE = '/__contractlab';
const HEALTH_PATH = '/__contractlab/health';
const RELOAD_PATH = '/__contractlab/reload';
const REQUESTS_PATH = '/__contractlab/requests';
const REQUESTS_CLEAR_PATH = '/__contractlab/requests/clear';

// 每个业务响应都携带当前配置版本
const VERSION_HEADER = 'X-Contractlab-Version';

// 请求体上限（本机工具的防误操作保护，超出直接 413，不触碰任何序列）
const MAX_BODY_BYTES = 100 * 1024 * 1024;

// 由服务器管理、业务配置不得覆盖的“传输头”（大小写不敏感）
const BLOCKED_HEADERS = new Set([
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
]);

// RFC 7230 token：合法的 HTTP 头名称字符
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

type HttpMethod = 'GET' | 'POST';

// ---------------------------------------------------------------------------
// 请求正文结构规则（endpoints[].requestBody，仅 POST）
// ---------------------------------------------------------------------------
//
// 规则格式（JSON 对象，未知字段一律拒绝）：
//   { "type": "object", "fields": { "<名>": <字段规则>, ... }, "additionalProperties": false }
//   { "type": "array", "items": <规则> }
//   { "type": "string" | "number" | "integer" | "boolean" | "null" }
// 任意规则节点（根、字段、数组元素）可附布尔 "nullable"：省略或 false 行为不变，
// true 在原接受集合上加入 null（type:null 本就只接受 null）。必填字段即使可空也
// 不能缺失；null 被接受时不产生子节点差异，非 null 值仍须通过全部原约束。
// 标量节点（string/number/integer/boolean/null）可附非空 "enum" 候选数组：
// 每项须符合节点类型与可空约定（null 项要求 nullable:true 或 type:null），
// 顺序与重复值不影响语义（数字按数值相等，0 与 -0 等价，不做类型转换）；
// 有 enum 时接受集合为“类型及可空集合”与枚举集合的交集（可空不越过枚举）。
// object / array 节点禁止 enum。
// 字段规则 = 任意规则 + 可选 "required": true（缺省为可缺省）；
// object 的 fields / additionalProperties 可省略（默认无字段声明、拒绝未声明字段）；
// array 必须声明 items。

type ScalarKind = 'string' | 'number' | 'integer' | 'boolean' | 'null';

// 枚举候选值：标量字面量（含 null，仅当节点可空或 type:null 时允许）
type EnumValue = string | number | boolean | null;

type BodyRule =
  | {
      readonly kind: 'object';
      readonly fields: ReadonlyMap<string, FieldRule>;
      readonly additionalProperties: boolean;
      readonly nullable: boolean;
    }
  | { readonly kind: 'array'; readonly items: BodyRule; readonly nullable: boolean }
  | {
      readonly kind: ScalarKind;
      readonly nullable: boolean;
      // 非空候选数组（已按数值相等去重）；undefined 表示无枚举限制
      readonly enum: readonly EnumValue[] | undefined;
    };

interface FieldRule {
  readonly rule: BodyRule;
  readonly required: boolean;
}

// ---------------------------------------------------------------------------
// 按请求正文值选择的响应分支（endpoints[].branches，仅 POST 且声明 requestBody）
// ---------------------------------------------------------------------------
//
// 每个分支：
//   { "id": "<接口内唯一非空标识>",
//     "when": { "<RFC 6901 指针>": <等值条件值>, ... },   // 非空对象、至少一条
//     "responses": [ <非空响应序列> ] }
// 条件值只能是字符串、有限数字、布尔或 null；指针支持根（""）、对象自有字段
// （含空字段名与 "__proto__"）与数组下标，遵循 ~0/~1 转义。分支有序：全部条件
// 满足即命中该支，多支命中取第一支，均不命中时使用接口 responses 兜底序列。

type BranchConditionValue = string | number | boolean | null;

interface BranchCondition {
  // 原始指针串（RFC 6901），用于记录与错误定位
  readonly pointer: string;
  // 已解码的指针段（根指针为空数组）
  readonly segments: readonly string[];
  readonly value: BranchConditionValue;
}

interface BranchSpec {
  readonly id: string;
  readonly conditions: readonly BranchCondition[];
  readonly responses: readonly ResponseSpec[];
}

interface ResponseSpec {
  readonly status: number;
  readonly headers: { readonly [name: string]: string };
  readonly body: string;
  readonly delay: number;
}

interface EndpointSpec {
  readonly method: HttpMethod;
  readonly path: string;
  // 兜底响应序列（无分支命中时使用）
  readonly responses: readonly ResponseSpec[];
  readonly bodyRule: BodyRule | undefined;
  // 有序分支；仅当 bodyRule 存在时非空
  readonly branches: readonly BranchSpec[];
}

interface LiveBranch {
  readonly id: string;
  readonly conditions: readonly BranchCondition[];
  readonly responses: readonly ResponseSpec[];
  // 下一个待预留位置；到达末项后停在末项（持续复用）
  cursor: number;
}

interface LiveEndpoint {
  readonly key: string;
  // 兜底序列
  readonly responses: readonly ResponseSpec[];
  readonly bodyRule: BodyRule | undefined;
  readonly branches: readonly LiveBranch[];
  // 兜底序列的下一个待预留位置
  cursor: number;
}

interface LiveState {
  readonly version: number;
  readonly endpoints: ReadonlyMap<string, LiveEndpoint>;
}

interface ReloadResult {
  ok: boolean;
  version: number;
  error?: string;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// 配置校验
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePath(p: string, where: string): void {
  if (p.length === 0 || p[0] !== '/') {
    throw new ConfigError(`${where}.path 必须是以 "/" 开头的绝对路径，收到 "${p}"`);
  }
  if (p.length > 4096) {
    throw new ConfigError(`${where}.path 过长（最多 4096 字符）`);
  }
  for (const ch of p) {
    const code = ch.charCodeAt(0);
    if (ch === '?' || ch === '#' || ch === '{' || ch === '}') {
      throw new ConfigError(
        `${where}.path "${p}" 含有非法字符 "${ch}"：查询串不参与匹配，且不支持路径模板`,
      );
    }
    if (code <= 0x1f || code === 0x7f || code === 0x20) {
      throw new ConfigError(`${where}.path "${p}" 不得包含空白或控制字符`);
    }
  }
}

function validateResponse(raw: unknown, where: string): ResponseSpec {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} 必须是对象`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'status' && key !== 'headers' && key !== 'body' && key !== 'delay') {
      throw new ConfigError(`${where} 含未知字段 "${key}"`);
    }
  }

  const { status, headers, body, delay } = raw;

  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new ConfigError(`${where}.status 必须是 200 至 599 之间的整数，收到 ${JSON.stringify(status)}`);
  }

  if (!isPlainObject(headers)) {
    throw new ConfigError(`${where}.headers 必须是字符串键值对象`);
  }
  // 无原型对象：名为 "__proto__" 的头也按自有字段保留，不被原型 setter 吞掉
  const cleanHeaders: { [name: string]: string } = Object.create(null);
  const seenNames = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const whereHeader = `${where}.headers["${name}"]`;
    if (!HEADER_NAME_RE.test(name)) {
      throw new ConfigError(`${whereHeader} 不是合法的 HTTP 响应头名称`);
    }
    const lower = name.toLowerCase();
    if (BLOCKED_HEADERS.has(lower)) {
      throw new ConfigError(`${whereHeader} 属于服务器管理的传输头，不允许在配置中设置`);
    }
    if (seenNames.has(lower)) {
      throw new ConfigError(`${whereHeader} 与同序列内另一个响应头仅大小写不同，视为重复`);
    }
    if (typeof value !== 'string') {
      throw new ConfigError(`${whereHeader} 的值必须是字符串`);
    }
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      // 允许水平制表符(0x09)；拒绝换行及其余控制字符；
      // Node 的 HTTP 头值只支持 Latin-1（0x80-0xFF），更高码位发送时会抛错
      if ((code <= 0x1f && code !== 0x09) || code === 0x7f || code > 0xff) {
        throw new ConfigError(
          `${whereHeader} 的值不得包含换行或其他控制字符，且只能使用 Latin-1 字符`,
        );
      }
    }
    seenNames.add(lower);
    cleanHeaders[name] = value;
  }

  if (typeof body !== 'string') {
    throw new ConfigError(`${where}.body 必须是文本字符串`);
  }
  if ((status === 204 || status === 304) && body !== '') {
    throw new ConfigError(`${where}.body 状态码为 ${status} 时正文必须为空字符串`);
  }

  if (!Number.isInteger(delay) || delay < 0 || delay > 60000) {
    throw new ConfigError(`${where}.delay 必须是 0 至 60000 之间的整数毫秒数，收到 ${JSON.stringify(delay)}`);
  }

  return { status, headers: cleanHeaders, body, delay };
}

const SCALAR_KINDS: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

// 枚举项是否满足节点类型（不做类型转换；number 限有限数字、integer 限整数）
function enumItemConforms(kind: ScalarKind, item: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof item === 'string';
    case 'number':
      return typeof item === 'number' && Number.isFinite(item);
    case 'integer':
      return Number.isInteger(item);
    case 'boolean':
      return typeof item === 'boolean';
    case 'null':
      return item === null;
  }
}

// 校验并规范化枚举候选（场景配置与 OpenAPI 导入共用语义）：非空数组、逐项符合
// 节点类型与可空约定（null 项要求 nullable:true 或 type:null）、按数值相等去重
// （0 与 -0 等价；顺序与重复值不影响语义）。失败返回可定位的 where 与原因。
function enumValuesOrError(
  enumRaw: unknown,
  kind: ScalarKind,
  nullable: boolean,
  where: string,
): { errorWhere: string; message: string } | { values: EnumValue[] } {
  if (!Array.isArray(enumRaw) || enumRaw.length === 0) {
    return { errorWhere: where, message: '必须是非空数组（至少一个候选值）' };
  }
  // Set 按 SameValueZero 去重：0 与 -0 视为同一候选
  const seen = new Set<unknown>();
  const values: EnumValue[] = [];
  for (let i = 0; i < enumRaw.length; i += 1) {
    const item = enumRaw[i];
    const itemWhere = `${where}[${i}]`;
    if (item === null) {
      if (!nullable && kind !== 'null') {
        return {
          errorWhere: itemWhere,
          message: '为 null：接受 null 要求节点为 nullable:true 或 type:"null"',
        };
      }
    } else if (!enumItemConforms(kind, item)) {
      return {
        errorWhere: itemWhere,
        message: `必须是 ${kind}（与节点类型一致，不做类型转换），收到 ${JSON.stringify(item)}`,
      };
    }
    if (!seen.has(item)) {
      seen.add(item);
      values.push(item as EnumValue);
    }
  }
  return { values };
}

function validateBodyRule(raw: unknown, where: string): BodyRule {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} 必须是对象（含 "type" 字段）`);
  }

  const type = raw.type;
  const allowed = new Set(['type', 'nullable']);
  if (type === 'object') {
    allowed.add('fields');
    allowed.add('additionalProperties');
  } else if (type === 'array') {
    allowed.add('items');
  } else if (!SCALAR_KINDS.has(type as string)) {
    throw new ConfigError(
      `${where}.type 必须是 "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"，收到 ${JSON.stringify(type)}`,
    );
  } else {
    // enum 仅允许在标量节点上；object / array 节点声明 enum 按未知字段拒绝
    allowed.add('enum');
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`${where} 含未知字段 "${key}"`);
    }
  }

  // 任意规则节点可附布尔 nullable：省略或 false 不变，true 在原接受集合上加入 null
  const nullableRaw = raw.nullable;
  if (nullableRaw !== undefined && typeof nullableRaw !== 'boolean') {
    throw new ConfigError(`${where}.nullable 必须是布尔值，收到 ${JSON.stringify(nullableRaw)}`);
  }
  const nullable = nullableRaw === true;

  // 标量节点可附非空 enum：每项须符合节点类型与可空约定；有枚举时接受集合为
  // “类型及可空集合”与枚举集合的交集（可空不越过枚举，null 须列入枚举才被接受）
  let enumValues: readonly EnumValue[] | undefined;
  if (raw.enum !== undefined) {
    const result = enumValuesOrError(raw.enum, type as ScalarKind, nullable, `${where}.enum`);
    if ('errorWhere' in result) {
      throw new ConfigError(`${result.errorWhere} ${result.message}`);
    }
    enumValues = result.values;
  }

  if (type === 'object') {
    const fieldsRaw = raw.fields;
    const fields = new Map<string, FieldRule>();
    if (fieldsRaw !== undefined) {
      if (!isPlainObject(fieldsRaw)) {
        throw new ConfigError(`${where}.fields 必须是对象（字段名 → 字段规则）`);
      }
      for (const [name, fieldRaw] of Object.entries(fieldsRaw)) {
        fields.set(name, validateFieldRule(fieldRaw, `${where}.fields[${JSON.stringify(name)}]`));
      }
    }
    const additional = raw.additionalProperties;
    if (additional !== undefined && typeof additional !== 'boolean') {
      throw new ConfigError(`${where}.additionalProperties 必须是布尔值`);
    }
    // 未声明字段默认拒绝
    return { kind: 'object', fields, additionalProperties: additional === true, nullable };
  }

  if (type === 'array') {
    if (raw.items === undefined) {
      throw new ConfigError(`${where}.items 数组规则必须声明元素规则`);
    }
    return { kind: 'array', items: validateBodyRule(raw.items, `${where}.items`), nullable };
  }

  return { kind: type as ScalarKind, nullable, enum: enumValues };
}

// 字段规则 = 任意规则 + 可选 "required"（仅允许出现在 object 的 fields 条目中）
function validateFieldRule(raw: unknown, where: string): FieldRule {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} 必须是对象（含 "type" 字段）`);
  }
  let required = false;
  // 无原型对象：未知规则键 "__proto__" 必须作为自有字段保留下来，
  // 交由 validateBodyRule 拒绝；普通对象字面量会在复制时被原型 setter 吞掉
  const rest: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'required') {
      if (typeof value !== 'boolean') {
        throw new ConfigError(`${where}.required 必须是布尔值`);
      }
      required = value;
    } else {
      rest[key] = value;
    }
  }
  return { rule: validateBodyRule(rest, where), required };
}

// RFC 6901 JSON Pointer 语法解析："" 表示根（零段）；否则必须以 "/" 开头，
// 按 "/" 分段并反转义（~1 -> "/"，~0 -> "~"，先处理 ~1 以免二次转义）。
// 段内出现不以 0/1 收尾的 "~" 属非法指针。这里只判定语法；段能否在具体 JSON
// 值上遍历（对象自有字段、数组下标）由运行时选择逻辑判定。
// label 用于错误信息中对指针用途的称呼（分支条件键 / 忽略指针）。
function parseJsonPointer(raw: unknown, where: string, label = '条件键'): string[] {
  if (typeof raw !== 'string') {
    throw new ConfigError(`${where} 的${label}必须是 RFC 6901 指针字符串，收到 ${JSON.stringify(raw)}`);
  }
  if (raw === '') {
    return [];
  }
  if (raw[0] !== '/') {
    throw new ConfigError(
      `${where} 的指针 ${JSON.stringify(raw)} 非法：非根指针必须以 "/" 开头（根指针为 ""）`,
    );
  }
  return raw.slice(1).split('/').map((segment, i) => {
    let out = '';
    for (let j = 0; j < segment.length; j += 1) {
      const ch = segment[j];
      if (ch === '~') {
        const next = segment[j + 1];
        if (next === '0') {
          out += '~';
          j += 1;
        } else if (next === '1') {
          out += '/';
          j += 1;
        } else {
          throw new ConfigError(
            `${where} 的指针 ${JSON.stringify(raw)} 非法：第 ${i} 段含非法转义（仅支持 ~0 与 ~1）`,
          );
        }
      } else {
        out += ch;
      }
    }
    return out;
  });
}

// 等值条件值：字符串、有限数字、布尔或 null（不接受 NaN/Infinity、对象、数组）
function validateConditionValue(raw: unknown, where: string): BranchConditionValue {
  if (raw === null) {
    return null;
  }
  if (typeof raw === 'string' || typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw new ConfigError(
        `${where} 的条件值必须是有限数字，收到 ${JSON.stringify(raw)}`,
      );
    }
    return raw;
  }
  throw new ConfigError(
    `${where} 的条件值必须是字符串、有限数字、布尔或 null，收到 ${JSON.stringify(raw)}`,
  );
}

function validateBranch(raw: unknown, endpointWhere: string, index: number, seenIds: Set<string>): BranchSpec {
  const where = `${endpointWhere}.branches[${index}]`;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} 必须是对象`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'id' && key !== 'when' && key !== 'responses') {
      throw new ConfigError(`${where} 含未知字段 "${key}"`);
    }
  }

  const { id, when, responses } = raw;

  if (typeof id !== 'string' || id === '') {
    throw new ConfigError(`${where}.id 必须是非空字符串，收到 ${JSON.stringify(id)}`);
  }
  if (seenIds.has(id as string)) {
    throw new ConfigError(`${where}.id ${JSON.stringify(id)} 与同一接口的其他分支标识重复`);
  }
  seenIds.add(id as string);

  if (!isPlainObject(when)) {
    throw new ConfigError(`${where}.when 必须是“指针 -> 条件值”的非空对象`);
  }
  // JSON.parse 以 CreateDataProperty 写入，名为 "__proto__" 的条件键仍是自有字段
  const entries = Object.entries(when);
  if (entries.length === 0) {
    throw new ConfigError(`${where}.when 必须至少包含一条等值条件`);
  }
  const conditions: BranchCondition[] = entries.map(([pointer, valueRaw]) => {
    const condWhere = `${where}.when[${JSON.stringify(pointer)}]`;
    const segments = parseJsonPointer(pointer, condWhere);
    const value = validateConditionValue(valueRaw, condWhere);
    return { pointer, segments, value };
  });

  if (!Array.isArray(responses) || responses.length === 0) {
    throw new ConfigError(`${where}.responses 必须是非空数组`);
  }
  const cleanResponses = responses.map((item, j) =>
    validateResponse(item, `${where}.responses[${j}]`),
  );

  return { id: id as string, conditions, responses: cleanResponses };
}

function validateEndpoint(
  raw: unknown,
  index: number,
  seen: Set<string>,
): EndpointSpec {
  const where = `endpoints[${index}]`;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} 必须是对象`);
  }
  for (const key of Object.keys(raw)) {
    if (
      key !== 'method' &&
      key !== 'path' &&
      key !== 'responses' &&
      key !== 'requestBody' &&
      key !== 'branches'
    ) {
      throw new ConfigError(`${where} 含未知字段 "${key}"`);
    }
  }

  const { method, path: routePath, responses, requestBody, branches: branchesRaw } = raw;

  if (method !== 'GET' && method !== 'POST') {
    throw new ConfigError(`${where}.method 必须是 "GET" 或 "POST"，收到 ${JSON.stringify(method)}`);
  }

  if (typeof routePath !== 'string') {
    throw new ConfigError(`${where}.path 必须是字符串`);
  }
  validatePath(routePath, where);
  if (routePath === '/__contractlab' || routePath.startsWith(ADMIN_PREFIX)) {
    throw new ConfigError(
      `${where}.path "${routePath}" 与管理入口冲突：前缀 "${ADMIN_PREFIX}" 为管理接口保留`,
    );
  }

  const key = `${method} ${routePath}`;
  if (seen.has(key)) {
    throw new ConfigError(`${where} 与其他接口重复（方法 + 路径必须唯一）：${key}`);
  }
  seen.add(key);

  if (!Array.isArray(responses) || responses.length === 0) {
    throw new ConfigError(`${where}.responses 必须是非空数组`);
  }
  const cleanResponses = responses.map((item, j) =>
    validateResponse(item, `${where}.responses[${j}]`),
  );

  let bodyRule: BodyRule | undefined;
  if (requestBody !== undefined) {
    if (method !== 'POST') {
      throw new ConfigError(`${where}.requestBody 仅允许在 POST 接口上声明（GET 接口不允许携带此规则）`);
    }
    bodyRule = validateBodyRule(requestBody, `${where}.requestBody`);
  }

  let branches: readonly BranchSpec[] = [];
  if (branchesRaw !== undefined) {
    // 分支以正文值为条件：GET 接口与未声明 requestBody 的 POST 接口一律禁止
    if (method !== 'POST') {
      throw new ConfigError(`${where}.branches 仅允许在 POST 接口上声明（GET 接口不允许配置响应分支）`);
    }
    if (!bodyRule) {
      throw new ConfigError(
        `${where}.branches 仅允许在声明了 requestBody 的 POST 接口上配置：按正文值选择分支必须先声明正文规则`,
      );
    }
    if (!Array.isArray(branchesRaw) || branchesRaw.length === 0) {
      throw new ConfigError(`${where}.branches 必须是非空数组`);
    }
    const seenIds = new Set<string>();
    branches = branchesRaw.map((branch, j) => validateBranch(branch, where, j, seenIds));
  }

  return { method, path: routePath, responses: cleanResponses, bodyRule, branches };
}

function validateConfig(raw: unknown): EndpointSpec[] {
  if (!isPlainObject(raw)) {
    throw new ConfigError('配置顶层必须是 JSON 对象');
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'endpoints') {
      throw new ConfigError(`未知顶层字段 "${key}"，仅允许 "endpoints"`);
    }
  }
  const list = raw.endpoints;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError('endpoints 必须是至少包含一个接口的数组');
  }
  const seen = new Set<string>();
  return list.map((ep, i) => validateEndpoint(ep, i, seen));
}

// ---------------------------------------------------------------------------
// 运行时状态：配置快照 + 每接口独立序列
// ---------------------------------------------------------------------------

function buildState(version: number, specs: readonly EndpointSpec[]): LiveState {
  const endpoints = new Map<string, LiveEndpoint>();
  for (const spec of specs) {
    endpoints.set(`${spec.method} ${spec.path}`, {
      key: `${spec.method} ${spec.path}`,
      responses: spec.responses,
      bodyRule: spec.bodyRule,
      branches: spec.branches.map((branch) => ({
        id: branch.id,
        conditions: branch.conditions,
        responses: branch.responses,
        cursor: 0,
      })),
      cursor: 0,
    });
  }
  return { version, endpoints };
}

// 一个可选序列的预留结果：分支命中时为该支序列，否则为接口兜底序列
interface ReservedResponse {
  readonly position: number;
  readonly item: ResponseSpec;
  // 命中的分支标识；null 表示兜底
  readonly branchId: string | null;
  // 选中序列（用于记录 sequenceLength）
  readonly sequence: readonly ResponseSpec[];
}

// 同步预留下一项；同一事件循环内按“完整接收”事件的先后串行调用，天然保序。
// 末项之后持续返回末项，不跳项、不复用未到位置的项。
// 返回本次消费位置（0 起）与该项；末项复用时位置停在 length-1。
function reserveFromSequence(
  responses: readonly ResponseSpec[],
  cursorRef: { cursor: number },
): { position: number; item: ResponseSpec } {
  const last = responses.length - 1;
  const position = cursorRef.cursor < last ? cursorRef.cursor : last;
  if (cursorRef.cursor < last) {
    cursorRef.cursor += 1;
  }
  return { position, item: responses[position] };
}

// 按 RFC 6901 段在已解析 JSON 值上取值：
// - 零段（根指针 ""）返回根值；
// - 对象按自有字段（hasOwnProperty）取，空字段名与 "__proto__" 一样是普通字段；
// - 数组按下标取（"0" 或非零开头的十进制整数，且在长度范围内；"-" 越界不命中）；
// - 字段缺失、下标越界或需要在标量/null 上继续遍历时，返回 undefined 表示
//   “无法取到值”。调用方据此判定不命中——缺失与显式 null 必须区分。
function resolvePointer(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) {
        return undefined;
      }
      const index = Number(segment);
      if (index >= current.length) {
        return undefined;
      }
      current = current[index];
    } else if (isPlainObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return undefined;
      }
      current = current[segment];
    } else {
      // 在 null / 字符串 / 数字 / 布尔上无法继续遍历
      return undefined;
    }
  }
  return current;
}

// 等值匹配：严格相等、不做类型转换；=== 下数字 0 与 -0 本就相等。
// 取不到值（undefined）永不等于任何条件值，故显式 null 条件不会命中缺失字段。
function conditionMatches(root: unknown, condition: BranchCondition): boolean {
  const actual = resolvePointer(root, condition.segments);
  return actual !== undefined && actual === condition.value;
}

// 一支的全部条件都满足才命中
function branchMatches(branch: LiveBranch, parsedBody: unknown): boolean {
  for (const condition of branch.conditions) {
    if (!conditionMatches(parsedBody, condition)) {
      return false;
    }
  }
  return true;
}

// 根据正文值选择分支（首支命中）并从该支或兜底序列预留下一项
function reserveForBody(endpoint: LiveEndpoint, parsedBody: unknown): ReservedResponse {
  for (const branch of endpoint.branches) {
    if (branchMatches(branch, parsedBody)) {
      const { position, item } = reserveFromSequence(branch.responses, branch);
      return { position, item, branchId: branch.id, sequence: branch.responses };
    }
  }
  const { position, item } = reserveFromSequence(endpoint.responses, endpoint);
  return { position, item, branchId: null, sequence: endpoint.responses };
}

// ---------------------------------------------------------------------------
// 进程内请求记录
// ---------------------------------------------------------------------------
//
// 仅记录管理范围之外、完整接收且未超过正文上限的请求（场景响应、400、404）。
// 未收完整即断开或超出上限不创建记录、不消费序列。
// 编号按“完整接收”顺序在进程内单调递增，与接口消费位置是两回事；
// 清空与成功/失败重载都保留编号序列，编号不复用。记录只存在内存中，不写文件。

// 写出生命周期（仅指服务器侧写出，不表示客户端已收到）：
//   pending     —— 已完整接收、计划响应待发送（延迟期间即可查到）
//   sent        —— 服务器已完成响应写出；此后连接正常关闭不再改变状态
//   interrupted —— 写出完成前连接断开或写入/发送失败
type DeliveryStatus = 'pending' | 'sent' | 'interrupted';

// 计划响应：场景响应为 'scene'，400/404 等框架响应为 'framework'
interface PlannedResponseSnapshot {
  readonly kind: 'scene' | 'framework';
  readonly status: number;
  // 应用层响应头：配置头/框架头 + 服务器填写的准确版本头，不含传输层自动头
  readonly headers: { readonly [name: string]: string };
  // 配置/框架给出的响应正文文本（不含 HTTP 层按 Content-Length 等补出的字节）
  readonly body: string;
}

interface RequestRecord {
  readonly id: number;
  readonly receivedAt: string;
  readonly request: {
    readonly method: string;
    // 含查询串的原始请求目标
    readonly target: string;
    readonly path: string;
    // 原始请求头：按在线顺序成对保留，名称大小写与重复头均不折叠
    readonly rawHeaders: readonly string[];
    readonly bodyBytes: number;
    // 正文原始字节的无损表示：合法 UTF-8 时以文本给出，否则以 base64 给出
    readonly body: { readonly encoding: 'utf-8' | 'base64'; readonly content: string };
  };
  // 完整接收那一刻选用的配置版本；在途请求的结论不随之后的 reload 改变
  configVersion: number;
  // matched=false：未匹配（404），不消费任何序列
  matched: boolean;
  endpoint: string | null;
  // null 表示未做正文校验（GET/未声明规则）；true=通过，false=拒绝并返回 400
  bodyValidationPassed: boolean | null;
  // 400 时实际返回的差异报告（与响应正文中的 JSON 同一份数据）
  bodyRejection: BodyReport | null;
  // 场景请求的分支选择：
  //   null                 —— 未选择（400/404，或无分支的场景请求之外的情形）；
  //   { kind:'fallback' }  —— 无分支命中，使用接口兜底 responses；
  //   { kind:'branch', id }—— 命中指定分支，使用该支 responses。
  // 无分支接口的场景请求记为 fallback。
  branchSelection: { readonly kind: 'branch'; readonly id: string } | { readonly kind: 'fallback' } | null;
  // 场景请求在“选中序列”中的消费位置（0 起）；400/404 没有消费位置，记为 null
  sequencePosition: number | null;
  // 选中序列（命中分支或兜底）的长度；400/404 为 null
  sequenceLength: number | null;
  plannedResponse: PlannedResponseSnapshot | null;
  delivery: DeliveryStatus;
}

// 已清空记录的投递回调落到空集合上：不取消响应，旧请求之后完成也不得重新出现。
class RequestLog {
  private records: RequestRecord[] = [];
  // 仍可能被投递事件更新的记录 id 集合（清空后旧 id 不在其中）
  private readonly live = new Map<number, RequestRecord>();
  private nextId = 1;

  create(entry: {
    method: string;
    target: string;
    path: string;
    rawHeaders: readonly string[];
    body: Buffer;
    configVersion: number;
  }): RequestRecord {
    const id = this.nextId;
    this.nextId += 1;
    const record: RequestRecord = {
      id,
      receivedAt: new Date().toISOString(),
      request: {
        method: entry.method,
        target: entry.target,
        path: entry.path,
        rawHeaders: entry.rawHeaders,
        bodyBytes: entry.body.byteLength,
        body: encodeBodyLosslessly(entry.body),
      },
      configVersion: entry.configVersion,
      matched: false,
      endpoint: null,
      bodyValidationPassed: null,
      bodyRejection: null,
      branchSelection: null,
      sequencePosition: null,
      sequenceLength: null,
      plannedResponse: null,
      delivery: 'pending',
    };
    this.records.push(record);
    this.live.set(id, record);
    return record;
  }

  // 写出完成；对已清空（不再存活）的记录是 no-op
  markDelivered(id: number, status: DeliveryStatus): void {
    const record = this.live.get(id);
    if (!record) {
      return;
    }
    // 一旦完成写出即为终态：之后的连接正常关闭不得回退为 interrupted
    if (record.delivery === 'sent') {
      return;
    }
    record.delivery = status;
  }

  // 调用时一致快照：拷贝当前存活记录，不推进任何序列
  snapshot(): readonly RequestRecord[] {
    return [...this.records];
  }

  // 清空一次移除当时全部记录（含待发送项）；不取消响应、不改配置/版本/序列。
  // 清空前已完整接收的请求随后完成或失败都不再出现。
  clear(): number {
    const removed = this.records.length;
    this.records = [];
    this.live.clear();
    return removed;
  }
}

// 原始正文字节的无损文本表示：先尝试严格 UTF-8；失败则用 base64 承载任意字节。
// 记录的是原始字节而非解析后的 JSON，避免任何信息损失。
// ignoreBOM：开头 BOM（EF BB BF）必须保留在文本中（默认行为会将其丢弃），
// 否则文本重新编码回不去原始字节，快照就不再无损。
function encodeBodyLosslessly(body: Buffer): { encoding: 'utf-8' | 'base64'; content: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    return { encoding: 'utf-8', content: text };
  } catch {
    return { encoding: 'base64', content: body.toString('base64') };
  }
}

// ---------------------------------------------------------------------------
// 请求正文校验：媒体类型 → UTF-8 JSON 解析 → 结构比对
// ---------------------------------------------------------------------------

interface StructureProblem {
  readonly pointer: string;
  readonly expected: string;
  readonly actual: string;
}

interface BodyReport {
  readonly error: 'invalid_request_body';
  readonly stage: 'parse' | 'structure';
  readonly message: string;
  readonly problems: readonly StructureProblem[];
}

function parseFailure(message: string): BodyReport {
  return { error: 'invalid_request_body', stage: 'parse', message, problems: [] };
}

function jsonTypeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

// RFC 6901 JSON Pointer 段转义：~ -> ~0，/ -> ~1
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

// 枚举差异的期望描述：列全候选值（JSON 形式，数字 0 与 -0 都写作 0）
function enumExpectedText(enumValues: readonly EnumValue[]): string {
  return `枚举 ${JSON.stringify(enumValues)} 之一`;
}

// 结构比对：父节点类型不符时只报告该节点，不再深入制造子节点错误；
// 字段缺失（hasOwnProperty 为假）与合法的 JSON null 分开判断。
// 可空规则：null 被接受时不产生任何子节点差异；非 null 继续检查全部原约束。
// 枚举规则：接受集合为“类型及可空集合”与枚举集合的交集——可空不越过枚举
// （null 须列入枚举才被接受）；类型错误只报类型差异，不重复报枚举差异。
function checkRule(
  rule: BodyRule,
  value: unknown,
  pointer: string,
  problems: StructureProblem[],
): void {
  if (value === null && rule.nullable) {
    // 可空不越过枚举：有枚举时 null 仍须在候选集合中
    if (rule.kind === 'object' || rule.kind === 'array') {
      return;
    }
    if (rule.enum === undefined || rule.enum.includes(null)) {
      return;
    }
    problems.push({ pointer, expected: enumExpectedText(rule.enum), actual: 'null' });
    return;
  }
  switch (rule.kind) {
    case 'string':
    case 'boolean':
      if (typeof value !== rule.kind) {
        problems.push({ pointer, expected: rule.kind, actual: jsonTypeOf(value) });
        return;
      }
      break;
    case 'null':
      if (value !== null) {
        problems.push({ pointer, expected: 'null', actual: jsonTypeOf(value) });
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push({ pointer, expected: 'number', actual: jsonTypeOf(value) });
        return;
      }
      break;
    case 'integer':
      if (!Number.isInteger(value)) {
        problems.push({ pointer, expected: 'integer', actual: jsonTypeOf(value) });
        return;
      }
      break;
    case 'array': {
      if (!Array.isArray(value)) {
        problems.push({ pointer, expected: 'array', actual: jsonTypeOf(value) });
        return;
      }
      for (let i = 0; i < value.length; i += 1) {
        checkRule(rule.items, value[i], `${pointer}/${i}`, problems);
      }
      return;
    }
    case 'object': {
      if (!isPlainObject(value)) {
        problems.push({ pointer, expected: 'object', actual: jsonTypeOf(value) });
        return;
      }
      for (const [name, field] of rule.fields) {
        const childPointer = `${pointer}/${escapePointerSegment(name)}`;
        if (!Object.prototype.hasOwnProperty.call(value, name)) {
          if (field.required) {
            problems.push({
              pointer: childPointer,
              expected: `${field.rule.kind}（必填字段）`,
              actual: 'missing',
            });
          }
        } else {
          checkRule(field.rule, value[name], childPointer, problems);
        }
      }
      if (!rule.additionalProperties) {
        for (const key of Object.keys(value)) {
          if (!rule.fields.has(key)) {
            problems.push({
              pointer: `${pointer}/${escapePointerSegment(key)}`,
              expected: '未声明的字段（不允许）',
              actual: jsonTypeOf(value[key]),
            });
          }
        }
      }
      return;
    }
  }
  // 标量枚举：类型检查已通过才核对候选集合（类型错误不重复报枚举错误）；
  // 数字按数值相等（0 与 -0 等价），不做类型转换
  if (rule.enum !== undefined && !rule.enum.includes(value as EnumValue)) {
    problems.push({
      pointer,
      expected: enumExpectedText(rule.enum),
      actual: JSON.stringify(value),
    });
  }
}

// 返回 null 表示校验通过；否则为可直接序列化的 400 差异报告。
// contentType 为在线顺序第一项 Content-Type 头值（在线：Node 对重复
// content-type 只保留首项；离线 verify：取 rawHeaders 中首个同名头）。
// 正文解码与 JSON 解析不重写原文：BOM 与空白按 UTF-8 解码的默认规则处理，
// 在线与离线对同一组字节给出同一结论。
// 通过时经 parseBodyOnly 另行解析以取得分支选择所用的 JSON 值。
function validateBodyWithContentType(
  contentType: string | undefined,
  body: Buffer,
  rule: BodyRule,
): BodyReport | null {
  const parsed = parseJsonBodyForCheck(contentType, body);
  if ('report' in parsed) {
    return parsed.report;
  }
  const problems: StructureProblem[] = [];
  checkRule(rule, parsed.value, '', problems);
  if (problems.length > 0) {
    return {
      error: 'invalid_request_body',
      stage: 'structure',
      message: `请求正文与接口约定存在 ${problems.length} 处差异`,
      problems,
    };
  }
  return null;
}

// 媒体类型 -> UTF-8 -> JSON 解析：通过返回 { value }，否则返回 { report }。
// 在线（分支选择）与离线需要同一解析结论，故抽出共用。
function parseJsonBodyForCheck(
  contentType: string | undefined,
  body: Buffer,
): { value: unknown } | { report: BodyReport } {
  const mediaType =
    typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
  if (mediaType !== 'application/json') {
    return {
      report: parseFailure(
        typeof contentType === 'string'
          ? `媒体类型不符：期望 application/json（可带参数、忽略大小写），收到 "${contentType}"`
          : '缺少 Content-Type 头：期望 application/json（可带参数、忽略大小写）',
      ),
    };
  }

  if (body.length === 0) {
    return { report: parseFailure('请求正文为空，无法解析为 JSON') };
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return { report: parseFailure('请求正文不是合法的 UTF-8 编码') };
  }

  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { report: parseFailure(`请求正文不是合法 JSON：${describeError(e)}`) };
  }
}

// 在线路径：校验媒体类型/UTF-8/JSON/结构，通过时同时返回解析出的 JSON 值
// （供按正文值选择响应分支使用）。
function validateBodyAndParse(
  contentType: string | undefined,
  body: Buffer,
  rule: BodyRule,
): { report: BodyReport } | { value: unknown } {
  const parsed = parseJsonBodyForCheck(contentType, body);
  if ('report' in parsed) {
    return parsed;
  }
  const problems: StructureProblem[] = [];
  checkRule(rule, parsed.value, '', problems);
  if (problems.length > 0) {
    return {
      report: {
        error: 'invalid_request_body',
        stage: 'structure',
        message: `请求正文与接口约定存在 ${problems.length} 处差异`,
        problems,
      },
    };
  }
  return { value: parsed.value };
}

// ---------------------------------------------------------------------------
// 文件读取与（重新）加载：读、解析、校验全部通过后才一次性替换
// ---------------------------------------------------------------------------

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 读取 -> 解析 -> 严格校验；任何一步失败都抛出含文件路径与可定位原因的错误
async function loadSpecsFromFile(configPath: string): Promise<EndpointSpec[]> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (e) {
    throw new Error(`读取配置文件 ${configPath} 失败：${describeError(e)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`配置文件 ${configPath} 不是合法 JSON：${describeError(e)}`);
  }

  try {
    return validateConfig(raw);
  } catch (e) {
    throw new Error(`配置文件 ${configPath} 校验失败：${describeError(e)}`);
  }
}

async function loadStateFromFile(configPath: string, version: number): Promise<LiveState> {
  return buildState(version, await loadSpecsFromFile(configPath));
}

// ---------------------------------------------------------------------------
// 离线兼容报告（compare 子命令）
// ---------------------------------------------------------------------------
//
// 兼容方向固定为 旧 -> 新：旧配置能按“方法 + 字面路径”匹配且通过正文检查的
// 每一种请求，在新配置中仍须匹配并通过。只比较接口存在性与请求接受条件；
// 响应状态/头/正文/延迟与序列差异不影响结论。
//
// 双方都配置 requestBody 时，比较的是“规则所接受 JSON 值的集合包含关系”
// L(旧规则) ⊆ L(新规则)，而不是文本比较或抽样请求；每个不兼容点都附一份
// 具体反例（旧规则接受、新规则拒绝的完整 JSON 值）。

interface ReportReason {
  // 正文差异：RFC 6901 指针（根为 ""）；接口级原因（如接口删除）无此字段
  readonly pointer?: string;
  readonly message: string;
}

interface ReportExample {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers: { readonly [name: string]: string };
  readonly body: string;
}

interface EndpointReport {
  readonly method: HttpMethod;
  readonly path: string;
  readonly compatible: boolean;
  readonly reasons: readonly ReportReason[];
  readonly example?: ReportExample;
}

interface CompareReport {
  readonly compatible: boolean;
  readonly oldFile: string;
  readonly newFile: string;
  readonly endpoints: readonly EndpointReport[];
}

interface BodyViolation {
  readonly pointer: string;
  readonly message: string;
  // 完整请求正文反例：被旧规则接受、被新规则拒绝
  readonly value: unknown;
}

// 生成被规则接受的最小 JSON 值：object 只含必填字段，array 取空数组；
// 枚举节点任选一候选（优先非 null 项——“类型收紧”反例需要非 null 样本）。
// 字段名可能是 "" 或 "__proto__"，一律用无原型对象按自有字段构造。
function sampleValue(rule: BodyRule): unknown {
  if (rule.kind !== 'object' && rule.kind !== 'array' && rule.enum !== undefined) {
    const nonNull = rule.enum.find((v) => v !== null);
    return nonNull === undefined ? null : nonNull;
  }
  switch (rule.kind) {
    case 'string':
      return 'contractlab';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array':
      return [];
    case 'object': {
      const obj: Record<string, unknown> = Object.create(null);
      for (const [name, field] of rule.fields) {
        if (field.required) {
          obj[name] = sampleValue(field.rule);
        }
      }
      return obj;
    }
  }
}

// 规则是否接受 null：type:null 或 nullable:true；有枚举时 null 还须列入候选
// （可空不越过枚举）。object / array 节点没有枚举。
function ruleAcceptsNullValue(rule: BodyRule): boolean {
  if (!rule.nullable && rule.kind !== 'null') {
    return false;
  }
  if (rule.kind === 'object' || rule.kind === 'array') {
    return true;
  }
  return rule.enum === undefined || rule.enum.includes(null);
}

// 规则的非 null 接受集合是否非空：枚举仅含 null 项的标量规则只接受 null
function hasNonNullAcceptedValues(rule: BodyRule): boolean {
  if (rule.kind === 'null') {
    return false;
  }
  if (rule.kind === 'object' || rule.kind === 'array') {
    return true;
  }
  return rule.enum === undefined || rule.enum.some((v) => v !== null);
}

// 在 object 规则的最小样本上补一个字段（字段值本身须被该字段规则接受）
function sampleObjectWith(
  rule: Extract<BodyRule, { kind: 'object' }>,
  name: string,
  value: unknown,
): Record<string, unknown> {
  const obj = sampleValue(rule) as Record<string, unknown>;
  obj[name] = value;
  return obj;
}

// 生成被规则拒绝的 JSON 值（顶层类型即不符；任何规则都存在这样的值）
function violateValue(rule: BodyRule): unknown {
  switch (rule.kind) {
    case 'number':
      return 'contractlab'; // 非数字
    case 'integer':
      return 0.5; // 非整数
    default:
      return 0; // 非 string / boolean / null / object / array
  }
}

function kindLabel(rule: BodyRule): string {
  if (rule.kind === 'object') {
    return rule.additionalProperties ? 'object（允许未声明字段）' : 'object（拒绝未声明字段）';
  }
  return rule.kind;
}

// 选一个两个规则都未声明的字段名，用于构造“额外字段”反例
function freshFieldName(
  oldFields: ReadonlyMap<string, FieldRule>,
  newFields: ReadonlyMap<string, FieldRule>,
): string {
  for (let i = 0; ; i += 1) {
    const name = i === 0 ? 'extra' : `extra_${i}`;
    if (!oldFields.has(name) && !newFields.has(name)) {
      return name;
    }
  }
}

// 非 null 值是否被标量规则接受：先过类型约束，再过枚举候选（如有）
function scalarValueAccepted(
  rule: Extract<BodyRule, { kind: ScalarKind }>,
  value: unknown,
): boolean {
  switch (rule.kind) {
    case 'string':
      if (typeof value !== 'string') {
        return false;
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        return false;
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return false;
      }
      break;
    case 'integer':
      if (!Number.isInteger(value)) {
        return false;
      }
      break;
    case 'null':
      return false; // 本函数只处理非 null 值
  }
  return rule.enum === undefined || rule.enum.includes(value as EnumValue);
}

// 标量规则的简述（用于原因消息）：类型 + 枚举候选（如有）
function scalarRuleLabel(rule: Extract<BodyRule, { kind: ScalarKind }>): string {
  return rule.enum === undefined ? rule.kind : `${rule.kind}（${enumExpectedText(rule.enum)}）`;
}

// 生成一个属于指定类型、但不在给定枚举中的值（类型取值无限，必然找得到）
function freshValueOutsideEnum(
  kind: 'string' | 'number' | 'integer',
  enumValues: readonly EnumValue[],
): string | number {
  if (kind === 'string') {
    for (let i = 0; ; i += 1) {
      const candidate = i === 0 ? 'contractlab' : `contractlab_${i}`;
      if (!enumValues.includes(candidate)) {
        return candidate;
      }
    }
  }
  for (let i = 0; ; i += 1) {
    if (!enumValues.includes(i)) {
      return i;
    }
  }
}

// 标量旧规则 ⊆ 标量新规则的精确判定（双方都不是 null 类型；null 接受性已由
// 调用方比较）。枚举按集合语义处理：
// - 旧有枚举：旧的非 null 接受集合就是枚举的非 null 项，逐一核对新规则；
// - 旧无枚举、新有枚举：旧的接受集合是整个类型取值（boolean 有限，逐一核对；
//   string/number/integer 无限，构造不在新枚举中的见证值）；
// - 双方均无枚举：仅同名兼容，外加 integer 放宽为 number。
function collectScalarViolations(
  oldRule: Extract<BodyRule, { kind: ScalarKind }>,
  newRule: Extract<BodyRule, { kind: ScalarKind }>,
  pointer: string,
  out: BodyViolation[],
): void {
  if (oldRule.enum !== undefined) {
    for (const value of oldRule.enum) {
      if (value === null) {
        continue; // null 的接受性已由调用方比较
      }
      if (!scalarValueAccepted(newRule, value)) {
        out.push({
          pointer,
          value,
          message: `枚举收紧：旧规则接受的枚举值 ${JSON.stringify(value)} 不被新规则（${scalarRuleLabel(newRule)}）接受`,
        });
      }
    }
    return;
  }

  if (newRule.enum !== undefined) {
    // 旧规则接受整个类型集合，新规则只接受枚举候选
    if (oldRule.kind === 'boolean') {
      for (const value of [false, true]) {
        if (!scalarValueAccepted(newRule, value)) {
          out.push({
            pointer,
            value,
            message: `新规则引入枚举限制（${enumExpectedText(newRule.enum)}），旧规则允许的值 ${JSON.stringify(value)} 不在候选中`,
          });
        }
      }
      return;
    }
    if (oldRule.kind === 'string' || oldRule.kind === 'number' || oldRule.kind === 'integer') {
      // 类型取值无限而枚举有限：构造旧规则接受、但不在新枚举中的见证值
      const witness = freshValueOutsideEnum(oldRule.kind, newRule.enum);
      out.push({
        pointer,
        value: witness,
        message: `新规则引入枚举限制（${enumExpectedText(newRule.enum)}），旧规则允许的值 ${JSON.stringify(witness)} 不在候选中`,
      });
      return;
    }
    return; // oldRule.kind === 'null' 不会到达（调用方已处理）
  }

  // 双方均无枚举：仅同名兼容，外加 integer 放宽为 number
  const compatible =
    oldRule.kind === newRule.kind || (oldRule.kind === 'integer' && newRule.kind === 'number');
  if (!compatible) {
    // number -> integer 时样本必须是非整数，否则 0 会被新规则接受
    const value =
      oldRule.kind === 'number' && newRule.kind === 'integer' ? 0.5 : sampleValue(oldRule);
    out.push({
      pointer,
      value,
      message: `类型收紧：旧规则接受 ${kindLabel(oldRule)}，新规则只接受 ${newRule.kind}`,
    });
  }
}

// 递归判定 L(oldRule) ⊆ L(newRule)；把发现的每个反例（连同完整正文样本）推入 out。
// 不变式：value 必被 oldRule 接受、被 newRule 拒绝；pointer 用 RFC 6901 定位差异。
// 可空（nullable:true 或 type:null）规则的接受集合含 null：先单独比较 null 的
// 接受性，再比较双方的非 null 部分——可空不能掩盖非 null 约束的变化。
// 枚举（enum）规则按集合语义比较：接受集合为“类型及可空集合”与枚举集合的交集，
// 枚举增删、枚举与非枚举规则交叉（如 number 枚举全为整数时兼容非枚举 integer）
// 都精确判定；可空不越过枚举（null 须列入枚举才算被接受）。
function collectViolations(
  oldRule: BodyRule,
  newRule: BodyRule,
  pointer: string,
  out: BodyViolation[],
): void {
  const oldAcceptsNull = ruleAcceptsNullValue(oldRule);
  const newAcceptsNull = ruleAcceptsNullValue(newRule);
  if (oldAcceptsNull && !newAcceptsNull) {
    // null 本身就是完整反例；嵌套位置由外层调用方包上必要的父对象与必填字段
    out.push({ pointer, value: null, message: '旧规则接受 null，新规则不接受 null' });
  }
  // type:null 的旧规则只接受 null（上面已比较），没有非 null 值需要再比
  if (oldRule.kind === 'null') {
    return;
  }
  // 枚举仅含 null 项的旧规则同样只接受 null：可比较的只有 null，上面已处理
  if (!hasNonNullAcceptedValues(oldRule)) {
    return;
  }
  // 新规则只接受 null：旧规则的任意非 null 样本都是反例
  if (newRule.kind === 'null') {
    out.push({
      pointer,
      value: sampleValue(oldRule),
      message: `类型收紧：旧规则接受 ${kindLabel(oldRule)}，新规则只接受 null`,
    });
    return;
  }

  if (newRule.kind !== 'object' && newRule.kind !== 'array') {
    // 新规则是标量：旧规则为对象/数组时任何样本都被拒绝
    if (oldRule.kind === 'object' || oldRule.kind === 'array') {
      out.push({
        pointer,
        value: sampleValue(oldRule),
        message: `类型收紧：旧规则接受 ${kindLabel(oldRule)}，新规则只接受 ${newRule.kind}`,
      });
      return;
    }
    collectScalarViolations(oldRule, newRule, pointer, out);
    return;
  }

  if (newRule.kind === 'array') {
    if (oldRule.kind !== 'array') {
      out.push({
        pointer,
        value: sampleValue(oldRule),
        message: `类型收紧：旧规则接受 ${kindLabel(oldRule)}，新规则只接受 array`,
      });
      return;
    }
    // 元素规则收紧：用非空数组 [反例] 体现（空数组双方都会接受）
    const sub: BodyViolation[] = [];
    collectViolations(oldRule.items, newRule.items, `${pointer}/0`, sub);
    for (const s of sub) {
      out.push({ pointer: s.pointer, message: s.message, value: [s.value] });
    }
    return;
  }

  // newRule.kind === 'object'
  if (oldRule.kind !== 'object') {
    out.push({
      pointer,
      value: sampleValue(oldRule),
      message: `类型收紧：旧规则接受 ${kindLabel(oldRule)}，新规则只接受 object`,
    });
    return;
  }

  // (a) 新规则的必填字段必须被旧规则保证存在（旧规则未声明或仅可选即存在反例）
  for (const [name, newField] of newRule.fields) {
    if (!newField.required) {
      continue;
    }
    const oldField = oldRule.fields.get(name);
    if (!oldField || !oldField.required) {
      out.push({
        pointer: `${pointer}/${escapePointerSegment(name)}`,
        // 旧规则的最小样本不含可缺省/未声明字段，恰为反例
        value: sampleValue(oldRule),
        message: `新规则要求必填字段 ${JSON.stringify(name)}，旧规则允许缺省该字段`,
      });
    }
  }

  // (b) 旧规则声明的字段，在新规则下仍须被接受
  for (const [name, oldField] of oldRule.fields) {
    const childPointer = `${pointer}/${escapePointerSegment(name)}`;
    const newField = newRule.fields.get(name);
    if (!newField) {
      if (!newRule.additionalProperties) {
        out.push({
          pointer: childPointer,
          value: sampleObjectWith(oldRule, name, sampleValue(oldField.rule)),
          message: `新规则拒绝旧规则允许的字段 ${JSON.stringify(name)}（新规则未声明且 additionalProperties 为 false）`,
        });
      }
      continue;
    }
    const sub: BodyViolation[] = [];
    collectViolations(oldField.rule, newField.rule, childPointer, sub);
    for (const s of sub) {
      out.push({
        pointer: s.pointer,
        message: s.message,
        value: sampleObjectWith(oldRule, name, s.value),
      });
    }
  }

  // (c) 旧规则允许未声明的额外字段时，新规则必须同样放行这些字段
  if (oldRule.additionalProperties) {
    if (!newRule.additionalProperties) {
      const name = freshFieldName(oldRule.fields, newRule.fields);
      out.push({
        pointer: `${pointer}/${escapePointerSegment(name)}`,
        value: sampleObjectWith(oldRule, name, 0),
        message: '旧规则允许未声明的额外字段，新规则拒绝（additionalProperties 为 false）',
      });
    } else {
      // 新规则虽放行额外字段，但其新声明的字段会约束旧版原本自由的取值
      for (const [name, newField] of newRule.fields) {
        if (oldRule.fields.has(name)) {
          continue;
        }
        out.push({
          pointer: `${pointer}/${escapePointerSegment(name)}`,
          value: sampleObjectWith(oldRule, name, violateValue(newField.rule)),
          message: `旧规则对额外字段 ${JSON.stringify(name)} 不限制取值，新规则要求其为 ${kindLabel(newField.rule)}`,
        });
      }
    }
  }
}

// 旧接口被旧配置接受的一个请求样本（用于“接口已删除”反例）
function acceptedRequestExample(endpoint: EndpointSpec): ReportExample {
  if (endpoint.bodyRule) {
    return {
      method: endpoint.method,
      path: endpoint.path,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleValue(endpoint.bodyRule)),
    };
  }
  return { method: endpoint.method, path: endpoint.path, headers: {}, body: '' };
}

function compareEndpoint(oldEp: EndpointSpec, newEp: EndpointSpec | undefined): EndpointReport {
  const base = { method: oldEp.method, path: oldEp.path };

  if (!newEp) {
    return {
      ...base,
      compatible: false,
      reasons: [
        { message: '新配置中不存在该接口：按 方法 + 字面路径 匹配不到，旧客户端的调用将得到 404' },
      ],
      example: acceptedRequestExample(oldEp),
    };
  }

  if (!oldEp.bodyRule && !newEp.bodyRule) {
    return { ...base, compatible: true, reasons: [] };
  }

  if (!oldEp.bodyRule && newEp.bodyRule) {
    // 旧版允许任意媒体类型与正文；新版启用校验即存在被拒绝的旧请求
    return {
      ...base,
      compatible: false,
      reasons: [
        {
          pointer: '',
          message: '旧接口不校验请求正文（任意媒体类型与正文均可），新接口启用了 requestBody 正文校验',
        },
      ],
      example: {
        ...base,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(violateValue(newEp.bodyRule)),
      },
    };
  }

  if (oldEp.bodyRule && !newEp.bodyRule) {
    return { ...base, compatible: true, reasons: [] }; // 移除规则更宽松
  }

  const violations: BodyViolation[] = [];
  collectViolations(oldEp.bodyRule as BodyRule, newEp.bodyRule as BodyRule, '', violations);
  if (violations.length === 0) {
    return { ...base, compatible: true, reasons: [] };
  }
  return {
    ...base,
    compatible: false,
    reasons: violations.map((v) => ({ pointer: v.pointer, message: v.message })),
    example: {
      ...base,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(violations[0].value),
    },
  };
}

function compareConfigs(
  oldSpecs: readonly EndpointSpec[],
  newSpecs: readonly EndpointSpec[],
  oldFile: string,
  newFile: string,
): CompareReport {
  const newByKey = new Map<string, EndpointSpec>();
  for (const spec of newSpecs) {
    newByKey.set(`${spec.method} ${spec.path}`, spec);
  }
  const endpoints = oldSpecs.map((spec) =>
    compareEndpoint(spec, newByKey.get(`${spec.method} ${spec.path}`)),
  );
  return {
    compatible: endpoints.every((ep) => ep.compatible),
    oldFile,
    newFile,
    endpoints,
  };
}

async function runCompare(oldArg: string, newArg: string): Promise<never> {
  const oldFile = path.resolve(oldArg);
  const newFile = path.resolve(newArg);

  const attempt = async (
    file: string,
  ): Promise<{ specs?: EndpointSpec[]; error?: string }> => {
    try {
      return { specs: await loadSpecsFromFile(file) };
    } catch (e) {
      return { error: describeError(e) };
    }
  };

  // 两份文件都完整经历 读取 -> 解析 -> 严格校验；任一失败则不输出任何报告
  const [oldResult, newResult] = await Promise.all([attempt(oldFile), attempt(newFile)]);
  let failed = false;
  if (oldResult.error !== undefined) {
    process.stderr.write(`${APP_NAME}: compare 旧文件：${oldResult.error}\n`);
    failed = true;
  }
  if (newResult.error !== undefined) {
    process.stderr.write(`${APP_NAME}: compare 新文件：${newResult.error}\n`);
    failed = true;
  }
  if (failed) {
    process.exit(2);
  }

  const report = compareConfigs(
    oldResult.specs as EndpointSpec[],
    newResult.specs as EndpointSpec[],
    oldFile,
    newFile,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.compatible ? 0 : 1);
}

// ---------------------------------------------------------------------------
// OpenAPI 请求正文约定导入（import 子命令）
// ---------------------------------------------------------------------------
//
// 读取本地 OpenAPI 3.0 JSON 与现有场景配置，按“方法 + 字面路径”为每个场景
// 接口选择文档操作，仅用操作 requestBody 转换出的正文规则替换接口的
// requestBody（保留接口顺序与 responses），把可直接用于 serve / compare 的
// 新场景 JSON 写往 stdout。不监听端口、不联网、不修改输入文件。
//
// 转换约定：
// - 场景每个接口都必须在文档 paths 中找到同路径、同方法的操作，否则拒绝；
// - GET 操作声明 requestBody 拒绝；POST 未声明 requestBody 时移除接口旧规则；
// - POST 的 requestBody 必须 required=true，content 仅含 application/json
//   且带 schema，否则拒绝；
// - schema 支持 object/array/string/number/integer/boolean、递归
//   properties/required/items、布尔 additionalProperties（缺省按 OpenAPI
//   语义为允许，并在输出中显式写出）、布尔 nullable（true 在转换结果的
//   接受集合上加入 null，false 或省略不变，非布尔值拒绝）与标量 enum
//   （非空候选数组，逐项符合类型与可空约定；object/array schema 与 allOf
//   组合节点禁止 enum）；无 type 的 allOf 组合节点仍只允许 nullable:false
//   或省略；title/description/example 可忽略，其余关键字或非法值一律拒绝；
// - 支持本文件内 $ref（按 JSON Pointer 转义解析）：共享引用允许，目标缺失、
//   外部引用与循环引用拒绝并给出引用链；引用节点只含 $ref；
// - 支持纯对象 allOf：组合节点仅含 allOf 与上述注释，分支可引用或任意深度
//   嵌套组合（嵌套 allOf 展平为全部对象叶分支）；按所选操作最终请求正文的
//   整体接受集合求各分支交集，结论与分支顺序、嵌套分组、本文件内引用无关；
//   同名字段（对象内部与数组元素）递归相交、number∩integer 取 integer、
//   必填合并、各分支额外字段限制同时生效；交集含 null 当且仅当全部分支都
//   接受 null（nullable:true），非 null 部分按结构求交，仅剩 null 时输出
//   type:null；区分字段禁止出现、整体空交集与非空但无法表达，后两者定位
//   原因并拒绝，不扩展规则种类；
// - 未被场景选中的操作与不可达定义不参与转换（其中的错误不影响结果）；
//   全部输入与所选可达定义有效后才输出，成功退出 0，失败退出 2
//   （stderr 指明文件与操作或定义位置，stdout 为空）。

class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

// allOf 交集的三态结论（整体语义，必须对“全部”分支一次判定，不能逐对折叠）：
// - nonempty  交集非空，且现有规则种类可以精确表达，rule 即交集规则；
// - empty     交集为空（连一个可接受的值都没有），reason 说明首个空点，
//             loc 是首个贡献该空点分支的“对象级”位置（数组元素归到其所在对象）；
// - inexpressible 交集非空，但现有规则种类表达不了，rule 是其“近似规则”
//             （用于在外层把 inexpressible 精确收窄为 empty），loc 是首个贡献
//             不可表达点分支的对象级位置，reason 说明不可表达的原因。
//
// 之所以不能在两两合并的中途拒绝：可选字段的“非空但不可表达”只是中间现象，
// 再叠加一个封闭空对象分支后，真实交集可能恰好为空对象 {}（可表达）。
type Intersection =
  | { readonly tag: 'nonempty'; readonly rule: NormRule }
  | { readonly tag: 'empty'; readonly reason: string; readonly loc: string }
  | {
      readonly tag: 'inexpressible';
      readonly rule: NormRule;
      readonly reason: string;
      readonly loc: string;
    };

// 转换过程中的规范化规则：与 BodyRule 同构，但 object 的必填名集合单独保存，
// 便于 allOf 交集计算；输出时再展开为场景规则 JSON。
// nullable 表示该规则额外接受 null；kind 为 null 的规则仅由“交集仅剩 null”
// 产生（输入 schema 不支持 type:null），只接受 null。
// 标量规则可带 enum 候选（非空、已去重）：接受集合为“类型及可空集合”与枚举
// 集合的交集，与场景规则语义一致。
type NormScalarKind = 'string' | 'number' | 'integer' | 'boolean';

interface NormScalar {
  readonly kind: NormScalarKind;
  readonly nullable: boolean;
  readonly enum: readonly EnumValue[] | undefined;
}

type NormRule =
  | {
      readonly kind: 'object';
      readonly props: ReadonlyMap<string, NormRule>;
      readonly required: ReadonlySet<string>;
      readonly addl: boolean;
      readonly nullable: boolean;
    }
  | { readonly kind: 'array'; readonly items: NormRule; readonly nullable: boolean }
  | NormScalar
  | { readonly kind: 'null' };

type NormObject = Extract<NormRule, { kind: 'object' }>;

interface ImportCtx {
  // 整份 OpenAPI 文档（$ref 解析的根）
  readonly doc: unknown;
  readonly file: string;
}

function importErrorMessage(ctx: ImportCtx, where: string, message: string): string {
  return where === ''
    ? `OpenAPI 文件 ${ctx.file}：${message}`
    : `OpenAPI 文件 ${ctx.file} 的 ${where}：${message}`;
}

function importFail(ctx: ImportCtx, where: string, message: string): never {
  throw new ImportError(importErrorMessage(ctx, where, message));
}

const OPENAPI_ANNOTATION_KEYS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'example',
  'nullable',
]);

const OPENAPI_SCALAR_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
]);

function hasOwnKey(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// JSON Pointer 段反转义：~1 -> /，~0 -> ~；其余 “~” 用法非法
function unescapeRefSegment(
  segment: string,
  ref: string,
  ctx: ImportCtx,
  where: string,
): string {
  let out = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === '~') {
      const next = segment[i + 1];
      if (next === '0') {
        out += '~';
        i += 1;
      } else if (next === '1') {
        out += '/';
        i += 1;
      } else {
        importFail(ctx, where, `$ref "${ref}" 含非法的 "~" 转义（仅支持 ~0 与 ~1）`);
      }
    } else {
      out += ch;
    }
  }
  return out;
}

// 解析一层 $ref：node 是“只含 $ref 的引用节点”时返回目标与新的位置/引用链，
// 否则返回 null。外部引用、非法指针、目标缺失、循环引用都在此拒绝。
function dereference(
  node: Record<string, unknown>,
  ctx: ImportCtx,
  where: string,
  refChain: readonly string[],
): { target: unknown; where: string; refChain: readonly string[] } | null {
  if (!hasOwnKey(node, '$ref')) {
    return null;
  }
  if (Object.keys(node).length !== 1) {
    importFail(ctx, where, '含 $ref 的引用节点不得包含其他字段（只允许 "$ref"）');
  }
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#')) {
    importFail(
      ctx,
      where,
      `仅支持本文件内 $ref（以 "#" 开头的 JSON Pointer），收到 ${JSON.stringify(ref)}`,
    );
  }
  if (refChain.includes(ref as string)) {
    importFail(ctx, where, `循环 $ref 引用：${[...refChain, ref].join(' -> ')}`);
  }
  const fragment = (ref as string).slice(1);
  let target: unknown = ctx.doc;
  if (fragment !== '') {
    if (!fragment.startsWith('/')) {
      importFail(ctx, where, `$ref "${ref as string}" 不是合法的 JSON Pointer 片段`);
    }
    const segments = fragment
      .slice(1)
      .split('/')
      .map((seg) => unescapeRefSegment(seg, ref as string, ctx, where));
    let traversed = '#';
    for (const segment of segments) {
      traversed = `${traversed}/${escapePointerSegment(segment)}`;
      if (Array.isArray(target)) {
        if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= target.length) {
          importFail(ctx, where, `$ref "${ref as string}" 的目标不存在：${traversed} 超出数组范围`);
        }
        target = target[Number(segment)];
      } else if (isPlainObject(target)) {
        if (!hasOwnKey(target, segment)) {
          importFail(ctx, where, `$ref "${ref as string}" 的目标不存在：${traversed} 缺失`);
        }
        target = target[segment];
      } else {
        importFail(ctx, where, `$ref "${ref as string}" 无法继续解析：${traversed} 不是对象或数组`);
      }
    }
  }
  return { target, where: `${where} -> ${ref as string}`, refChain: [...refChain, ref as string] };
}

// 解析一层或多层 $ref 并做节点级基础校验（必须是对象），返回落定的 schema
// 节点与其（含引用链的）位置。nullable 的取值校验由组合节点（comboList）与
// 基础 schema（buildSimpleNorm）各自完成。
function resolveSchemaNode(
  rawNode: unknown,
  ctx: ImportCtx,
  where: string,
  refChain: readonly string[],
): { n: Record<string, unknown>; nodeWhere: string; chain: readonly string[] } {
  let node = rawNode;
  let nodeWhere = where;
  let chain = refChain;
  // 引用节点可以层层指向另一个引用节点
  for (;;) {
    if (!isPlainObject(node)) {
      importFail(ctx, nodeWhere, 'schema 必须是对象');
    }
    const ref = dereference(node, ctx, nodeWhere, chain);
    if (!ref) {
      break;
    }
    node = ref.target;
    nodeWhere = ref.where;
    chain = ref.refChain;
  }
  return { n: node as Record<string, unknown>, nodeWhere, chain };
}

// 组合节点键校验（仅 allOf 与注释）并取出非空 allOf 数组；
// 组合节点（无 type）的 nullable 仍只允许 false 或省略
function comboList(n: Record<string, unknown>, ctx: ImportCtx, nodeWhere: string): unknown[] {
  for (const key of Object.keys(n)) {
    if (key !== 'allOf' && !OPENAPI_ANNOTATION_KEYS.has(key)) {
      importFail(
        ctx,
        nodeWhere,
        `组合节点仅允许 allOf 及注释（title/description/example/nullable），含未支持的关键字 "${key}"`,
      );
    }
  }
  if (hasOwnKey(n, 'nullable') && n.nullable !== false) {
    importFail(
      ctx,
      `${nodeWhere}.nullable`,
      `组合节点（allOf）仅支持 false（或不声明），收到 ${JSON.stringify(n.nullable)}`,
    );
  }
  const list = n.allOf;
  if (!Array.isArray(list) || list.length === 0) {
    importFail(ctx, `${nodeWhere}.allOf`, '必须是非空数组');
  }
  return list as unknown[];
}

// 递归收集（可能嵌套的）allOf 子树的全部对象叶分支：组合节点只含 allOf 与
// 注释，其子树展开后的叶分支即全部参与交集的分支。交集满足结合律，故展平不
// 改变接受集合，也使成功/拒绝结论与分支顺序、嵌套分组无关。loc 保留每个叶分
// 支的精确位置（含嵌套 allOf 下标与 $ref 链），用于来源定位。
interface ObjectLeaf {
  readonly rule: NormObject;
  readonly loc: string;
}

function collectObjectLeaves(
  list: readonly unknown[],
  ctx: ImportCtx,
  parentWhere: string,
  chain: readonly string[],
): ObjectLeaf[] {
  const leaves: ObjectLeaf[] = [];
  list.forEach((raw, i) => {
    const branchWhere = `${parentWhere}.allOf[${i}]`;
    const { n, nodeWhere, chain: ch } = resolveSchemaNode(raw, ctx, branchWhere, chain);
    if (hasOwnKey(n, 'allOf')) {
      leaves.push(...collectObjectLeaves(comboList(n, ctx, nodeWhere), ctx, nodeWhere, ch));
      return;
    }
    const rule = buildSimpleNorm(n, ctx, nodeWhere, ch);
    if (rule.kind !== 'object') {
      importFail(ctx, nodeWhere, `仅支持纯对象 allOf 组合，该分支最终类型为 ${rule.kind}`);
    }
    leaves.push({ rule: rule as NormObject, loc: nodeWhere });
  });
  return leaves;
}

// schema（或引用链尽头的 schema）-> 规范化规则
function schemaToNorm(
  rawNode: unknown,
  ctx: ImportCtx,
  where: string,
  refChain: readonly string[],
): NormRule {
  const { n, nodeWhere, chain } = resolveSchemaNode(rawNode, ctx, where, refChain);

  if (hasOwnKey(n, 'allOf')) {
    const leaves = collectObjectLeaves(comboList(n, ctx, nodeWhere), ctx, nodeWhere, chain);
    const result = intersectRules(
      leaves.map((l) => ({ rule: l.rule as NormRule, loc: l.loc })),
      nodeWhere,
    );
    // 整体空交集 与 非空但无法表达 都拒绝；reason 含冲突字段/元素与失败理由，
    // loc 指向贡献该结论的叶分支（可定位的操作或定义位置）
    if (result.tag === 'empty' || result.tag === 'inexpressible') {
      importFail(ctx, result.loc, result.reason);
    }
    return result.rule;
  }

  return buildSimpleNorm(n, ctx, nodeWhere, chain);
}

// 非组合（非 allOf）schema -> 规范化规则；nullable:true 在接受集合上加入 null
function buildSimpleNorm(
  n: Record<string, unknown>,
  ctx: ImportCtx,
  nodeWhere: string,
  chain: readonly string[],
): NormRule {
  const type = n.type;
  if (
    typeof type !== 'string' ||
    (type !== 'object' && type !== 'array' && !OPENAPI_SCALAR_TYPES.has(type))
  ) {
    importFail(
      ctx,
      `${nodeWhere}.type`,
      `必须是 "object" | "array" | "string" | "number" | "integer" | "boolean"，收到 ${JSON.stringify(n.type)}`,
    );
  }
  const structural: readonly string[] =
    type === 'object'
      ? ['properties', 'required', 'additionalProperties']
      : type === 'array'
        ? ['items']
        : ['enum']; // enum 仅允许在标量 schema 上；object/array 与组合节点一律拒绝
  for (const key of Object.keys(n)) {
    if (key !== 'type' && !OPENAPI_ANNOTATION_KEYS.has(key) && !structural.includes(key)) {
      importFail(ctx, nodeWhere, `含未支持的关键字 "${key}"`);
    }
  }

  // 基础 schema 可声明布尔 nullable：true 在转换结果的接受集合上加入 null
  let nullable = false;
  if (hasOwnKey(n, 'nullable')) {
    if (typeof n.nullable !== 'boolean') {
      importFail(
        ctx,
        `${nodeWhere}.nullable`,
        `必须是布尔值，收到 ${JSON.stringify(n.nullable)}`,
      );
    }
    nullable = n.nullable as boolean;
  }

  // 基础标量 schema 可声明非空 enum：逐项符合类型与可空约定，语义与场景规则一致
  // （object/array schema 与 allOf 组合节点上的 enum 已在上方按未支持关键字拒绝）
  let enumValues: readonly EnumValue[] | undefined;
  if (hasOwnKey(n, 'enum')) {
    const result = enumValuesOrError(
      n.enum,
      type as ScalarKind,
      nullable,
      `${nodeWhere}.enum`,
    );
    if ('errorWhere' in result) {
      importFail(ctx, result.errorWhere, result.message);
    }
    enumValues = result.values;
  }

  if (type === 'array') {
    if (!hasOwnKey(n, 'items')) {
      importFail(ctx, `${nodeWhere}.items`, '数组 schema 必须声明元素规则 items');
    }
    return { kind: 'array', items: schemaToNorm(n.items, ctx, `${nodeWhere}.items`, chain), nullable };
  }

  if (type === 'object') {
    const propsRaw = n.properties;
    if (propsRaw !== undefined && !isPlainObject(propsRaw)) {
      importFail(ctx, `${nodeWhere}.properties`, '必须是对象（字段名 -> schema）');
    }
    const reqRaw = n.required;
    const requiredList: string[] = [];
    if (reqRaw !== undefined) {
      if (!Array.isArray(reqRaw)) {
        importFail(ctx, `${nodeWhere}.required`, '必须是字符串数组');
      }
      for (let i = 0; i < (reqRaw as unknown[]).length; i += 1) {
        const item = (reqRaw as unknown[])[i];
        if (typeof item !== 'string') {
          importFail(ctx, `${nodeWhere}.required[${i}]`, `必须是字符串，收到 ${JSON.stringify(item)}`);
        }
        if (requiredList.includes(item as string)) {
          importFail(ctx, `${nodeWhere}.required`, `含重复项 ${JSON.stringify(item)}`);
        }
        requiredList.push(item as string);
      }
    }
    const props = new Map<string, NormRule>();
    if (propsRaw !== undefined) {
      for (const [name, sub] of Object.entries(propsRaw as Record<string, unknown>)) {
        props.set(
          name,
          schemaToNorm(sub, ctx, `${nodeWhere}.properties[${JSON.stringify(name)}]`, chain),
        );
      }
    }
    for (const name of requiredList) {
      if (!props.has(name)) {
        importFail(ctx, `${nodeWhere}.required`, `${JSON.stringify(name)} 未在同层 properties 中声明`);
      }
    }
    const addlRaw = n.additionalProperties;
    if (addlRaw !== undefined && typeof addlRaw !== 'boolean') {
      importFail(
        ctx,
        `${nodeWhere}.additionalProperties`,
        `仅支持布尔值，收到 ${JSON.stringify(addlRaw)}`,
      );
    }
    // OpenAPI 缺省允许未声明字段；输出时显式写出
    return { kind: 'object', props, required: new Set(requiredList), addl: addlRaw !== false, nullable };
  }

  return { kind: type as NormScalarKind, nullable, enum: enumValues };
}

// 标量类型交集：相同类型取自身；number ∩ integer 取 integer；其余组合为空。
// 结果与顺序无关。nullable 与枚举不在此合并——交集的 null 接受性由
//  intersectRules 按“全部分支都接受 null”统一判定，枚举由 intersectEnumValues 求交。
function scalarKindIntersection(a: NormScalarKind, b: NormScalarKind): NormScalarKind | null {
  if (a === b) {
    return a;
  }
  if ((a === 'number' && b === 'integer') || (a === 'integer' && b === 'number')) {
    return 'integer';
  }
  return null;
}

// 枚举候选交集（在类型交集 kind 上）：双方都带枚举取共同候选；只有一方带枚举时，
// 该方候选须符合另一方的类型约束（如 number 枚举 [1, 0.5] ∩ integer 取 [1]）。
// 返回 null 表示交集为空（各分支没有共同接受的非 null 值）；
// 返回 undefined 表示双方都没有枚举限制。null 项不在此处理——交集的 null 接受性
// 由 intersectRules 按“全部分支都接受 null”统一判定后再列入候选。
function intersectEnumValues(
  a: readonly EnumValue[] | undefined,
  b: readonly EnumValue[] | undefined,
  kind: NormScalarKind,
): readonly EnumValue[] | undefined | null {
  let values: readonly EnumValue[] | undefined;
  if (a !== undefined && b !== undefined) {
    values = a.filter((v) => b.includes(v) && enumItemConforms(kind, v));
  } else {
    const single = a !== undefined ? a : b;
    if (single !== undefined) {
      values = single.filter((v) => enumItemConforms(kind, v));
    }
  }
  if (values !== undefined && values.length === 0) {
    return null;
  }
  return values;
}

// 参与交集的一个规则分支：rule 是其规范化规则，loc 是该规则在文档中的精确
// 来源位置（对象取 allOf 叶分支位置、字段取 ...properties["名"]、元素取 ...items），
// 用于在拒绝时给出可定位的操作或定义位置。
interface RuleBranch {
  readonly rule: NormRule;
  readonly loc: string;
}

// 多个对象分支（可能来自嵌套 allOf）接受集合的交集。
// 必须对“全部分支同时”判定，结论与分支顺序、嵌套分组无关；不可在两两折叠的
// 中途因某个中间交集不可表达就拒绝——再叠加分支后真实交集可能变为可表达
// （例如 string 与 integer 两支本不可表达，第三支是封闭空对象后，交集恰为
// 只接受空对象的封闭对象）。
function intersectObjects(flat: readonly RuleBranch[], where: string): Intersection {
  const objs = flat.map((b) => b.rule as NormObject);
  // 结果的 additionalProperties 为各分支的合取（任一分支拒绝则拒绝）
  const addl = objs.every((o) => o.addl);

  const names: string[] = [];
  const seen = new Set<string>();
  for (const o of objs) {
    for (const name of o.props.keys()) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }

  const props = new Map<string, NormRule>();
  const required = new Set<string>();
  // 非空但无法表达时的首个原因与位置（可能随后被收窄为空交集）
  let inex: { reason: string; loc: string } | undefined;

  const noteInexpressible = (reason: string, loc: string): void => {
    if (inex === undefined) {
      inex = { reason, loc };
    }
  };

  for (const name of names) {
    const isRequired = objs.some((o) => o.required.has(name));

    // 真正约束该字段取值的声明分支（附精确来源位置）；以及首个禁止它出现的分支
    // （未声明且该分支 additionalProperties 为 false）
    const declarers: RuleBranch[] = [];
    let forbiddener: RuleBranch | undefined;
    for (let i = 0; i < flat.length; i += 1) {
      const o = objs[i];
      const sub = o.props.get(name);
      if (sub !== undefined) {
        declarers.push({ rule: sub, loc: `${flat[i].loc}.properties[${JSON.stringify(name)}]` });
      } else if (!o.addl && forbiddener === undefined) {
        forbiddener = flat[i];
      }
    }

    if (forbiddener !== undefined) {
      if (isRequired) {
        return {
          tag: 'empty',
          reason:
            `字段 ${JSON.stringify(name)} 在部分分支中为必填，但被另一分支禁止出现` +
            '（未声明且 additionalProperties 为 false），交集为空',
          loc: forbiddener.loc,
        };
      }
      // 可选且被禁止：结果中不声明该字段即“禁止出现”。其余声明分支的取值交集
      // 为何都无关紧要——该字段根本不能出现（声明分支中的非法 schema 仍在
      // schemaToNorm 阶段被拒绝，不会走到这里）。
      continue;
    }

    // 没有任何分支声明它：各分支仅以“允许额外字段”放行，交集对它无约束
    if (declarers.length === 0) {
      continue;
    }

    const sub = intersectRules(declarers, `${where}.properties[${JSON.stringify(name)}]`);

    if (sub.tag === 'empty') {
      if (isRequired) {
        return {
          tag: 'empty',
          reason: `必填字段 ${JSON.stringify(name)} 的各分支规则交集为空：${sub.reason}`,
          loc: sub.loc,
        };
      }
      if (!addl) {
        // 可选字段交集为空、结果又拒绝额外字段：不声明即“禁止出现”，可表达
        continue;
      }
      // 所有分支都允许额外字段时，无法表达“仅该字段禁止出现、其他字段任意”
      noteInexpressible(
        `可选字段 ${JSON.stringify(name)} 的各分支规则交集为空（${sub.reason}），` +
          '且所有分支都允许额外字段，现有规则种类无法表达“仅禁止该字段出现”',
        sub.loc,
      );
      continue;
    }

    if (sub.tag === 'inexpressible') {
      // 子级非空但不可表达：本字段可选时外层封闭也许能补救，故带近似规则继续，
      // 先记录原因；必填字段的不可表达在外层封闭也无法补救，最终仍会拒绝。
      noteInexpressible(
        `${isRequired ? '必填' : '可选'}字段 ${JSON.stringify(name)} 的各分支规则交集非空但无法表达：${sub.reason}`,
        sub.loc,
      );
      props.set(name, sub.rule);
      if (isRequired) {
        required.add(name);
      }
      continue;
    }

    props.set(name, sub.rule);
    if (isRequired) {
      required.add(name);
    }
  }

  // 非 null 部分的结构交集；nullable 由外层 intersectRules 统一判定后附着
  const merged: NormObject = { kind: 'object', props, required, addl, nullable: false };
  if (inex !== undefined) {
    return { tag: 'inexpressible', rule: merged, reason: inex.reason, loc: inex.loc };
  }
  return { tag: 'nonempty', rule: merged };
}

// 规则是否接受 null：nullable 为 true，或基类型就是 null（交集“仅剩 null”的产物）；
// 带枚举的标量规则还要求 null 列入候选（可空不越过枚举）
function normAcceptsNull(rule: NormRule): boolean {
  if (rule.kind === 'null') {
    return true;
  }
  if (!rule.nullable) {
    return false;
  }
  if (rule.kind === 'object' || rule.kind === 'array') {
    return true;
  }
  return rule.enum === undefined || rule.enum.includes(null);
}

// 多个规则分支（标量/数组/对象）的交集，三态返回，结论与顺序、分组无关。
// null 部分与非 null 部分分开判定：交集含 null 当且仅当全部分支都接受 null；
// 非 null 部分按结构求交（intersectNonNull）。非 null 部分为空而全部分支都
// 可空时，交集恰为 {null}，用 type:null 精确表达；非空但无法表达时可空不能
// 补救（无法表达的非 null 值仍在交集中），仍按无法表达拒绝。
function intersectRules(flat: readonly RuleBranch[], where: string): Intersection {
  const allNull = flat.every((b) => normAcceptsNull(b.rule));
  const nonNull = intersectNonNull(flat, where);
  if (nonNull.tag === 'nonempty') {
    const rule = nonNull.rule;
    if (rule.kind === 'null') {
      return { tag: 'nonempty', rule };
    }
    if (rule.kind === 'object' || rule.kind === 'array') {
      return { tag: 'nonempty', rule: { ...rule, nullable: allNull } };
    }
    // 标量：交集接受 null 且结果带枚举时，null 必须列入候选（可空不越过枚举）；
    // allNull 保证每个带枚举的分支都含 null 项，故补回 null 不改变接受集合
    const enumValues =
      allNull && rule.enum !== undefined ? [...rule.enum, null] : rule.enum;
    return { tag: 'nonempty', rule: { ...rule, nullable: allNull, enum: enumValues } };
  }
  if (nonNull.tag === 'inexpressible') {
    return nonNull;
  }
  if (allNull) {
    return { tag: 'nonempty', rule: { kind: 'null' } };
  }
  return nonNull;
}

// 各分支非 null 接受集合的交集（可空与否在此不产生影响）
function intersectNonNull(flat: readonly RuleBranch[], where: string): Intersection {
  // 仅接受 null 的分支（交集产物 type:null）不提供任何非 null 值
  const nullBranch = flat.find((b) => b.rule.kind === 'null');
  if (nullBranch !== undefined) {
    return {
      tag: 'empty',
      reason: '存在仅接受 null（type:null）的分支，各分支没有共同接受的非 null 值',
      loc: nullBranch.loc,
    };
  }
  const first = flat[0].rule;
  const isComposite = (k: NormRule['kind']): boolean => k === 'object' || k === 'array';

  // 含对象/数组时，全部分支必须是同一种结构类型；对象/数组与标量、对象与数组
  // 相交都为空。纯标量分支（如 number 与 integer）不在此拒绝，交给下方的
  // 标量交集处理（number ∩ integer 取 integer，并非为空）。
  if (isComposite(first.kind)) {
    for (let i = 1; i < flat.length; i += 1) {
      if (flat[i].rule.kind !== first.kind) {
        return {
          tag: 'empty',
          reason: `类型 ${first.kind} 与 ${flat[i].rule.kind} 没有共同接受的值`,
          loc: flat[i].loc,
        };
      }
    }
    if (first.kind === 'object') {
      return intersectObjects(flat, where);
    }

    // first.kind === 'array'
    // 数组只接受“每个元素都在元素交集内”的序列，空数组总被接受：
    // - 元素交集可表达 -> 非空，items 取交集（空数组也接受）；
    // - 元素交集为空 -> 真实交集仅含空数组，现有规则种类无法表达；
    // - 元素交集非空但不可表达 -> 同样无法在不扩展规则种类的前提下表达。
    const itemBranches: RuleBranch[] = flat.map((b) => ({
      rule: (b.rule as Extract<NormRule, { kind: 'array' }>).items,
      loc: `${b.loc}.items`,
    }));
    const itemRes = intersectRules(itemBranches, `${where}.items`);
    if (itemRes.tag === 'empty') {
      return {
        tag: 'inexpressible',
        rule: { kind: 'array', items: itemBranches[0].rule, nullable: false },
        reason: `数组元素规则交集为空（${itemRes.reason}），交集仅含空数组，现有规则种类无法表达`,
        loc: itemRes.loc,
      };
    }
    if (itemRes.tag === 'inexpressible') {
      return {
        tag: 'inexpressible',
        rule: { kind: 'array', items: itemRes.rule, nullable: false },
        reason: `数组元素规则交集非空但无法表达：${itemRes.reason}`,
        loc: itemRes.loc,
      };
    }
    return { tag: 'nonempty', rule: { kind: 'array', items: itemRes.rule, nullable: false } };
  }

  // 全为标量（若混入对象/数组，首分支为标量而其后出现复合类型，交集为空）
  for (let i = 1; i < flat.length; i += 1) {
    if (isComposite(flat[i].rule.kind)) {
      return {
        tag: 'empty',
        reason: `类型 ${first.kind} 与 ${flat[i].rule.kind} 没有共同接受的值`,
        loc: flat[i].loc,
      };
    }
  }

  // 标量：顺序无关地求类型交集（number ∩ integer 取 integer）与枚举交集；
  // 类型或枚举候选相交为空即整体非 null 交集为空
  let accKind: NormScalarKind = (first as NormScalar).kind;
  let accEnum = (first as NormScalar).enum;
  for (let i = 1; i < flat.length; i += 1) {
    const next = flat[i].rule as NormScalar;
    const kindHit = scalarKindIntersection(accKind, next.kind);
    if (kindHit === null) {
      return {
        tag: 'empty',
        reason: `类型 ${accKind} 与 ${next.kind} 没有共同接受的值`,
        loc: flat[i].loc,
      };
    }
    const enumHit = intersectEnumValues(accEnum, next.enum, kindHit);
    if (enumHit === null) {
      return {
        tag: 'empty',
        reason: '枚举候选的交集为空，各分支没有共同接受的非 null 值',
        loc: flat[i].loc,
      };
    }
    accKind = kindHit;
    accEnum = enumHit;
  }
  return { tag: 'nonempty', rule: { kind: accKind, nullable: false, enum: accEnum } };
}

// 规范化规则 -> 场景规则 JSON（object 显式写出 fields 与 additionalProperties；
// nullable 为 true 时显式写出；交集“仅剩 null”输出 type:null。
// 字段名可能是 ""/"__proto__"/含斜杠波浪号，一律用无原型对象按自有字段构造）
function normToRuleJson(rule: NormRule): Record<string, unknown> {
  switch (rule.kind) {
    case 'null':
      return { type: 'null' };
    case 'object': {
      const fields: Record<string, unknown> = Object.create(null);
      for (const [name, sub] of rule.props) {
        const subJson = normToRuleJson(sub);
        fields[name] = rule.required.has(name) ? { ...subJson, required: true } : subJson;
      }
      const out: Record<string, unknown> = {
        type: 'object',
        fields,
        additionalProperties: rule.addl,
      };
      if (rule.nullable) {
        out.nullable = true;
      }
      return out;
    }
    case 'array': {
      const out: Record<string, unknown> = { type: 'array', items: normToRuleJson(rule.items) };
      if (rule.nullable) {
        out.nullable = true;
      }
      return out;
    }
    default: {
      const out: Record<string, unknown> = { type: rule.kind };
      if (rule.nullable) {
        out.nullable = true;
      }
      if (rule.enum !== undefined) {
        out.enum = [...rule.enum];
      }
      return out;
    }
  }
}

// 转换一个操作的 requestBody；操作未声明 requestBody 时返回 undefined
// （POST 移除接口旧规则；GET 本就不允许携带规则）。
function importOperationBodyRule(
  operation: Record<string, unknown>,
  method: HttpMethod,
  ctx: ImportCtx,
  opWhere: string,
): unknown {
  if (!hasOwnKey(operation, 'requestBody')) {
    return undefined;
  }
  const rbWhere = `${opWhere}.requestBody`;
  if (method === 'GET') {
    importFail(ctx, rbWhere, 'GET 操作不允许声明请求正文');
  }
  // requestBody 本身也可以是本文件内 $ref（可层层引用）
  let node: unknown = operation.requestBody;
  let nodeWhere = rbWhere;
  let chain: readonly string[] = [];
  for (;;) {
    if (!isPlainObject(node)) {
      importFail(ctx, nodeWhere, '必须是对象');
    }
    const ref = dereference(node, ctx, nodeWhere, chain);
    if (!ref) {
      break;
    }
    node = ref.target;
    nodeWhere = ref.where;
    chain = ref.refChain;
  }
  const rb = node as Record<string, unknown>;
  for (const key of Object.keys(rb)) {
    if (key !== 'required' && key !== 'content' && key !== 'description') {
      importFail(ctx, nodeWhere, `含未支持的字段 "${key}"`);
    }
  }
  if (rb.required !== true) {
    importFail(
      ctx,
      `${nodeWhere}.required`,
      `导入的请求正文约定一律按必填处理，required 必须为 true，收到 ${JSON.stringify(rb.required)}`,
    );
  }
  const content = rb.content;
  if (!isPlainObject(content)) {
    importFail(ctx, `${nodeWhere}.content`, '必须是对象且仅含 "application/json" 一种媒体类型');
  }
  const mediaTypes = Object.keys(content as Record<string, unknown>);
  if (mediaTypes.length !== 1 || mediaTypes[0] !== 'application/json') {
    importFail(
      ctx,
      `${nodeWhere}.content`,
      `仅允许且必须包含 "application/json" 一种媒体类型，收到 ${JSON.stringify(mediaTypes)}`,
    );
  }
  const media = (content as Record<string, unknown>)['application/json'];
  const mediaWhere = `${nodeWhere}.content["application/json"]`;
  if (!isPlainObject(media)) {
    importFail(ctx, mediaWhere, '必须是对象');
  }
  for (const key of Object.keys(media as Record<string, unknown>)) {
    if (key !== 'schema' && key !== 'example' && key !== 'examples') {
      importFail(ctx, mediaWhere, `含未支持的字段 "${key}"`);
    }
  }
  if (!hasOwnKey(media as Record<string, unknown>, 'schema')) {
    importFail(ctx, mediaWhere, '缺少 schema');
  }
  const norm = schemaToNorm(
    (media as Record<string, unknown>).schema,
    ctx,
    `${mediaWhere}.schema`,
    [],
  );
  return normToRuleJson(norm);
}

// 为场景每个接口选择文档操作并转换；任一失败抛 ImportError，不产生部分输出。
// 未被选中的操作与不可达定义不参与转换。
function importEndpoints(sceneRaw: unknown, ctx: ImportCtx): unknown[] {
  const doc = ctx.doc;
  if (!isPlainObject(doc)) {
    importFail(ctx, '', '顶层必须是 JSON 对象');
  }
  const version = (doc as Record<string, unknown>).openapi;
  if (typeof version !== 'string' || !/^3\.0\.\d+/.test(version)) {
    importFail(ctx, 'openapi', `仅支持 OpenAPI 3.0.x，收到 ${JSON.stringify(version)}`);
  }
  const paths = (doc as Record<string, unknown>).paths;
  if (!isPlainObject(paths)) {
    importFail(ctx, 'paths', '必须是对象（路径 -> 路径项）');
  }
  const endpoints = (sceneRaw as { endpoints: unknown[] }).endpoints;
  return endpoints.map((epRaw, index) => {
    const ep = epRaw as {
      method: HttpMethod;
      path: string;
      responses: unknown;
      requestBody?: unknown;
      branches?: unknown;
    };
    const label = `场景接口 endpoints[${index}]（${ep.method} ${ep.path}）`;
    if (!hasOwnKey(paths, ep.path)) {
      importFail(ctx, 'paths', `${label} 缺少对应操作：路径 ${JSON.stringify(ep.path)} 不存在`);
    }
    const pathItem = (paths as Record<string, unknown>)[ep.path];
    const pathWhere = `paths[${JSON.stringify(ep.path)}]`;
    if (!isPlainObject(pathItem)) {
      importFail(ctx, pathWhere, '必须是对象');
    }
    const methodKey = ep.method.toLowerCase();
    if (!hasOwnKey(pathItem, methodKey)) {
      importFail(ctx, pathWhere, `${label} 缺少对应操作：${methodKey} 操作不存在`);
    }
    const operation = (pathItem as Record<string, unknown>)[methodKey];
    const opWhere = `${pathWhere}.${methodKey}`;
    if (!isPlainObject(operation)) {
      importFail(ctx, opWhere, '必须是对象');
    }
    const rule = importOperationBodyRule(operation, ep.method, ctx, opWhere);

    // 分支前提失效：场景接口声明了 branches（场景已通过严格校验，必同时带
    // requestBody），但导入操作不提供请求正文约定（POST 未声明 requestBody
    // 会移除规则）。按正文值选分支以正文规则为前提，故整份拒绝。
    const hasBranches = ep.branches !== undefined;
    if (hasBranches && rule === undefined) {
      throw new ImportError(
        `场景配置文件中 ${label} 声明了 branches 响应分支，但 OpenAPI 文件 ${ctx.file} 的 ` +
          `${opWhere} 未声明 requestBody：导入会移除正文规则，使分支选择前提失效，整份拒绝`,
      );
    }

    // 仅替换 requestBody：保留接口顺序、branches（分支、顺序与响应原样）与 responses
    const out: {
      method: string;
      path: string;
      requestBody?: unknown;
      branches?: unknown;
      responses: unknown;
    } = {
      method: ep.method,
      path: ep.path,
      responses: ep.responses,
    };
    if (rule !== undefined) {
      out.requestBody = rule;
    }
    if (hasBranches) {
      out.branches = ep.branches;
    }
    return out;
  });
}

async function readImportInput(file: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new ImportError(`${label} ${file} 读取失败：${describeError(e)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ImportError(`${label} ${file} 不是合法 JSON：${describeError(e)}`);
  }
}

async function runImport(openapiArg: string, configArg: string): Promise<never> {
  const openapiFile = path.resolve(openapiArg);
  const configFile = path.resolve(configArg);
  try {
    const sceneRaw = await readImportInput(configFile, '场景配置文件');
    try {
      validateConfig(sceneRaw);
    } catch (e) {
      throw new ImportError(`场景配置文件 ${configFile} 校验失败：${describeError(e)}`);
    }
    const doc = await readImportInput(openapiFile, 'OpenAPI 文件');
    const endpoints = importEndpoints(sceneRaw, { doc, file: openapiFile });
    // 全部输入与所选可达定义有效后才输出
    process.stdout.write(`${JSON.stringify({ endpoints }, null, 2)}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`${APP_NAME}: import：${describeError(e)}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 离线批量请求校验（verify 子命令）
// ---------------------------------------------------------------------------
//
// 读取 GET /__contractlab/requests 的完整 JSON 快照与一份场景配置，按输入顺序
// 保留原编号逐条重新判定：仅依据记录中的原始请求（方法、target、原始请求头、
// 无损正文）与所给场景重新计算，不信任记录里的配置版本、匹配/校验结论、计划
// 响应与发送状态；待发送、已发送、中断记录同样处理。不监听端口、不发送请求、
// 不修改文件，也不预留响应、不推进序列、不等待延迟。
//
// 判定规则与在线一致：方法 + target 去掉查询串后的字面路径匹配（非 GET/POST
// 一律未匹配）；仅对配置了 requestBody 的接口依次检查媒体类型、UTF-8、JSON
// 与结构，其余记录不解析正文。Content-Type 名称不分大小写，重复头取在线顺序
// 第一项；媒体类型忽略大小写并允许参数。命中接口且通过适用检查即为接受
// （场景响应的状态码——包括 500——与请求是否被接受无关）。
//
// 快照必须能无损重建每个请求：字段缺失或类型错误、count 与记录数不符、编号
// 重复、头数组不成对、target 与 path 不符、未知编码、base64 非法或还原长度与
// bodyBytes 不符，都属于输入失败（整份拒绝，不猜补缺失字节）。两份输入全部
// 读取、解析、校验通过后才输出报告。

class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

function snapshotFail(where: string, message: string): never {
  throw new SnapshotError(where === '' ? message : `${where} ${message}`);
}

// 从快照无损重建出来、供重新判定/重放的一条请求
interface SnapshotRequest {
  readonly id: number;
  readonly method: string;
  // 含查询串的原始请求目标（重放时原样发送；verify 不使用）
  readonly target: string;
  // target 去掉查询串后的字面路径（已核对与记录 path 一致）
  readonly path: string;
  // 按在线顺序成对保留的原始请求头（重放时过滤后发送；verify 仅用于取 Content-Type）
  readonly rawHeaders: readonly string[];
  // 在线顺序第一项 Content-Type 头值（名称不分大小写）；没有则为 undefined
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

// utf-8 文本必须能无损编码往返：孤立代理项（lone surrogate）按 UTF-8 编码时
// 会被替换为 U+FFFD，即使替换后的字节数恰好与 bodyBytes 吻合也不再是原始字节，
// 必须拒绝（verify 与 replay 共用此校验）。
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true; // 高代理项后未跟低代理项
      }
      i += 1; // 跳过完整代理对
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // 孤立的低代理项
    }
  }
  return false;
}

// 严格 base64：完整四字符组 + 可选末尾填充；空串合法（还原为 0 字节）
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseSnapshotRecord(raw: unknown, index: number, seen: Set<number>): SnapshotRequest {
  const where = `records[${index}]`;
  if (!isPlainObject(raw)) {
    snapshotFail(where, '必须是对象');
  }
  const { id, request } = raw;
  if (!Number.isInteger(id) || (id as number) < 1) {
    snapshotFail(`${where}.id`, `必须是正整数，收到 ${JSON.stringify(id)}`);
  }
  if (seen.has(id as number)) {
    snapshotFail(`${where}.id`, `与其他记录重复：${id as number}`);
  }
  seen.add(id as number);

  const reqWhere = `${where}.request`;
  if (!isPlainObject(request)) {
    snapshotFail(reqWhere, '必须是对象');
  }
  const { method, target, path: recordPath, rawHeaders, bodyBytes, body } = request;
  if (typeof method !== 'string') {
    snapshotFail(`${reqWhere}.method`, '必须是字符串');
  }
  if (typeof target !== 'string') {
    snapshotFail(`${reqWhere}.target`, '必须是字符串');
  }
  if (typeof recordPath !== 'string') {
    snapshotFail(`${reqWhere}.path`, '必须是字符串');
  }
  // 匹配所用路径由 target 去掉查询串重新推导；与记录 path 不符说明快照不可靠
  const derived = (target as string).split('?')[0];
  if (derived !== recordPath) {
    snapshotFail(
      `${reqWhere}.path`,
      `与 target 去掉查询串后的路径不符：path=${JSON.stringify(recordPath)}，target=${JSON.stringify(target)}`,
    );
  }
  if (!Array.isArray(rawHeaders)) {
    snapshotFail(`${reqWhere}.rawHeaders`, '必须是按在线顺序成对排列的字符串数组');
  }
  if (rawHeaders.length % 2 !== 0) {
    snapshotFail(
      `${reqWhere}.rawHeaders`,
      `必须成对（名称、值交替），当前长度为 ${rawHeaders.length}`,
    );
  }
  for (let j = 0; j < rawHeaders.length; j += 1) {
    if (typeof rawHeaders[j] !== 'string') {
      snapshotFail(`${reqWhere}.rawHeaders[${j}]`, '必须是字符串');
    }
  }
  // 重复头取在线顺序第一项（与 Node 在线解析 content-type 的行为一致）
  let contentType: string | undefined;
  for (let j = 0; j + 1 < rawHeaders.length; j += 2) {
    if ((rawHeaders[j] as string).toLowerCase() === 'content-type') {
      contentType = rawHeaders[j + 1] as string;
      break;
    }
  }

  if (!Number.isInteger(bodyBytes) || (bodyBytes as number) < 0) {
    snapshotFail(`${reqWhere}.bodyBytes`, `必须是非负整数，收到 ${JSON.stringify(bodyBytes)}`);
  }

  const bodyWhere = `${reqWhere}.body`;
  if (!isPlainObject(body)) {
    snapshotFail(bodyWhere, '必须是对象（含 encoding 与 content）');
  }
  const { encoding, content } = body;
  if (encoding !== 'utf-8' && encoding !== 'base64') {
    snapshotFail(
      `${bodyWhere}.encoding`,
      `必须是 "utf-8" 或 "base64"，收到 ${JSON.stringify(encoding)}`,
    );
  }
  if (typeof content !== 'string') {
    snapshotFail(`${bodyWhere}.content`, '必须是字符串');
  }
  let bytes: Buffer;
  if (encoding === 'utf-8') {
    if (hasLoneSurrogate(content as string)) {
      snapshotFail(
        `${bodyWhere}.content`,
        '含孤立代理项（lone surrogate）：按 UTF-8 重新编码会被替换字符改写，无法无损还原原始字节',
      );
    }
    bytes = Buffer.from(content as string, 'utf8');
  } else {
    if (!BASE64_RE.test(content as string)) {
      snapshotFail(`${bodyWhere}.content`, '不是合法的 base64 编码');
    }
    bytes = Buffer.from(content as string, 'base64');
  }
  if (bytes.byteLength !== (bodyBytes as number)) {
    snapshotFail(
      bodyWhere,
      `按 ${encoding as string} 还原为 ${bytes.byteLength} 字节，与 bodyBytes=${bodyBytes as number} 不符：快照已丢失字节，无法无损重建`,
    );
  }

  return {
    id: id as number,
    method: method as string,
    target: target as string,
    path: recordPath as string,
    rawHeaders: rawHeaders as string[],
    contentType,
    body: bytes,
  };
}

// 快照顶层结构校验（count 与 records 数量一致）；记录逐条校验由调用方继续
function snapshotRecordsOf(raw: unknown): unknown[] {
  if (!isPlainObject(raw)) {
    snapshotFail('', '快照顶层必须是 JSON 对象（含 count 与 records）');
  }
  const { count, records } = raw;
  if (!Array.isArray(records)) {
    snapshotFail('records', '必须是数组');
  }
  if (!Number.isInteger(count) || (count as number) < 0) {
    snapshotFail('count', `必须是非负整数，收到 ${JSON.stringify(count)}`);
  }
  if ((count as number) !== records.length) {
    snapshotFail('count', `与 records 数量不符：count=${count as number}，实际 ${records.length} 条`);
  }
  return records;
}

// 仅校验“重建请求所需”的字段；记录中的版本、匹配/校验结论、计划响应、
// 发送状态等字段不被信任，也不参与判定，故不要求其存在。
function parseSnapshot(raw: unknown): SnapshotRequest[] {
  const seen = new Set<number>();
  return snapshotRecordsOf(raw).map((rec, i) => parseSnapshotRecord(rec, i, seen));
}

// 读取 -> 解析 -> 校验并重建；任何一步失败都抛出含文件路径与可定位原因的错误
async function loadSnapshotFromFile(snapshotPath: string): Promise<SnapshotRequest[]> {
  let text: string;
  try {
    text = await readFile(snapshotPath, 'utf8');
  } catch (e) {
    throw new Error(`读取请求记录快照文件 ${snapshotPath} 失败：${describeError(e)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`请求记录快照文件 ${snapshotPath} 不是合法 JSON：${describeError(e)}`);
  }

  try {
    return parseSnapshot(raw);
  } catch (e) {
    throw new Error(`请求记录快照文件 ${snapshotPath} 校验失败：${describeError(e)}`);
  }
}

// 逐条判定结论：
//   unmatched      —— 未匹配（无此“方法 + 字面路径”接口，或方法非 GET/POST）
//   no_body_check  —— 命中接口，但该接口未配置正文规则（不解析正文）
//   passed         —— 命中接口且通过正文校验
//   rejected       —— 命中接口但正文被拒绝（附解析/结构差异报告）
type VerifyOutcome = 'unmatched' | 'no_body_check' | 'passed' | 'rejected';

interface VerifyResultEntry {
  readonly id: number;
  readonly outcome: VerifyOutcome;
  readonly endpoint: string | null;
  readonly rejection?: BodyReport;
}

interface VerifyReport {
  readonly requestsFile: string;
  readonly configFile: string;
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly results: readonly VerifyResultEntry[];
}

function verifyRequests(
  requests: readonly SnapshotRequest[],
  specs: readonly EndpointSpec[],
  requestsFile: string,
  configFile: string,
): VerifyReport {
  const byKey = new Map<string, EndpointSpec>();
  for (const spec of specs) {
    byKey.set(`${spec.method} ${spec.path}`, spec);
  }
  const results = requests.map((req): VerifyResultEntry => {
    const endpoint =
      req.method === 'GET' || req.method === 'POST'
        ? byKey.get(`${req.method} ${req.path}`)
        : undefined;
    if (!endpoint) {
      return { id: req.id, outcome: 'unmatched', endpoint: null };
    }
    const key = `${endpoint.method} ${endpoint.path}`;
    if (endpoint.bodyRule) {
      const rejection = validateBodyWithContentType(req.contentType, req.body, endpoint.bodyRule);
      if (rejection) {
        return { id: req.id, outcome: 'rejected', endpoint: key, rejection };
      }
      return { id: req.id, outcome: 'passed', endpoint: key };
    }
    return { id: req.id, outcome: 'no_body_check', endpoint: key };
  });
  const accepted = results.filter(
    (r) => r.outcome === 'passed' || r.outcome === 'no_body_check',
  ).length;
  return {
    requestsFile,
    configFile,
    total: results.length,
    accepted,
    rejected: results.length - accepted,
    results,
  };
}

async function runVerify(requestsArg: string, configArg: string): Promise<never> {
  const requestsFile = path.resolve(requestsArg);
  const configFile = path.resolve(configArg);

  const attemptSnapshot = async (): Promise<{ requests?: SnapshotRequest[]; error?: string }> => {
    try {
      return { requests: await loadSnapshotFromFile(requestsFile) };
    } catch (e) {
      return { error: describeError(e) };
    }
  };
  const attemptSpecs = async (): Promise<{ specs?: EndpointSpec[]; error?: string }> => {
    try {
      return { specs: await loadSpecsFromFile(configFile) };
    } catch (e) {
      return { error: describeError(e) };
    }
  };

  // 两份输入都完整经历 读取 -> 解析 -> 严格校验；任一失败则不输出任何报告
  const [snapResult, specResult] = await Promise.all([attemptSnapshot(), attemptSpecs()]);
  let failed = false;
  if (snapResult.error !== undefined) {
    process.stderr.write(`${APP_NAME}: verify 请求快照：${snapResult.error}\n`);
    failed = true;
  }
  if (specResult.error !== undefined) {
    process.stderr.write(`${APP_NAME}: verify 场景配置：${specResult.error}\n`);
    failed = true;
  }
  if (failed) {
    process.exit(2);
  }

  const report = verifyRequests(
    snapResult.requests as SnapshotRequest[],
    specResult.specs as EndpointSpec[],
    requestsFile,
    configFile,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.rejected === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 本机请求重放与响应差异报告（replay 子命令）
// ---------------------------------------------------------------------------
//
// 读取 GET /__contractlab/requests 的完整 JSON 快照，按输入顺序保留原编号，
// 把每条记录的原始请求逐条重放到 127.0.0.1 的指定端口：前一条结束才发下一条，
// 每次执行每条只尝试一次，不跟随重定向。仅比较实际响应的状态码与正文和记录
// 中的计划响应（计划正文按 UTF-8 编码）；可选 --strategy 比较策略按
// “方法 + 字面路径”为接口选择正文 JSON 语义比较（见下），未选中的接口仍按
// 正文原始字节比较。不比较响应头，也不依据记录版本与发送状态判定——
// pending / sent / interrupted 均可重放，400/404/500 同样按内容比较。
// 不监听端口、不修改文件；已发送的请求可能已被目标处理，不重载、清空或
// 回滚目标状态。
//
// 仅重放 GET/POST；target 须为以 "/" 开头的合法 HTTP 请求目标，原样发送
// （保留查询串与百分号编码，不归一化路径）；禁止重放 /__contractlab 本身及
// /__contractlab/ 前缀路径。每条记录另须有 200–599 的计划响应状态与文本正文。
// 参数与全部记录（含可发送的头名称和值）有效后才连接；参数或快照失败退出 2，
// stderr 给原因，stdout 为空且不发任何请求。
//
// 每条请求的总超时自开始连接覆盖完整收发，持续来数据也不延长；连接失败、
// 超时或响应中途断开记通信失败，关闭连接后继续下一条（部分响应不算完整）。

// 重放时剥离的头（小写）：原 Host / Expect / HTTP 逐跳与分帧头；
// Connection 头指名的头名也一并剥离。Host 与 Content-Length 按目标和实际
// 字节数重建。
const REPLAY_STRIP_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'expect',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

// 一条待重放的请求：共享快照校验之上再经重放专用校验
interface ReplayRequest {
  readonly id: number;
  readonly method: 'GET' | 'POST';
  // 原样发送的请求目标（含查询串与百分号编码，不归一化）
  readonly target: string;
  // target 去掉查询串后的字面路径（比较策略按“方法 + 路径”选择接口）
  readonly path: string;
  // 过滤后的业务头：名称大小写、重复项与在线顺序原样保留
  readonly headers: readonly [string, string][];
  readonly body: Buffer;
  readonly plannedStatus: number;
  readonly plannedBody: string;
}

// target 须为以 "/" 开头的合法 HTTP 请求目标：不含空白与控制字符，
// 且每个字符都在 Latin-1 内（与 Node 客户端对 path 的接受范围一致）
function validateReplayTarget(target: string, where: string): void {
  if (target.length === 0 || !target.startsWith('/')) {
    snapshotFail(where, `必须是以 "/" 开头的 HTTP 请求目标，收到 ${JSON.stringify(target)}`);
  }
  for (const ch of target) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) {
      snapshotFail(where, `含空白或控制字符，不是合法的 HTTP 请求目标：${JSON.stringify(target)}`);
    }
    if (code > 0xff) {
      snapshotFail(where, `含 Latin-1 之外的字符，无法作为 HTTP 请求目标发送：${JSON.stringify(target)}`);
    }
  }
}

// 过滤并校验待发送的业务头：剥离 Host/Expect/逐跳/分帧头（含 Connection
// 指名的头），其余按原顺序、大小写与重复项保留；保留的头名称与值必须可发送。
function filterReplayHeaders(
  rawHeaders: readonly string[],
  where: string,
): [string, string][] {
  const connectionNamed = new Set<string>();
  for (let j = 0; j + 1 < rawHeaders.length; j += 2) {
    if ((rawHeaders[j] as string).toLowerCase() === 'connection') {
      for (const token of (rawHeaders[j + 1] as string).split(',')) {
        const name = token.trim().toLowerCase();
        if (name !== '') {
          connectionNamed.add(name);
        }
      }
    }
  }
  const out: [string, string][] = [];
  for (let j = 0; j + 1 < rawHeaders.length; j += 2) {
    const name = rawHeaders[j] as string;
    const value = rawHeaders[j + 1] as string;
    const lower = name.toLowerCase();
    if (REPLAY_STRIP_HEADERS.has(lower) || connectionNamed.has(lower)) {
      continue;
    }
    if (!HEADER_NAME_RE.test(name)) {
      snapshotFail(`${where}[${j}]`, `不是可发送的 HTTP 头名称：${JSON.stringify(name)}`);
    }
    for (let k = 0; k < value.length; k += 1) {
      const code = value.charCodeAt(k);
      // 与响应头同一规则：允许水平制表符；拒绝换行及其余控制字符；仅 Latin-1
      if ((code <= 0x1f && code !== 0x09) || code === 0x7f || code > 0xff) {
        snapshotFail(
          `${where}[${j + 1}]`,
          `头 ${JSON.stringify(name)} 的值不得包含换行或其他控制字符，且只能使用 Latin-1 字符`,
        );
      }
    }
    out.push([name, value]);
  }
  return out;
}

function parseReplayRecord(raw: unknown, index: number, seen: Set<number>): ReplayRequest {
  const where = `records[${index}]`;
  // 先完整经历与 verify 相同的快照校验（含 target/path 一致性与正文无损性）
  const base = parseSnapshotRecord(raw, index, seen);

  if (base.method !== 'GET' && base.method !== 'POST') {
    snapshotFail(
      `${where}.request.method`,
      `仅支持重放 GET/POST，收到 ${JSON.stringify(base.method)}`,
    );
  }
  validateReplayTarget(base.target, `${where}.request.target`);
  if (base.path === ADMIN_BASE || base.path.startsWith(ADMIN_PREFIX)) {
    snapshotFail(
      `${where}.request.target`,
      `指向管理入口（${ADMIN_BASE} 本身及 ${ADMIN_PREFIX} 前缀），禁止重放`,
    );
  }

  // 每条记录另须有 200–599 的计划响应状态与文本正文（比较基准）
  const prWhere = `${where}.plannedResponse`;
  const planned = (raw as Record<string, unknown>).plannedResponse;
  if (!isPlainObject(planned)) {
    snapshotFail(prWhere, '必须是对象（重放需要计划响应状态与文本正文）');
  }
  const { status, body } = planned;
  if (!Number.isInteger(status) || (status as number) < 200 || (status as number) > 599) {
    snapshotFail(
      `${prWhere}.status`,
      `必须是 200 至 599 之间的整数，收到 ${JSON.stringify(status)}`,
    );
  }
  if (typeof body !== 'string') {
    snapshotFail(`${prWhere}.body`, '必须是文本字符串');
  }
  if (hasLoneSurrogate(body as string)) {
    snapshotFail(
      `${prWhere}.body`,
      '含孤立代理项（lone surrogate）：按 UTF-8 编码会被替换字符改写，无法作为无损的比较基准',
    );
  }

  return {
    id: base.id,
    method: base.method,
    target: base.target,
    path: base.path,
    headers: filterReplayHeaders(base.rawHeaders, `${where}.request.rawHeaders`),
    body: base.body,
    plannedStatus: status as number,
    plannedBody: body as string,
  };
}

function parseReplaySnapshot(raw: unknown): ReplayRequest[] {
  const seen = new Set<number>();
  return snapshotRecordsOf(raw).map((rec, i) => parseReplayRecord(rec, i, seen));
}

// 读取 -> 解析 -> 校验并重建；任何一步失败都抛出含文件路径与可定位原因的错误
async function loadReplaySnapshotFromFile(snapshotPath: string): Promise<ReplayRequest[]> {
  let text: string;
  try {
    text = await readFile(snapshotPath, 'utf8');
  } catch (e) {
    throw new Error(`读取请求记录快照文件 ${snapshotPath} 失败：${describeError(e)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`请求记录快照文件 ${snapshotPath} 不是合法 JSON：${describeError(e)}`);
  }

  try {
    return parseReplaySnapshot(raw);
  } catch (e) {
    throw new Error(`请求记录快照文件 ${snapshotPath} 校验失败：${describeError(e)}`);
  }
}

// ---------------------------------------------------------------------------
// 响应正文 JSON 语义比较（replay --strategy，可选）
// ---------------------------------------------------------------------------
//
// 比较策略文件按“方法（GET/POST）+ 去掉查询串后的字面路径”为接口选择 JSON
// 语义比较；未选中的接口仍按正文原始字节比较。每个接口可附 RFC 6901 忽略
// 指针数组：指针处的值、存在性与子树不参与比较（不删除数组项、不移动下标；
// 两侧都无目标时无影响；祖先类型不同仍照常报告）。重复或父子重叠的
// 忽略项不改变结果。
//
// 策略、整份快照与所选记录的计划正文全部校验通过后才连接：所选计划正文须为
// UTF-8 JSON（仅可剥离单个开头 BOM，空正文非法），忽略规则不豁免解析；
// 失败退出 2、stderr 定位文件与字段、stdout 为空且不发任何请求。
//
// JSON 语义（不依赖媒体类型）：对象只看自有字段，忽略键顺序与排版；数组按
// 原下标比较（顺序有意义，多出或缺失的元素在其下标报告，不另报长度）；
// 标量不转换类型，数字按解析数值比较（0 与 -0 等价），缺失与 null 不同。
// 状态码始终精确比较，不比较响应头。

// 一个数组对齐位置：RFC 6901 指针（定位到数组，根为 ""）+ 元素自有键字段名。
// 各位置互不嵌套（相等视为重复）。
interface KeyedArraySpec {
  // 规范化后的指针文本（根为 ""）
  readonly pointer: string;
  // 指针段（用于在 JSON 值上遍历）
  readonly segments: readonly string[];
  // 元素自有的业务键字段名（允许空名与 "__proto__"）
  readonly key: string;
}

// 一个接口的 JSON 语义比较策略
interface JsonCompareEndpoint {
  // 规范化后的忽略指针集合（RFC 6901，根为 ""）；重复与父子重叠不影响结果
  readonly ignore: ReadonlySet<string>;
  // 业务键对齐数组位置：规范化指针文本 -> 规格（各位置互不嵌套）
  readonly keyedArrays: ReadonlyMap<string, KeyedArraySpec>;
}

// 比较策略：键为 "METHOD /literal/path"（路径不含查询串）
type JsonCompareStrategy = ReadonlyMap<string, JsonCompareEndpoint>;

// segments 的 strictPrefix 长度前缀是否完全相等（相等也算）：
// 用于拒绝重复位置与互相嵌套（含祖先/后代）的对齐位置。
function segmentsSameOrPrefix(prefix: readonly string[], segments: readonly string[]): boolean {
  if (prefix.length > segments.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== segments[i]) {
      return false;
    }
  }
  return true;
}

// 由解析出的指针段构造规范化指针文本（根为 ""），用于忽略集合的去重与查找
function canonicalPointer(segments: readonly string[]): string {
  return segments.length === 0 ? '' : `/${segments.map(escapePointerSegment).join('/')}`;
}

function parseStrategyEndpoint(
  raw: unknown,
  index: number,
  seen: Set<string>,
  endpoints: Map<string, JsonCompareEndpoint>,
): void {
  const where = `endpoints[${index}]`;
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} 必须是对象`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'method' && key !== 'path' && key !== 'ignore' && key !== 'keyedArrays') {
      throw new ConfigError(`${where} 含未知字段 "${key}"`);
    }
  }
  const { method, path: routePath, ignore, keyedArrays } = raw;
  if (method !== 'GET' && method !== 'POST') {
    throw new ConfigError(
      `${where}.method 必须是 "GET" 或 "POST"，收到 ${JSON.stringify(method)}`,
    );
  }
  if (typeof routePath !== 'string') {
    throw new ConfigError(`${where}.path 必须是字符串`);
  }
  validatePath(routePath, where);

  const ignoreSet = new Set<string>();
  if (ignore !== undefined) {
    if (!Array.isArray(ignore)) {
      throw new ConfigError(`${where}.ignore 必须是 RFC 6901 指针字符串数组`);
    }
    ignore.forEach((rawPointer, j) => {
      // 支持根（""）、空字段名（"/"）、__proto__ 与 ~0/~1 转义；
      // 重复或父子重叠的忽略项不改变结果（集合语义）
      const segments = parseJsonPointer(rawPointer, `${where}.ignore[${j}]`, '忽略指针');
      ignoreSet.add(canonicalPointer(segments));
    });
  }

  // 业务键对齐数组位置：每项 { pointer, key }；位置须为 RFC 6901 指针，
  // key 为元素自有的字段名（允许空名与 "__proto__"）。重复位置或位置互相
  // 嵌套（含祖先/后代）整份拒绝。
  const keyedMap = new Map<string, KeyedArraySpec>();
  if (keyedArrays !== undefined) {
    if (!Array.isArray(keyedArrays)) {
      throw new ConfigError(`${where}.keyedArrays 必须是数组（每项含 pointer 与 key）`);
    }
    const accepted: { readonly pointer: string; readonly segments: readonly string[] }[] = [];
    keyedArrays.forEach((item, j) => {
      const itemWhere = `${where}.keyedArrays[${j}]`;
      if (!isPlainObject(item)) {
        throw new ConfigError(`${itemWhere} 必须是对象（含 pointer 与 key 两个字符串字段）`);
      }
      for (const f of Object.keys(item)) {
        if (f !== 'pointer' && f !== 'key') {
          throw new ConfigError(`${itemWhere} 含未知字段 "${f}"`);
        }
      }
      const { pointer: rawPointer, key: keyName } = item;
      // pointer 与 key 都必须是字符串（key 允许空字符串）
      const segments = parseJsonPointer(rawPointer, itemWhere, '对齐数组位置');
      if (typeof keyName !== 'string') {
        throw new ConfigError(
          `${itemWhere}.key 必须是元素自有的字段名字符串（允许空名），收到 ${JSON.stringify(keyName)}`,
        );
      }
      const pointerText = canonicalPointer(segments);
      for (const prev of accepted) {
        if (segmentsSameOrPrefix(prev.segments, segments) || segmentsSameOrPrefix(segments, prev.segments)) {
          throw new ConfigError(
            `${itemWhere} 的对齐位置 ${JSON.stringify(pointerText)} 与位置 ${JSON.stringify(prev.pointer)} 重复或互相嵌套：对齐数组位置必须互不嵌套`,
          );
        }
      }
      accepted.push({ pointer: pointerText, segments });
      keyedMap.set(pointerText, { pointer: pointerText, segments, key: keyName });
    });
  }

  const key = `${method as string} ${routePath}`;
  if (seen.has(key)) {
    throw new ConfigError(`${where} 与其他接口重复（方法 + 路径必须唯一）：${key}`);
  }
  seen.add(key);
  endpoints.set(key, { ignore: ignoreSet, keyedArrays: keyedMap });
}

function parseCompareStrategy(raw: unknown): JsonCompareStrategy {
  if (!isPlainObject(raw)) {
    throw new ConfigError('比较策略顶层必须是 JSON 对象（含 endpoints）');
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'endpoints') {
      throw new ConfigError(`比较策略顶层含未知字段 "${key}"`);
    }
  }
  const { endpoints } = raw;
  if (!Array.isArray(endpoints)) {
    throw new ConfigError('endpoints 必须是数组');
  }
  const map = new Map<string, JsonCompareEndpoint>();
  const seen = new Set<string>();
  endpoints.forEach((ep, i) => parseStrategyEndpoint(ep, i, seen, map));
  return map;
}

// 读取 -> 解析 -> 校验；任何一步失败都抛出含文件路径与可定位原因的错误
async function loadStrategyFromFile(strategyPath: string): Promise<JsonCompareStrategy> {
  let text: string;
  try {
    text = await readFile(strategyPath, 'utf8');
  } catch (e) {
    throw new Error(`读取比较策略文件 ${strategyPath} 失败：${describeError(e)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`比较策略文件 ${strategyPath} 不是合法 JSON：${describeError(e)}`);
  }

  try {
    return parseCompareStrategy(raw);
  } catch (e) {
    throw new Error(`比较策略文件 ${strategyPath} 校验失败：${describeError(e)}`);
  }
}

// 解析 JSON 语义比较的一侧正文文本：仅可剥离单个开头 BOM；空正文非法。
// 忽略规则不豁免解析——两侧都必须先通过本解析。
function parseSemanticJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string } {
  const stripped = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (stripped === '') {
    return { ok: false, reason: '是空正文，不是合法 JSON' };
  }
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (e) {
    return { ok: false, reason: `不是合法 JSON：${describeError(e)}` };
  }
}

// 严格 UTF-8 解码（保留开头 BOM 字符，交由 parseSemanticJson 统一处理）
function decodeUtf8Strict(body: Buffer): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body) };
  } catch {
    return { ok: false, reason: '不是合法 UTF-8' };
  }
}

// 正文差异中“该侧不存在此节点”的标记（缺失与 null 不同，也与字符串 "missing" 配套
// 存在性布尔标记一并使用，不得混淆）
const MISSING_NODE = 'missing';

interface BodyDifference {
  // RFC 6901 位置（根为 ""）。单侧元素差异时取“存在侧”在原始正文中的位置；
  // 配对元素内部差异取实际元素所在的位置
  readonly pointer: string;
  // 计划值 / 实际值（JSON 原值）；该侧不存在时为 "missing"
  readonly planned: unknown;
  readonly actual: unknown;
  // 仅业务键对齐数组中“只在一侧出现”的整元素差异携带：业务键（字段名 + 值）
  readonly key?: { readonly field: string; readonly value: string | number | boolean };
  // 双方各自是否独立存在该元素（缺失与 null / "missing" 字符串不得混淆）
  readonly plannedExists?: boolean;
  readonly actualExists?: boolean;
}

// 实际侧某个对齐数组非法（不是数组 / 元素非对象 / 键缺失或类型非法 / 键重复）
interface ActualAlignmentError {
  // 对齐数组在实际正文中的 RFC 6901 位置（根为 ""）
  readonly pointer: string;
  readonly reason: string;
}

// 忽略指针的成员判定：普通场景直接用 Set；配对元素场景用“计划下标 -> 实际下标”
// 的映射判定（见 remapIgnoreForPair）。
interface PointerMembership {
  has(pointer: string): boolean;
}

// 已通过连接前校验、计划正文里确实存在的对齐数组
interface PlannedKeyedArray {
  readonly spec: KeyedArraySpec;
}

// 业务键值的内部配对标识：严格按类型配对，加类型前缀避免任何跨类型碰撞；
// 数字按数值序列化（0 与 -0 都序列化为 "0"）。
function businessKeyToken(value: unknown): string {
  if (typeof value === 'string') {
    return `s:${value}`;
  }
  if (typeof value === 'number') {
    return `n:${String(value)}`;
  }
  if (typeof value === 'boolean') {
    return `b:${value}`;
  }
  throw new Error(`内部错误：不是合法业务键类型 ${jsonTypeOf(value)}`);
}

// 校验一个数组元素可作业务键载体：必须是对象，且含自有的键字段，值为字符串、
// 有限数字或布尔。null、对象、数组、缺失或 NaN/Infinity 均非法。
// 返回 null 表示合法；否则返回不含位置前缀的原因（调用方补下标/位置）。
function elementKeyError(element: unknown, keyField: string): string | null {
  if (!isPlainObject(element)) {
    return `元素不是 JSON 对象（实际是 ${jsonTypeOf(element)}），无法按自有字段 ${JSON.stringify(keyField)} 取业务键`;
  }
  if (!Object.prototype.hasOwnProperty.call(element, keyField)) {
    return `元素缺少业务键字段 ${JSON.stringify(keyField)}`;
  }
  const value = (element as Record<string, unknown>)[keyField];
  if (value === null) {
    return `业务键字段 ${JSON.stringify(keyField)} 的值是 null，null 不能作业务键`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return `业务键字段 ${JSON.stringify(keyField)} 的值不是有限数字`;
    }
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return null;
  }
  return `业务键字段 ${JSON.stringify(keyField)} 的值类型是 ${jsonTypeOf(value)}，必须是字符串、有限数字或布尔`;
}

// 在计划正文上校验全部对齐数组位置（连接前）：位置不存在允许；存在时必须是数组，
// 元素必须是对象，键字段存在且为字符串/有限数字/布尔，同数组内唯一。
// 忽略指针不豁免本校验。返回存在的对齐位置映射；失败给出指针与原因。
function validatePlannedKeyedArrays(
  planned: unknown,
  keyedArrays: ReadonlyMap<string, KeyedArraySpec>,
):
  | { readonly ok: true; readonly arrays: ReadonlyMap<string, PlannedKeyedArray> }
  | { readonly ok: false; readonly pointer: string; readonly reason: string } {
  const arrays = new Map<string, PlannedKeyedArray>();
  for (const spec of keyedArrays.values()) {
    const node = resolvePointer(planned, spec.segments);
    if (node === undefined) {
      continue; // 位置不存在（含无法遍历）允许
    }
    if (!Array.isArray(node)) {
      return {
        ok: false,
        pointer: spec.pointer,
        reason: `对齐位置必须是数组，计划正文此处是 ${jsonTypeOf(node)}`,
      };
    }
    const seen = new Set<string>();
    for (let i = 0; i < node.length; i += 1) {
      const err = elementKeyError(node[i], spec.key);
      if (err !== null) {
        return { ok: false, pointer: spec.pointer, reason: `下标 ${i}：${err}` };
      }
      const keyValue = (node[i] as Record<string, unknown>)[spec.key] as string | number | boolean;
      const token = businessKeyToken(keyValue);
      if (seen.has(token)) {
        return {
          ok: false,
          pointer: spec.pointer,
          reason: `下标 ${i}：业务键 ${JSON.stringify(keyValue)} 在同一数组内不唯一`,
        };
      }
      seen.add(token);
    }
    arrays.set(spec.pointer, { spec });
  }
  return { ok: true, arrays };
}

// 在实际正文上独立校验计划侧存在的对齐位置（不受 ignore 影响）：实际位置缺失或
// 无法遍历不在此报错（按普通节点差异处理）；存在但不是数组、元素或键非法、键
// 重复则记录位置与原因。每个对齐数组至多记录一条（首个非法元素）。
function validateActualKeyedArrays(
  actual: unknown,
  plannedKeyed: ReadonlyMap<string, PlannedKeyedArray>,
): ActualAlignmentError[] {
  const errors: ActualAlignmentError[] = [];
  for (const [pointerText, ka] of plannedKeyed) {
    const node = resolvePointer(actual, ka.spec.segments);
    if (node === undefined) {
      continue; // 实际侧缺失/无法遍历：交由普通节点差异处理
    }
    if (!Array.isArray(node)) {
      errors.push({
        pointer: pointerText,
        reason: `实际响应对齐位置不是数组（实际是 ${jsonTypeOf(node)}）`,
      });
      continue;
    }
    const seen = new Map<string, number>();
    for (let j = 0; j < node.length; j += 1) {
      const err = elementKeyError(node[j], ka.spec.key);
      if (err !== null) {
        errors.push({ pointer: pointerText, reason: `下标 ${j}：${err}` });
        break;
      }
      const keyValue = (node[j] as Record<string, unknown>)[ka.spec.key] as
        | string
        | number
        | boolean;
      const token = businessKeyToken(keyValue);
      const prev = seen.get(token);
      if (prev !== undefined) {
        errors.push({
          pointer: pointerText,
          reason: `下标 ${j}：业务键 ${JSON.stringify(keyValue)} 与下标 ${prev} 重复，同一数组内必须唯一`,
        });
        break;
      }
      seen.set(token, j);
    }
  }
  return errors;
}

// 路径本身或任一祖先被忽略（对齐数组里按“计划下标”定位的忽略项用它判定）
function pathIgnored(ignore: PointerMembership, segments: readonly string[]): boolean {
  for (let len = 0; len <= segments.length; len += 1) {
    if (ignore.has(canonicalPointer(segments.slice(0, len)))) {
      return true;
    }
  }
  return false;
}

// 为一对同键配对元素构造忽略判定：对齐数组内的忽略指针以**计划原下标**定位，
// 比较实际元素时映射到该配对元素的实际下标；整数组/祖先的忽略仍直接生效。
//
// 关键：进入配对元素后路径以“实际下标”书写，而忽略集合里的 /list/1 指的是
// **计划**下标 1；不能仅凭文本命中（否则实际下标 1 的另一元素会被误忽略）。
// 因此对配对元素自身及其子路径，一律先映射回计划下标再逐级判定；数组本身及
// 其祖先、数组之外的路径按原忽略集合判定（整数组/祖先生效时本就不会递归到此）。
function remapIgnoreForPair(
  ignore: PointerMembership,
  arrayPointer: string,
  plannedIndex: number,
  actualIndex: number,
): PointerMembership {
  const plannedPrefix = arrayPointer === '' ? `/${plannedIndex}` : `${arrayPointer}/${plannedIndex}`;
  const actualPrefix = arrayPointer === '' ? `/${actualIndex}` : `${arrayPointer}/${actualIndex}`;
  return {
    has(pointer: string): boolean {
      if (pointer === actualPrefix || pointer.startsWith(`${actualPrefix}/`)) {
        // 映射回计划元素路径，逐级（元素自身 -> 各子孙）检查忽略
        const tail = pointer.slice(actualPrefix.length); // "" 或 "/..."
        let plannedPath = plannedPrefix;
        if (ignore.has(plannedPath)) {
          return true;
        }
        if (tail !== '') {
          // 规范指针中 "/" 只作分隔符（字段名内的 / 已转义为 ~1），可安全切分
          for (const seg of tail.slice(1).split('/')) {
            plannedPath += `/${seg}`;
            if (ignore.has(plannedPath)) {
              return true;
            }
          }
        }
        return false;
      }
      // 对齐数组本身、其祖先或数组之外：按原忽略集合判定
      return ignore.has(pointer);
    },
  };
}

interface DiffContext {
  readonly ignore: PointerMembership;
  // 计划侧存在且已校验的对齐数组（规范化指针文本 -> 规格）
  readonly keyed: ReadonlyMap<string, PlannedKeyedArray>;
  // 实际侧校验失败的对齐位置集合
  readonly actualInvalid: ReadonlySet<string>;
}

// 递归列出全部未忽略的独立正文差异：节点缺失或类型不同只报该节点，不再深入。
// 对齐数组位置按键配对（见 diffAlignedArray）；其余数组按下标。
function diffJsonValues(
  planned: unknown,
  actual: unknown,
  ctx: DiffContext,
  path: readonly string[],
  out: BodyDifference[],
): void {
  const here = canonicalPointer(path);
  if (ctx.ignore.has(here)) {
    return; // 忽略指针处的值、存在性与子树
  }
  if (ctx.keyed.has(here)) {
    // 计划侧此位置一定是数组（连接前已校验）。实际侧通常经由父级对象/数组的
    // “字段/下标缺失”分支直接报节点差异而不会递归到这里；若确实以缺失进入，
    // 按原节点差异处理（数组本身缺失）。
    if (actual === undefined) {
      out.push({ pointer: here, planned, actual: MISSING_NODE });
      return;
    }
    // 实际侧存在但不是数组，或元素/键非法、键重复：仅由 bodyAlignmentErrors
    // 给出位置与原因，这里不再重复整节点差异，也不配对深入；正文其余位置照常
    // 比较。
    if (!Array.isArray(actual) || ctx.actualInvalid.has(here)) {
      return;
    }
    diffAlignedArray(ctx.keyed.get(here) as PlannedKeyedArray, planned as unknown[], actual, ctx, path, out);
    return;
  }
  const plannedType = jsonTypeOf(planned);
  const actualType = jsonTypeOf(actual);
  if (plannedType !== actualType) {
    out.push({ pointer: here, planned, actual });
    return;
  }
  if (plannedType === 'object') {
    // 只看自有字段，忽略键顺序（含空字段名与 __proto__）
    const p = planned as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    for (const key of Object.keys(p)) {
      const childPath = [...path, key];
      if (Object.prototype.hasOwnProperty.call(a, key)) {
        diffJsonValues(p[key], a[key], ctx, childPath, out);
      } else if (!ctx.ignore.has(canonicalPointer(childPath))) {
        out.push({ pointer: canonicalPointer(childPath), planned: p[key], actual: MISSING_NODE });
      }
    }
    for (const key of Object.keys(a)) {
      if (!Object.prototype.hasOwnProperty.call(p, key)) {
        const childPath = [...path, key];
        if (!ctx.ignore.has(canonicalPointer(childPath))) {
          out.push({ pointer: canonicalPointer(childPath), planned: MISSING_NODE, actual: a[key] });
        }
      }
    }
    return;
  }
  if (plannedType === 'array') {
    // 非对齐数组按原下标比较：顺序有意义；多出或缺失的元素在其下标报告，不另报
    // 长度；被忽略的下标不参与比较，但不删除数组项、不移动其余下标
    const p = planned as unknown[];
    const a = actual as unknown[];
    const n = Math.max(p.length, a.length);
    for (let i = 0; i < n; i += 1) {
      const childPath = [...path, String(i)];
      if (ctx.ignore.has(canonicalPointer(childPath))) {
        continue;
      }
      if (i >= p.length) {
        out.push({ pointer: canonicalPointer(childPath), planned: MISSING_NODE, actual: a[i] });
      } else if (i >= a.length) {
        out.push({ pointer: canonicalPointer(childPath), planned: p[i], actual: MISSING_NODE });
      } else {
        diffJsonValues(p[i], a[i], ctx, childPath, out);
      }
    }
    return;
  }
  // 标量不转换类型；数字按解析数值比较（0 与 -0 等价）
  if (planned !== actual) {
    out.push({ pointer: here, planned, actual });
  }
}

// 业务键对齐数组的比较：两侧元素（均已校验为含唯一合法键的对象）按键配对，
// 顺序不影响结论。同键元素递归比较全部未忽略差异；只在一侧出现的键报告整个
// 元素（不深入），携带业务键、存在侧原始位置与双方独立存在性标记。
function diffAlignedArray(
  ka: PlannedKeyedArray,
  plannedArr: readonly unknown[],
  actualArr: readonly unknown[],
  ctx: DiffContext,
  path: readonly string[],
  out: BodyDifference[],
): void {
  const here = canonicalPointer(path);
  const { key: keyField } = ka.spec;

  // 业务键 -> 各自下标（两侧键均唯一）
  const planByKey = new Map<string, number>();
  plannedArr.forEach((element, i) => {
    planByKey.set(businessKeyToken((element as Record<string, unknown>)[keyField]), i);
  });
  const actualByKey = new Map<string, number>();
  actualArr.forEach((element, j) => {
    actualByKey.set(businessKeyToken((element as Record<string, unknown>)[keyField]), j);
  });

  // 先按计划下标顺序：配对元素递归；计划独有的整元素报告（可被其计划下标处的
  // 忽略项或祖先忽略抑制）
  plannedArr.forEach((plannedElement, i) => {
    const keyValue = (plannedElement as Record<string, unknown>)[keyField] as
      | string
      | number
      | boolean;
    const token = businessKeyToken(keyValue);
    const j = actualByKey.get(token);
    if (j === undefined) {
      // 仅计划侧存在：位置取存在侧（计划）原始下标
      const plannedPath = [...path, String(i)];
      if (pathIgnored(ctx.ignore, plannedPath)) {
        return; // 忽略项作用于缺失元素
      }
      out.push({
        pointer: canonicalPointer(plannedPath),
        planned: plannedElement,
        actual: MISSING_NODE,
        key: { field: keyField, value: keyValue },
        plannedExists: true,
        actualExists: false,
      });
      return;
    }
    // 同键配对：忽略以计划原下标定位，再映射到配对元素的实际下标；
    // 不改变配对身份（键完整性与唯一性已在比较前独立校验）。
    const pairIgnore = remapIgnoreForPair(ctx.ignore, here, i, j);
    const pairCtx: DiffContext = { ...ctx, ignore: pairIgnore };
    diffJsonValues(plannedElement, actualArr[j], pairCtx, [...path, String(j)], out);
  });

  // 实际独有的键（新增键）：位置取存在侧（实际）原始下标。其他下标的忽略项
  // 不得遮蔽新增键；整数组/祖先若被忽略，根本不会进入本函数。
  actualArr.forEach((actualElement, j) => {
    const keyValue = (actualElement as Record<string, unknown>)[keyField] as
      | string
      | number
      | boolean;
    if (!planByKey.has(businessKeyToken(keyValue))) {
      out.push({
        pointer: canonicalPointer([...path, String(j)]),
        planned: MISSING_NODE,
        actual: actualElement,
        key: { field: keyField, value: keyValue },
        plannedExists: false,
        actualExists: true,
      });
    }
  });
}

interface ReplayResponse {
  readonly status: number;
  readonly body: Buffer;
}

type ReplayExchange =
  | { readonly ok: true; readonly response: ReplayResponse }
  | { readonly ok: false; readonly reason: string };

// 重放单条请求：独立连接、只尝试一次、不跟随重定向；总超时自开始连接覆盖
// 完整收发，不因持续来数据而延长。通信失败时关闭连接并返回原因。
function replayOne(port: number, request: ReplayRequest, timeoutMs: number): Promise<ReplayExchange> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome: ReplayExchange): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      }
    };

    // 业务头在前（原顺序/大小写/重复项），随后按目标与实际字节数重建
    // Host 与 Content-Length；每条请求独立连接，响应结束后关闭。
    const headers: string[] = [];
    for (const [name, value] of request.headers) {
      headers.push(name, value);
    }
    headers.push('Host', `127.0.0.1:${port}`);
    headers.push('Content-Length', String(request.body.byteLength));
    headers.push('Connection', 'close');

    const req = http.request({
      host: '127.0.0.1',
      port,
      method: request.method,
      path: request.target, // 原样发送：保留查询串与百分号编码，不归一化
      headers,
      agent: false, // 不连接池化：一次一条，每条只尝试一次
    });

    // 总超时：覆盖连接建立与完整收发，持续来数据不延长
    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, reason: `超过总超时 ${timeoutMs}ms（自开始连接覆盖完整收发）` });
    }, timeoutMs);

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        done({
          ok: true,
          response: { status: res.statusCode ?? 0, body: Buffer.concat(chunks) },
        });
      });
      res.on('aborted', () => {
        done({ ok: false, reason: '响应中途断开（部分响应不算完整）' });
      });
      res.on('error', (e: unknown) => {
        done({ ok: false, reason: `响应读取失败：${describeError(e)}` });
      });
      res.on('close', () => {
        if (!res.complete) {
          done({ ok: false, reason: '响应中途断开（部分响应不算完整）' });
        }
      });
    });
    req.on('error', (e: Error) => {
      done({ ok: false, reason: `通信失败：${e.message}` });
    });
    req.end(request.body);
  });
}

// 完整响应的无损 JSON 表示（与请求记录正文同一套编码规则）
function replayResponseJson(response: ReplayResponse): {
  status: number;
  body: { encoding: 'utf-8' | 'base64'; content: string };
} {
  return { status: response.status, body: encodeBodyLosslessly(response.body) };
}

type ReplayResultEntry =
  | {
      readonly id: number;
      readonly outcome: 'same';
      readonly response: ReturnType<typeof replayResponseJson>;
    }
  | {
      readonly id: number;
      readonly outcome: 'different';
      // 差异点：状态码不同 / 正文不同（可同时为真；JSON 模式下正文按语义比较）
      readonly differences: { readonly status: boolean; readonly body: boolean };
      // 仅 JSON 语义比较模式：两侧均可解析时列出全部未忽略的独立正文差异
      readonly bodyDifferences?: readonly BodyDifference[];
      // 仅 JSON 语义比较模式：实际响应正文非 UTF-8 或非 JSON 时的原因
      readonly bodyError?: string;
      // 仅业务键对齐模式：实际响应中类型/元素/键非法的对齐数组（位置 + 原因）
      readonly bodyAlignmentErrors?: readonly ActualAlignmentError[];
      readonly planned: ReturnType<typeof replayResponseJson>;
      readonly response: ReturnType<typeof replayResponseJson>;
    }
  | { readonly id: number; readonly outcome: 'failed'; readonly reason: string };

interface ReplayReport {
  readonly requestsFile: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly total: number;
  readonly same: number;
  readonly different: number;
  readonly failed: number;
  readonly results: readonly ReplayResultEntry[];
}

async function runReplay(
  requestsArg: string,
  port: number,
  timeoutMs: number,
  strategyArg?: string,
): Promise<never> {
  const requestsFile = path.resolve(requestsArg);

  // 比较策略（可选）：先读取并严格校验；失败退出 2，不发任何请求
  let strategy: JsonCompareStrategy | undefined;
  if (strategyArg !== undefined) {
    const strategyFile = path.resolve(strategyArg);
    try {
      strategy = await loadStrategyFromFile(strategyFile);
    } catch (e) {
      process.stderr.write(`${APP_NAME}: replay 比较策略：${describeError(e)}\n`);
      process.exit(2);
    }
  }

  // 参数与全部记录有效后才连接：任何快照错误都不发任何请求
  let requests: ReplayRequest[];
  try {
    requests = await loadReplaySnapshotFromFile(requestsFile);
  } catch (e) {
    process.stderr.write(`${APP_NAME}: replay 请求快照：${describeError(e)}\n`);
    process.exit(2);
  }

  // 策略选中的记录：计划正文须为 UTF-8 JSON（仅可剥离单个开头 BOM，空正文
  // 非法），忽略规则不豁免解析；配置了业务键对齐数组时，计划正文里存在的对齐
  // 位置还须满足数组/元素对象/键类型与唯一性约束（忽略不豁免）。全部与策略、
  // 快照一起校验通过后才连接。
  const jsonPlans: (
    | {
        readonly ignore: ReadonlySet<string>;
        readonly keyed: ReadonlyMap<string, PlannedKeyedArray>;
        readonly planned: unknown;
      }
    | null
  )[] = requests.map((request, i) => {
    const endpoint = strategy?.get(`${request.method} ${request.path}`);
    if (endpoint === undefined) {
      return null;
    }
    const parsed = parseSemanticJson(request.plannedBody);
    if (!parsed.ok) {
      process.stderr.write(
        `${APP_NAME}: replay 请求快照：请求记录快照文件 ${requestsFile} 校验失败：` +
          `records[${i}].plannedResponse.body ${parsed.reason}` +
          `（策略为 ${request.method} ${request.path} 选择 JSON 语义比较）\n`,
      );
      process.exit(2);
    }
    // 连接前校验计划正文的对齐数组：位置不存在允许；存在即须合法且键唯一。
    // 定位到记录与正文位置（RFC 6901 指针）。
    const plannedKeyed = validatePlannedKeyedArrays(parsed.value, endpoint.keyedArrays);
    if (!plannedKeyed.ok) {
      process.stderr.write(
        `${APP_NAME}: replay 请求快照：请求记录快照文件 ${requestsFile} 校验失败：` +
          `records[${i}].plannedResponse.body 位置 ${JSON.stringify(plannedKeyed.pointer)} 的业务键对齐数组非法：` +
          `${plannedKeyed.reason}（策略为 ${request.method} ${request.path} 选择 JSON 语义比较）\n`,
      );
      process.exit(2);
    }
    return { ignore: endpoint.ignore, keyed: plannedKeyed.arrays, planned: parsed.value };
  });

  // 按输入顺序保留原编号逐条重放：前一条结束才发下一条
  const results: ReplayResultEntry[] = [];
  for (const [index, request] of requests.entries()) {
    const exchange = await replayOne(port, request, timeoutMs);
    if (!exchange.ok) {
      results.push({ id: request.id, outcome: 'failed', reason: exchange.reason });
      continue;
    }
    const { response } = exchange;
    // 状态码始终精确比较；不比较响应头
    const statusDiff = response.status !== request.plannedStatus;
    const plan = jsonPlans[index];
    if (plan == null) {
      // 字节比较：仅比较状态码与正文原始字节；计划正文按 UTF-8 编码
      const bodyDiff = !response.body.equals(Buffer.from(request.plannedBody, 'utf8'));
      if (!statusDiff && !bodyDiff) {
        results.push({ id: request.id, outcome: 'same', response: replayResponseJson(response) });
      } else {
        results.push({
          id: request.id,
          outcome: 'different',
          differences: { status: statusDiff, body: bodyDiff },
          planned: {
            status: request.plannedStatus,
            body: { encoding: 'utf-8', content: request.plannedBody },
          },
          response: replayResponseJson(response),
        });
      }
      continue;
    }

    // JSON 语义比较：不依赖媒体类型；实际完整响应非 UTF-8 或非 JSON 记正文
    // 差异（说明原因）并继续后续记录。业务键对齐数组在实际侧的类型/元素/键非法
    // 同样记正文差异（bodyAlignmentErrors 给出位置与原因）并继续，不算通信失败。
    let bodyDiff: boolean;
    let bodyDifferences: BodyDifference[] | undefined;
    let bodyError: string | undefined;
    let bodyAlignmentErrors: ActualAlignmentError[] | undefined;
    const decoded = decodeUtf8Strict(response.body);
    const actual = decoded.ok ? parseSemanticJson(decoded.text) : decoded;
    if (!actual.ok) {
      bodyDiff = true;
      bodyError = `实际响应正文${actual.reason}，无法进行 JSON 语义比较`;
    } else {
      // 实际侧独立校验对齐数组：忽略整数组/祖先时不校验（忽略仍生效）；
      // 数组内按下标的忽略项不豁免整组的元素/键校验。
      const effectiveKeyed = new Map<string, PlannedKeyedArray>();
      for (const [pointerText, ka] of plan.keyed) {
        if (!pathIgnored(plan.ignore, ka.spec.segments)) {
          effectiveKeyed.set(pointerText, ka);
        }
      }
      const alignmentErrors = validateActualKeyedArrays(actual.value, effectiveKeyed);
      const invalidActual = new Set(alignmentErrors.map((e) => e.pointer));
      const diffs: BodyDifference[] = [];
      diffJsonValues(
        plan.planned,
        actual.value,
        { ignore: plan.ignore, keyed: effectiveKeyed, actualInvalid: invalidActual },
        [],
        diffs,
      );
      bodyDiff = diffs.length > 0 || alignmentErrors.length > 0;
      if (diffs.length > 0) {
        bodyDifferences = diffs;
      }
      if (alignmentErrors.length > 0) {
        bodyAlignmentErrors = alignmentErrors;
      }
    }
    if (!statusDiff && !bodyDiff) {
      results.push({ id: request.id, outcome: 'same', response: replayResponseJson(response) });
    } else {
      results.push({
        id: request.id,
        outcome: 'different',
        differences: { status: statusDiff, body: bodyDiff },
        // 差异项保留计划与实际正文的无损表示
        ...(bodyDifferences === undefined ? {} : { bodyDifferences }),
        ...(bodyError === undefined ? {} : { bodyError }),
        ...(bodyAlignmentErrors === undefined ? {} : { bodyAlignmentErrors }),
        planned: {
          status: request.plannedStatus,
          body: { encoding: 'utf-8', content: request.plannedBody },
        },
        response: replayResponseJson(response),
      });
    }
  }

  const same = results.filter((r) => r.outcome === 'same').length;
  const different = results.filter((r) => r.outcome === 'different').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  const report: ReplayReport = {
    requestsFile,
    port,
    timeoutMs,
    total: results.length,
    same,
    different,
    failed,
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // 空快照或全部相同退出 0；存在差异或通信失败退出 1
  process.exit(different === 0 && failed === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 离线响应分支可达性诊断（reach 子命令）
// ---------------------------------------------------------------------------
//
// 读取一份通过与 serve 完全相同严格校验的场景配置与一个 POST 接口的字面路径，
// 离线诊断该接口 branches 中每一分支及兜底 responses 是否可达：
//   reachable      —— 存在通过正文检查的请求正文，且该正文首先命中此支；
//   covered        —— 存在满足此支条件的合格正文，但它们全部首先命中前序分支
//                      （遮挡按前序分支的命中并集判定，不是单支包含，也不抽样）；
//   contradictory  —— 条件与正文规则矛盾，不存在满足条件的合格正文。
// 不监听、不发送请求、不修改任何文件。可达分支/兜底各给一份完整请求样例
// （方法、路径、必要头、原始 JSON 正文，补全全部必填字段），样例须通过正文
// 检查并实际选中所报分支或兜底。
//
// 诊断范围（超出即整份拒绝，退出 2）：
// - 接口必须是 POST、声明了非空 branches；
// - 根 requestBody 必须是 object（可附 nullable）；
// - 每个 when 指针必须是**单段** RFC 6901 指针，指向根对象**已声明的标量字段**
//   （根指针 ""、多段指针、未声明字段、object/array 字段均拒绝）；其余字段仍
//   完全按现有递归规则参与“合格正文”的构造与判定。空字段名、__proto__、
//   ~0/~1 转义按原语义处理。
//
// 判定精确依据现有 type/enum/nullable/必填可选/额外字段语义：缺失与 null 分开、
// 0 与 -0 等价、不转换类型；根可空时 JSON null 也参与兜底可达性判断。

class ReachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReachError';
  }
}

type BranchReachStatus = 'reachable' | 'covered' | 'contradictory';

interface ReachExample {
  readonly method: 'POST';
  readonly path: string;
  readonly headers: { readonly 'Content-Type': 'application/json' };
  readonly body: string;
}

interface ReachReason {
  readonly pointer: string;
  readonly message: string;
}

interface BranchReach {
  readonly id: string;
  readonly status: BranchReachStatus;
  readonly example?: ReachExample;
  // covered：共同遮挡此支的前序分支标识（不必最小）
  readonly coveredBy?: readonly string[];
  readonly message?: string;
  // contradictory：定位到具体条件指针的矛盾原因（可多条）
  readonly reasons?: readonly ReachReason[];
}

interface FallbackReach {
  readonly status: 'reachable' | 'covered';
  readonly example?: ReachExample;
  readonly coveredBy?: readonly string[];
  readonly message?: string;
}

interface ReachReport {
  readonly configFile: string;
  readonly method: 'POST';
  readonly path: string;
  readonly branches: readonly BranchReach[];
  readonly fallback: FallbackReach;
  readonly unreachableBranches: number;
}

// 找不到见证正文的哨兵：不能用 null——根可空时 JSON null 本身就是合法见证
const NO_WITNESS: unique symbol = Symbol('reach-no-witness');
type Witness = unknown | typeof NO_WITNESS;

// 标量条件的非 null 值是否满足字段标量规则的“类型”部分（不做类型转换）
function scalarTypeConforms(
  rule: Extract<BodyRule, { kind: ScalarKind }>,
  value: string | number | boolean,
): boolean {
  switch (rule.kind) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'null':
      return false;
  }
}

// 条件值与标量字段规则的矛盾原因；无矛盾返回 null。
// 严格按现有语义：类型不符只报类型；类型相符但不在枚举报枚举；
// null 仅当规则接受 null（nullable 且枚举含 null，或 type:"null"）才可行。
function scalarConditionConflict(
  rule: Extract<BodyRule, { kind: ScalarKind }>,
  value: BranchConditionValue,
): { kind: 'type' | 'enum' | 'null' } | null {
  if (value === null) {
    return ruleAcceptsNullValue(rule) ? null : { kind: 'null' };
  }
  if (!scalarTypeConforms(rule, value)) {
    return { kind: 'type' };
  }
  if (rule.enum !== undefined && !rule.enum.includes(value as EnumValue)) {
    return { kind: 'enum' };
  }
  return null;
}

// 字段某一取值维度上的代表值。等值条件只能区分“指针处是否严格等于某常量”，
// 故只需：各分支引用过的合格常量、null（若规则接受），以及一个与所有被引用
// 常量都不同的合格“其余值”（枚举取未被引用的候选；无枚举时构造）。
// 任意两个未被引用的合格值对全部条件不可区分，因此该有限域精确，不是抽样。
function freshScalarValue(
  rule: Extract<BodyRule, { kind: ScalarKind }>,
  referenced: ReadonlySet<unknown>,
): unknown {
  if (rule.enum !== undefined) {
    return rule.enum.find((candidate) => candidate !== null && !referenced.has(candidate));
  }
  if (rule.kind === 'boolean') {
    return !referenced.has(false) ? false : !referenced.has(true) ? true : undefined;
  }
  if (rule.kind === 'null') {
    return undefined;
  }
  if (rule.kind === 'string') {
    for (let i = 0; ; i += 1) {
      const candidate = i === 0 ? 'contractlab' : `contractlab_${i}`;
      if (!referenced.has(candidate)) {
        return candidate;
      }
    }
  }
  // number / integer：取未被引用的最小非负整数（integer 合法；number 也合法）
  for (let i = 0; ; i += 1) {
    if (!referenced.has(i)) {
      return i;
    }
  }
}

interface ReachDim {
  readonly name: string;
  // 该字段“存在”时的代表值（必非空：标量规则总有至少一个接受值）
  readonly values: readonly unknown[];
  // 规则未标必填时字段还可以缺失；缺失与显式 null 是不同的维度取值
  readonly optional: boolean;
}

// 单支的条件分析：与字段规则一致时给出 字段名 -> 条件常量 的固定取值
// （一支的全部条件都是“某标量字段等于某常量”）；矛盾时给出定位原因。
interface BranchAnalysis {
  readonly ok: boolean;
  readonly pins?: ReadonlyMap<string, BranchConditionValue>;
  readonly reasons?: readonly ReachReason[];
}

function analyzeBranchConditions(
  branch: BranchSpec,
  rootFields: ReadonlyMap<string, FieldRule>,
): BranchAnalysis {
  const pins = new Map<string, BranchConditionValue>();
  const grouped = new Map<string, BranchConditionValue[]>();
  for (const condition of branch.conditions) {
    const name = condition.segments[0];
    const list = grouped.get(name);
    if (list === undefined) {
      grouped.set(name, [condition.value]);
    } else {
      list.push(condition.value);
    }
  }

  const reasons: ReachReason[] = [];
  for (const [name, values] of grouped) {
    const pointer = `/${escapePointerSegment(name)}`;
    // 范围预检已保证字段存在且为标量规则
    const scalarRule = (rootFields.get(name) as FieldRule).rule as Extract<BodyRule, { kind: ScalarKind }>;

    // 同一指针上的多个常量必须两两严格相等（0 与 -0 视为相等）；
    // null 与任何非 null 值互不相容。
    const distinct: BranchConditionValue[] = [];
    for (const v of values) {
      if (!distinct.some((d) => d === v)) {
        distinct.push(v);
      }
    }
    if (distinct.length > 1) {
      reasons.push({
        pointer,
        message: `同一指针上的等值条件值 ${JSON.stringify(distinct)} 互不相容（严格相等、不做类型转换），没有正文能同时满足`,
      });
      continue;
    }

    const value = distinct[0];
    const conflict = scalarConditionConflict(scalarRule, value);
    if (conflict === null) {
      pins.set(name, value);
      continue;
    }
    if (conflict.kind === 'type') {
      reasons.push({
        pointer,
        message: `条件值 ${JSON.stringify(value)} 与该字段的 ${scalarRule.kind} 规则矛盾（不做类型转换），不存在在此指针处等于该值的合格正文`,
      });
    } else if (conflict.kind === 'enum') {
      reasons.push({
        pointer,
        message: `条件值 ${JSON.stringify(value)} 不在该字段枚举 ${JSON.stringify(scalarRule.enum)} 之中，不存在在此指针处等于该值的合格正文`,
      });
    } else {
      reasons.push({
        pointer,
        message: '条件要求该字段为 JSON null，但字段规则不接受 null；字段缺失也不等于显式 null，不存在满足该条件的合格正文',
      });
    }
  }

  return reasons.length === 0 ? { ok: true, pins } : { ok: false, reasons };
}

// 在根对象规则与全部分支条件之上做精确的有限域可达性求解。
class ReachSolver {
  private readonly dims: readonly ReachDim[];
  private readonly rootRule: Extract<BodyRule, { kind: 'object' }>;
  private readonly branches: readonly BranchSpec[];

  constructor(
    rootRule: Extract<BodyRule, { kind: 'object' }>,
    branches: readonly BranchSpec[],
  ) {
    this.rootRule = rootRule;
    this.branches = branches;
    this.dims = this.buildDims();
  }

  private buildDims(): ReachDim[] {
    // 字段首次被任何分支引用的顺序（配置顺序）
    const names: string[] = [];
    const referenced = new Map<string, Set<unknown>>();
    for (const branch of this.branches) {
      for (const condition of branch.conditions) {
        const name = condition.segments[0];
        if (!referenced.has(name)) {
          referenced.set(name, new Set<unknown>());
          names.push(name);
        }
      }
    }

    const dims: ReachDim[] = [];
    for (const name of names) {
      const field = this.rootRule.fields.get(name) as FieldRule;
      const scalarRule = field.rule as Extract<BodyRule, { kind: ScalarKind }>;
      const ref = referenced.get(name) as Set<unknown>;
      const values: unknown[] = [];
      const seen = new Set<unknown>();
      const push = (v: unknown): void => {
        if (v !== undefined && !seen.has(v)) {
          seen.add(v);
          values.push(v);
        }
      };
      // 各分支引用过且合格的常量
      for (const branch of this.branches) {
        for (const condition of branch.conditions) {
          if (condition.segments[0] !== name) {
            continue;
          }
          if (scalarConditionConflict(scalarRule, condition.value) === null) {
            push(condition.value);
            ref.add(condition.value);
          }
        }
      }
      // null（与“缺失”不同的显式取值）
      if (ruleAcceptsNullValue(scalarRule)) {
        push(null);
      }
      // 一个与全部被引用常量都不同的合格值；没有时（如枚举候选已被全部引用）省略
      push(freshScalarValue(scalarRule, ref));
      dims.push({ name, values, optional: !field.required });
    }
    return dims;
  }

  // 一支条件是否被正文全部满足：取不到值（缺失/无法遍历）即不匹配；
  // 严格相等、不做类型转换（resolvePointer 视空字段名与 __proto__ 为普通字段）
  private satisfies(conditions: readonly BranchCondition[], value: unknown): boolean {
    for (const condition of conditions) {
      const actual = resolvePointer(value, condition.segments);
      if (actual === undefined || actual !== condition.value) {
        return false;
      }
    }
    return true;
  }

  private firstMatch(value: unknown): number | null {
    for (let i = 0; i < this.branches.length; i += 1) {
      if (this.satisfies(this.branches[i].conditions, value)) {
        return i;
      }
    }
    return null;
  }

  // 从必填字段最小样本开始构造根对象（字段名含空名/__proto__ 时用无原型对象）
  private baseObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = Object.create(null);
    for (const [name, field] of this.rootRule.fields) {
      if (field.required) {
        obj[name] = sampleValue(field.rule);
      }
    }
    return obj;
  }

  // 按维度递归枚举合格正文，返回第一个让 predicate 成立的值；全部不成立返回 NO_WITNESS。
  // pins 固定某些字段（某支的等值条件），其余维度取代表值——域对等值条件精确。
  private findObject(
    pins: ReadonlyMap<string, BranchConditionValue>,
    predicate: (value: unknown) => boolean,
  ): Record<string, unknown> | typeof NO_WITNESS {
    const dims = this.dims.filter((dim) => !pins.has(dim.name));
    const base = this.baseObject();
    for (const [name, value] of pins) {
      base[name] = value;
    }

    const problems: StructureProblem[] = [];
    const visit = (index: number): Record<string, unknown> | typeof NO_WITNESS => {
      if (index === dims.length) {
        problems.length = 0;
        checkRule(this.rootRule, base, '', problems);
        if (problems.length === 0 && predicate(base)) {
          return base;
        }
        return NO_WITNESS;
      }
      const dim = dims[index];
      if (dim.optional) {
        // 可选字段先尝试缺失（缺失与显式 null 分开）
        delete base[dim.name];
        const found = visit(index + 1);
        if (found !== NO_WITNESS) {
          return found;
        }
      }
      for (const value of dim.values) {
        base[dim.name] = value;
        const found = visit(index + 1);
        if (found !== NO_WITNESS) {
          return found;
        }
      }
      return NO_WITNESS;
    };
    return visit(0);
  }

  // 找一份合格正文：根可空时先尝试 JSON null（分支字段指针在 null 上取不到值，
  // 任何分支都不命中 null），再在对象域上求解；pins 非空时只能是对象正文。
  // 找到返回该 JSON 值（可能就是 null），找不到返回 NO_WITNESS。
  findWitness(
    pins: ReadonlyMap<string, BranchConditionValue>,
    predicate: (value: unknown) => boolean,
  ): Witness {
    if (pins.size === 0 && ruleAcceptsNullValue(this.rootRule)) {
      if (predicate(null)) {
        return null;
      }
    }
    const obj = this.findObject(pins, predicate);
    return obj;
  }

  // 合并两支的固定取值；同名字段常量不同（严格相等）则不存在共同正文
  private mergePins(
    a: ReadonlyMap<string, BranchConditionValue>,
    b: ReadonlyMap<string, BranchConditionValue>,
  ): Map<string, BranchConditionValue> | null {
    const merged = new Map(a);
    for (const [name, value] of b) {
      const existing = merged.get(name);
      if (existing !== undefined && existing !== value) {
        return null;
      }
      merged.set(name, value);
    }
    return merged;
  }

  private example(value: unknown, routePath: string): ReachExample {
    return {
      method: 'POST',
      path: routePath,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    };
  }

  solve(routePath: string): { branches: BranchReach[]; fallback: FallbackReach } {
    const analyses = this.branches.map((branch) => analyzeBranchConditions(branch, this.rootRule.fields));

    const branchResults: BranchReach[] = [];
    for (let i = 0; i < this.branches.length; i += 1) {
      const branch = this.branches[i];
      const analysis = analyses[i];
      if (!analysis.ok || analysis.pins === undefined) {
        branchResults.push({ id: branch.id, status: 'contradictory', reasons: analysis.reasons });
        continue;
      }

      // 存在合格正文首先命中此支？
      const direct = this.findWitness(analysis.pins, (value) => this.firstMatch(value) === i);
      if (direct !== NO_WITNESS) {
        branchResults.push({ id: branch.id, status: 'reachable', example: this.example(direct, routePath) });
        continue;
      }

      // 满足此支的合格正文必然首先命中某些前序分支——逐支给出共同遮挡者
      const coveredBy: string[] = [];
      for (let j = 0; j < i; j += 1) {
        const prior = analyses[j];
        if (!prior.ok || prior.pins === undefined) {
          continue;
        }
        const merged = this.mergePins(analysis.pins, prior.pins);
        if (merged === null) {
          continue;
        }
        // 同时满足 i 与 j、且 j 之前所有分支都不命中的合格正文
        const witness = this.findWitness(merged, (value) => this.firstMatch(value) === j);
        if (witness !== NO_WITNESS) {
          coveredBy.push(this.branches[j].id);
        }
      }
      branchResults.push({
        id: branch.id,
        status: 'covered',
        coveredBy,
        message:
          `存在满足本支全部条件的合格正文，但它们首先命中的都是前序分支；` +
          `前序分支 ${JSON.stringify(coveredBy)} 的命中区域并集已覆盖本支，本支永远不会被首先选中`,
      });
    }

    // 兜底：存在任何分支都不命中的合格正文（含根为 JSON null）即可达
    const fallbackBody = this.findWitness(new Map(), (value) => this.firstMatch(value) === null);
    let fallback: FallbackReach;
    if (fallbackBody !== NO_WITNESS) {
      fallback = { status: 'reachable', example: this.example(fallbackBody, routePath) };
    } else {
      const coveredBy = this.branches
        .map((branch, j) => {
          const analysis = analyses[j];
          if (!analysis.ok || analysis.pins === undefined) {
            return NO_WITNESS;
          }
          const witness = this.findWitness(analysis.pins, (value) => this.firstMatch(value) === j);
          return witness !== NO_WITNESS ? branch.id : NO_WITNESS;
        })
        .filter((id): id is string => id !== NO_WITNESS);
      fallback = {
        status: 'covered',
        coveredBy,
        message:
          `没有任何合格正文落到兜底：全部合格正文都被分支 ${JSON.stringify(coveredBy)} 的命中区域并集覆盖`,
      };
    }

    return { branches: branchResults, fallback };
  }
}

// 选择诊断目标接口并执行范围预检；任何不满足都抛 ReachError（退出 2）
function selectReachEndpoint(
  specs: readonly EndpointSpec[],
  configFile: string,
  routePath: string,
): { endpoint: EndpointSpec; index: number } {
  const postMatches = specs
    .map((endpoint, index) => ({ endpoint, index }))
    .filter((entry) => entry.endpoint.method === 'POST' && entry.endpoint.path === routePath);

  if (postMatches.length === 0) {
    const existing = specs.filter((ep) => ep.method === 'POST').map((ep) => `POST ${ep.path}`);
    throw new ReachError(
      `场景文件 ${configFile} 中不存在 POST 接口 ${JSON.stringify(routePath)}。` +
        (existing.length > 0 ? `现有的 POST 接口：${existing.join('，')}` : '该配置没有 POST 接口'),
    );
  }

  const { endpoint, index } = postMatches[0];
  const where = `endpoints[${index}]`;
  if (endpoint.branches.length === 0) {
    throw new ReachError(
      `${where}（POST ${routePath}）未声明 branches：reach 仅诊断声明了响应分支的接口`,
    );
  }
  if (!endpoint.bodyRule || endpoint.bodyRule.kind !== 'object') {
    throw new ReachError(
      `${where}.requestBody ${endpoint.bodyRule ? `的类型为 "${endpoint.bodyRule.kind}"` : ''}：` +
        'reach 仅支持根 requestBody 为 object（可附 nullable）的分支接口',
    );
  }

  // when 指针范围预检：单段、指向根对象已声明的标量字段（其他字段仍按递归规则处理）
  const rootFields = endpoint.bodyRule.fields;
  for (let b = 0; b < endpoint.branches.length; b += 1) {
    const branch = endpoint.branches[b];
    for (const condition of branch.conditions) {
      const condWhere = `${where}.branches[${b}].when[${JSON.stringify(condition.pointer)}]`;
      if (condition.segments.length !== 1) {
        throw new ReachError(
          `${condWhere} 指针 ${JSON.stringify(condition.pointer)} 含 ${condition.segments.length} 段：` +
            'reach 仅支持单段 RFC 6901 指针（指向根对象的已声明标量字段），根指针与深层指针超出诊断范围',
        );
      }
      const name = condition.segments[0];
      const field = rootFields.get(name);
      if (!field) {
        throw new ReachError(
          `${condWhere} 指向根对象未声明字段 ${JSON.stringify(name)}：` +
            'reach 仅诊断指向已声明字段的条件（未声明字段仍按 additionalProperties 等现有规则处理）',
        );
      }
      if (field.rule.kind === 'object' || field.rule.kind === 'array') {
        throw new ReachError(
          `${condWhere} 指向字段 ${JSON.stringify(name)}，其规则类型为 "${field.rule.kind}"：` +
            'reach 仅支持指向标量字段的条件，对象/数组字段超出诊断范围',
        );
      }
    }
  }

  return { endpoint, index };
}

async function runReach(configArg: string, pathArg: string): Promise<never> {
  const configFile = path.resolve(configArg);

  let specs: EndpointSpec[];
  try {
    specs = await loadSpecsFromFile(configFile);
  } catch (e) {
    process.stderr.write(`${APP_NAME}: reach 场景配置：${describeError(e)}\n`);
    process.exit(2);
  }

  let report: ReachReport;
  try {
    const { endpoint } = selectReachEndpoint(specs, configFile, pathArg);
    const rootRule = endpoint.bodyRule as Extract<BodyRule, { kind: 'object' }>;
    const result = new ReachSolver(rootRule, endpoint.branches).solve(endpoint.path);
    const unreachableBranches = result.branches.filter((b) => b.status !== 'reachable').length;
    report = {
      configFile,
      method: 'POST',
      path: endpoint.path,
      branches: result.branches,
      fallback: result.fallback,
      unreachableBranches,
    };
  } catch (e) {
    if (e instanceof ReachError) {
      process.stderr.write(`${APP_NAME}: reach: ${e.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`${APP_NAME}: reach 失败：${describeError(e)}\n`);
    process.exit(2);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // 有不可达分支退出 1；兜底不可达仅作信息，不改变退出码
  process.exit(report.unreachableBranches > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

// 模块级运行时句柄（启动后赋值）
let activeState: LiveState;
let server: http.Server;
let configFile = '';
let shuttingDown = false;

// 进程内请求记录：与配置版本、序列相互独立，reload 与清空都不影响编号单调
const requestLog = new RequestLog();

// 尚未发出的延迟响应定时器，关闭时统一取消
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

// 重载按“触发顺序”串行处理：后一个 reload 必定在前一个落定后才读文件
let reloadChain: Promise<unknown> = Promise.resolve();

function triggerReload(): Promise<ReloadResult> {
  const job = reloadChain.then(async (): Promise<ReloadResult> => {
    try {
      // 校验通过前只构造局部变量，任何失败都不会触碰 activeState
      const next = await loadStateFromFile(configFile, activeState.version + 1);
      activeState = next; // 单次同步赋值：请求不可能看到混合配置
      return { ok: true, version: activeState.version };
    } catch (e) {
      // 不修改配置/版本，不重置序列；旧场景的正常消费继续
      return { ok: false, version: activeState.version, error: describeError(e) };
    }
  });
  // 失败也不能打断后续 reload 的排队
  reloadChain = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

function writeResponse(
  res: http.ServerResponse,
  status: number,
  headers: { readonly [name: string]: string },
  body: string,
): void {
  try {
    res.writeHead(status, headers);
    res.end(body === '' ? undefined : body);
  } catch {
    // 预留之后客户端可能已断开：响应仍计为已消费，发送失败仅静默忽略
  }
}

function versionHeaders(
  version: number,
  extra?: { readonly [name: string]: string },
): { [name: string]: string } {
  // 无原型对象：配置中名为 "__proto__" 的响应头在合并时不丢失
  const headers: { [name: string]: string } = Object.create(null);
  headers[VERSION_HEADER] = String(version);
  if (extra) {
    for (const [name, value] of Object.entries(extra)) {
      headers[name] = value;
    }
  }
  return headers;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, version: number): void {
  writeResponse(
    res,
    status,
    versionHeaders(version, { 'Content-Type': 'application/json; charset=utf-8' }),
    `${JSON.stringify(value)}\n`,
  );
}

function sendNotFound(res: http.ServerResponse): void {
  writeResponse(
    res,
    404,
    versionHeaders(activeState.version, {
      'Content-Type': 'text/plain; charset=utf-8',
    }),
    'not found\n',
  );
}

// ---------------------------------------------------------------------------
// 计划响应快照与写出跟踪
// ---------------------------------------------------------------------------
//
// 业务/框架响应在“请求完整接收”那一刻就构造为一份计划快照：
// 记录中保存的状态/应用层头/正文与随后真正写上线的字节共用同一份数据，
// reload 不影响在途请求（它持有的是快照而非当前配置）。

function freezeHeaders(headers: { [name: string]: string }): { readonly [name: string]: string } {
  return Object.freeze(headers);
}

// 场景响应的应用层头：配置头 + 服务器填写的准确版本头（+ 必要时的默认 Content-Type）。
// 不含 Content-Length/Connection/Date/Transfer-Encoding 等传输层自动头。
function buildSceneHeaders(
  item: ResponseSpec,
  version: number,
): { readonly [name: string]: string } {
  const headers = versionHeaders(version);
  let contentTypeSet = false;
  for (const [name, value] of Object.entries(item.headers)) {
    const lower = name.toLowerCase();
    // 版本头由服务器填写且必须唯一准确：配置中的同名头（含大小写变体）可加载，发送时忽略其值
    if (lower === VERSION_HEADER.toLowerCase()) {
      continue;
    }
    if (lower === 'content-type') {
      contentTypeSet = true;
    }
    headers[name] = value;
  }
  // 文本正文的默认内容类型；配置显式给出时不覆盖
  if (!contentTypeSet && item.body !== '') {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
  }
  return freezeHeaders(headers);
}

function buildScenePlanned(item: ResponseSpec, version: number): PlannedResponseSnapshot {
  return {
    kind: 'scene',
    status: item.status,
    headers: buildSceneHeaders(item, version),
    body: item.body,
  };
}

function buildFrameworkPlanned(
  status: number,
  version: number,
  body: string,
  contentType: string,
): PlannedResponseSnapshot {
  return {
    kind: 'framework',
    status,
    headers: freezeHeaders(versionHeaders(version, { 'Content-Type': contentType })),
    body,
  };
}

// 按计划快照写出；writeHead/end 在已断开套接字上抛错时标记为中断（消费已成立）。
function writePlanned(
  res: http.ServerResponse,
  planned: PlannedResponseSnapshot,
  recordId: number,
): void {
  try {
    res.writeHead(planned.status, { ...planned.headers });
    res.end(planned.body === '' ? undefined : planned.body);
  } catch {
    requestLog.markDelivered(recordId, 'interrupted');
  }
}

// 挂载一次写出生命周期跟踪。每个被记录的请求恰好回复一次，故在接收完成后立即挂载：
// 延迟期间断开也能标为中断；'sent' 为终态，随后连接正常关闭不回退。
function attachDeliveryTracking(res: http.ServerResponse, recordId: number): void {
  let settled = false;
  const settle = (status: DeliveryStatus): void => {
    if (settled) {
      return;
    }
    settled = true;
    requestLog.markDelivered(recordId, status);
  };
  res.once('finish', () => settle('sent'));
  res.once('close', () => settle(res.writableFinished ? 'sent' : 'interrupted'));
  res.once('error', () => settle('interrupted'));
}

// 延迟结束才按接收时的计划快照发送；即便客户端提前断开也继续计时（消费在预留时已成立）
function schedulePlannedResponse(
  res: http.ServerResponse,
  planned: PlannedResponseSnapshot,
  delay: number,
  recordId: number,
): void {
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    writePlanned(res, planned, recordId);
  }, delay);
  pendingTimers.add(timer);
}

type BodyOutcome = 'received' | 'aborted' | 'too-large';

interface ReceivedBody {
  readonly outcome: BodyOutcome;
  // 仅在 outcome 为 'received' 时有意义（完整请求体）
  readonly body: Buffer;
}

// 完整接收请求体；未完整接收即断开返回 'aborted'（调用方不得推进序列）
function receiveBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<ReceivedBody> {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (outcome: BodyOutcome): void => {
      if (!settled) {
        settled = true;
        resolve({ outcome, body: outcome === 'received' ? Buffer.concat(chunks) : Buffer.alloc(0) });
      }
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        finish('too-large');
        writeResponse(
          res,
          413,
          versionHeaders(activeState.version, {
            'Content-Type': 'text/plain; charset=utf-8',
          }),
          'payload too large\n',
        );
        // 等 413 刷出后再断开，避免客户端收不到响应
        res.once('finish', () => req.socket.destroy());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish('received'));
    req.on('error', () => finish('aborted'));
    req.on('aborted', () => finish('aborted'));
    res.on('close', () => finish('aborted'));
  });
}

async function dispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  res.on('error', () => {
    // 写已销毁套接字等错误无需让进程崩溃
  });

  const method = String(req.method);
  const target = String(req.url ?? '/'); // 含查询串的原始请求目标
  const pathname = target.split('?')[0]; // 查询串不参与匹配

  const { outcome, body } = await receiveBody(req, res);
  if (outcome !== 'received') {
    // aborted：未完整接收，不匹配、不预留、不推进任何序列，也不创建记录
    // too-large：已回复 413，不创建记录、不消费序列
    return;
  }

  // 管理范围：/__contractlab 本身及 /__contractlab/ 前缀。
  // 其中所有请求都不记录、不消费业务序列（含未知子路径的 404）。
  if (pathname === ADMIN_BASE || pathname.startsWith(ADMIN_PREFIX)) {
    await handleAdmin(method, pathname, res);
    return;
  }

  // 完整接收且不在管理范围：此刻创建记录并取得进程内递增编号。
  // 编号只取决于完整接收顺序，与接口序列的消费位置互不相关。
  const state = activeState;
  const record = requestLog.create({
    method,
    target,
    path: pathname,
    rawHeaders: req.rawHeaders,
    body,
    configVersion: state.version,
  });
  attachDeliveryTracking(res, record.id);

  // 业务匹配：在本次同步执行内抓取状态快照，预留后与后续 reload 互不影响
  const endpoint =
    method === 'GET' || method === 'POST'
      ? state.endpoints.get(`${method} ${pathname}`)
      : undefined;

  if (!endpoint) {
    // 未匹配请求：404，不消费、无消费位置
    record.matched = false;
    record.endpoint = `${method} ${pathname}`;
    const planned = buildFrameworkPlanned(
      404,
      state.version,
      'not found\n',
      'text/plain; charset=utf-8',
    );
    record.plannedResponse = planned;
    writePlanned(res, planned, record.id);
    return;
  }
  record.matched = true;
  record.endpoint = endpoint.key;

  // 正文结构规则（如有）：校验失败返回 400 差异报告，不发送场景响应、不消费序列。
  // 规则、序列与版本均取自上面同一快照 state。
  let parsedBody: unknown = undefined;
  if (endpoint.bodyRule) {
    const result = validateBodyAndParse(req.headers['content-type'], body, endpoint.bodyRule);
    if ('report' in result) {
      record.bodyValidationPassed = false;
      record.bodyRejection = result.report;
      const planned = buildFrameworkPlanned(
        400,
        state.version,
        `${JSON.stringify(result.report)}\n`,
        'application/json; charset=utf-8',
      );
      record.plannedResponse = planned;
      writePlanned(res, planned, record.id);
      return;
    }
    record.bodyValidationPassed = true;
    parsedBody = result.value;
  }

  // 校验通过（或无规则）：立即预留。声明了分支时按正文值选择分支序列，
  // 否则使用接口兜底序列；各序列独立计数，消费位置与序列长度对应选中序列。
  const reserved =
    endpoint.branches.length > 0
      ? reserveForBody(endpoint, parsedBody)
      : (() => {
          const r = reserveFromSequence(endpoint.responses, endpoint);
          return { ...r, branchId: null as string | null, sequence: endpoint.responses };
        })();
  record.branchSelection =
    reserved.branchId === null ? { kind: 'fallback' } : { kind: 'branch', id: reserved.branchId };
  record.sequencePosition = reserved.position;
  record.sequenceLength = reserved.sequence.length;
  const planned = buildScenePlanned(reserved.item, state.version);
  record.plannedResponse = planned;
  schedulePlannedResponse(res, planned, reserved.item.delay, record.id);
}

// ---------------------------------------------------------------------------
// 管理入口：健康查询、热更新、请求记录查询/清空
// ---------------------------------------------------------------------------

function requestsUsageNote(): string {
  return (
    'contractlab 请求记录（仅保存在本次服务进程内存中，不写文件）：' +
    'GET /__contractlab/requests 查询一致快照（不推进序列）；' +
    'POST /__contractlab/requests/clear 清空当时全部记录（不取消响应、不改配置/版本/序列）。' +
    'delivery=pending 表示计划响应待发送，sent 表示服务器已完成写出（不代表客户端已收到），' +
    'interrupted 表示写出完成前连接断开或发送失败。'
  );
}

async function handleAdmin(method: string, pathname: string, res: http.ServerResponse): Promise<void> {
  if (pathname === HEALTH_PATH) {
    if (method === 'GET') {
      sendJson(res, 200, { status: 'ok', version: activeState.version }, activeState.version);
    } else {
      sendNotFound(res);
    }
    return;
  }

  if (pathname === RELOAD_PATH) {
    if (method === 'POST') {
      const result = await triggerReload();
      sendJson(res, 200, result, result.version);
    } else {
      sendNotFound(res);
    }
    return;
  }

  if (pathname === REQUESTS_PATH) {
    if (method === 'GET') {
      const records = requestLog.snapshot();
      sendJson(
        res,
        200,
        { note: requestsUsageNote(), count: records.length, records },
        activeState.version,
      );
    } else {
      sendNotFound(res);
    }
    return;
  }

  if (pathname === REQUESTS_CLEAR_PATH) {
    if (method === 'POST') {
      const removed = requestLog.clear();
      sendJson(
        res,
        200,
        { ok: true, removed, note: requestsUsageNote() },
        activeState.version,
      );
    } else {
      sendNotFound(res);
    }
    return;
  }

  // 管理范围内的未知路径：仍是管理请求，不记录、不消费
  sendNotFound(res);
}

// ---------------------------------------------------------------------------
// 启动、信号处理
// ---------------------------------------------------------------------------

function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  // 取消所有尚未发出的延迟响应
  for (const timer of pendingTimers) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
  // 关闭监听并断开空闲/在途连接，随后正常退出（退出码 0）
  try {
    server.closeAllConnections();
  } catch {
    // 旧版本兜底：忽略，下面的 close/超时仍会结束进程
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

async function startServer(configArg: string, port: number): Promise<void> {
  configFile = path.resolve(configArg);

  // 先读配置：配置无效时根本不会创建监听
  activeState = await loadStateFromFile(configFile, 1);

  server = http.createServer((req, res) => {
    dispatch(req, res).catch(() => {
      try {
        req.socket.destroy();
      } catch {
        // 套接字可能已销毁
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 仅监听本机回环地址
    server.listen(port, '127.0.0.1', resolve);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(
    `${APP_NAME}: listening on http://127.0.0.1:${actualPort}\n` +
      `${APP_NAME}: config ${configFile} (version 1, ${activeState.endpoints.size} endpoints)\n`,
  );

  const onSignal = (): void => shutdown();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

function helpText(): string {
  return [
    APP_NAME,
    '',
    '可热更新的本地接口场景服务：在同一接口上按顺序返回预设响应，',
    '修改场景文件后通过管理入口热更新，更新期间服务不中断。',
    '',
    'Usage:',
    '  node app.ts [--help]',
    '  node app.ts serve --config <file> --port <port>',
    '  node app.ts compare --old <file> --new <file>',
    '  node app.ts import --openapi <file> --config <file>',
    '  node app.ts verify --requests <file> --config <file>',
    '  node app.ts replay --requests <file> --port <port> --timeout <ms> [--strategy <file>]',
    '  node app.ts reach --config <file> --path <literal-post-path>',
    '',
    'Options (serve):',
    '  -c, --config <file>   本地 JSON 场景配置文件（必填）',
    '  -p, --port <number>   监听端口，0 表示由操作系统分配（必填）',
    '                        服务仅监听 127.0.0.1',
    '  -h, --help            显示本帮助',
    '',
    'Options (compare):',
    '  -o, --old <file>      旧版场景配置文件（必填）',
    '  -n, --new <file>      新版场景配置文件（必填）',
    '                        离线比较“沿用旧接口约定的客户端能否调用新版”，',
    '                        不启动监听；报告以 JSON 写往 stdout：',
    '                        兼容退出 0，不兼容退出 1，',
    '                        参数/读取/解析/校验失败退出 2（错误写 stderr）',
    '',
    'Options (import):',
    '  -s, --openapi <file>  本地 OpenAPI 3.0 JSON 文件（必填）',
    '  -c, --config <file>   现有场景配置文件（必填）',
    '                        按“方法 + 字面路径”为每个场景接口选择文档操作，',
    '                        仅用操作 requestBody 转换出的正文规则替换接口的',
    '                        requestBody（保留接口顺序与 responses）；',
    '                        新场景 JSON 写往 stdout，可直接用于 serve/compare；',
    '                        成功退出 0，参数/读取/解析/场景校验/转换失败',
    '                        退出 2（错误写 stderr，stdout 为空）',
    '',
    'Options (verify):',
    '  -r, --requests <file> GET /__contractlab/requests 的完整 JSON 快照文件（必填）',
    '  -c, --config <file>   场景配置文件（必填）',
    '                        离线按所给场景逐条重新校验快照中的请求：',
    '                        不监听、不发送请求、不修改文件；',
    '                        报告以 JSON 写往 stdout：空快照或全部接受退出 0，',
    '                        存在请求拒绝退出 1，',
    '                        参数/读取/解析/校验失败退出 2（错误写 stderr，stdout 为空）',
    '',
    'Options (replay):',
    '  -r, --requests <file> GET /__contractlab/requests 的完整 JSON 快照文件（必填）',
    '  -p, --port <number>   目标端口：127.0.0.1 上的有效非零端口（必填）',
    '  -t, --timeout <ms>    每条请求的总超时（正整数毫秒，自开始连接覆盖完整收发）',
    '  -s, --strategy <file> 可选比较策略：按“方法 + 字面路径”为接口选择',
    '                        响应正文 JSON 语义比较（可附 RFC 6901 忽略指针，',
    '                        并用 keyedArrays 为互不嵌套的数组位置指定元素自有',
    '                        字段作业务键，按键配对、忽略列表排序差异）；',
    '                        不提供时全部接口按正文原始字节比较',
    '                        本机重放快照中的请求（仅 GET/POST，禁止管理入口路径）：',
    '                        按输入顺序逐条发送，每条只尝试一次、不跟随重定向；',
    '                        仅比较响应状态码与正文和记录中的计划响应；',
    '                        不监听、不修改文件；报告以 JSON 写往 stdout：',
    '                        空快照或全部相同退出 0，存在差异或通信失败退出 1，',
    '                        参数/读取/解析/校验失败退出 2（错误写 stderr，stdout 为空）',
    '',
    'Options (reach):',
    '  -c, --config <file>   场景配置文件（必填，按与 serve 相同的严格校验）',
    '  -p, --path <path>     要诊断的 POST 接口字面路径（必填）',
    '                        离线诊断响应分支可达性，发现永远不会被首先选中的分支：',
    '                        不监听、不发送请求、不修改文件；报告以 JSON 写往 stdout：',
    '                        分支全部可达退出 0，存在不可达分支退出 1，',
    '                        参数/读取/解析/配置/接口选择或范围错误退出 2',
    '                        （错误写 stderr 指明文件与位置，stdout 为空）',
    '',
    '管理入口（路径前缀 /__contractlab/ 为业务接口保留区之外的保留前缀）：',
    '  GET  /__contractlab/health          健康查询，返回当前配置版本',
    '  POST /__contractlab/reload          重新读取并热更新同一配置文件',
    '  GET  /__contractlab/requests        查询本次进程内的请求记录（一致快照）',
    '  POST /__contractlab/requests/clear  清空请求记录（不取消响应、不改配置）',
    '',
    '配置格式见 README.md。',
  ].join('\n');
}

function cliFail(message: string): never {
  process.stderr.write(`${APP_NAME}: ${message}\n`);
  process.stderr.write(`运行 'node app.ts --help' 查看用法。\n`);
  process.exit(2);
}

interface ServeOptions {
  config: string;
  port: number;
}

function parseServeArgv(argv: readonly string[]): ServeOptions {
  let config: string | undefined;
  let port: number | undefined;

  const readValue = (flag: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) {
      return [inline, index];
    }
    const value = argv[index + 1];
    if (value === undefined) {
      cliFail(`serve: 参数 ${flag} 缺少取值`);
    }
    return [value as string, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    }

    let flag = token;
    let inline: string | undefined;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flag = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }

    if (flag === '--config' || flag === '-c') {
      [config, i] = readValue(flag, inline, i);
    } else if (flag === '--port' || flag === '-p') {
      let value: string;
      [value, i] = readValue(flag, inline, i);
      if (!/^\d+$/.test(value)) {
        cliFail(`serve: 端口必须是整数，收到 "${value}"`);
      }
      port = Number(value);
      if (port < 0 || port > 65535) {
        cliFail(`serve: 端口必须在 0 至 65535 之间，收到 ${port}`);
      }
    } else {
      cliFail(`serve: 不支持的命令行参数: ${token}`);
    }
  }

  if (config === undefined) {
    cliFail('serve: 缺少必填参数 --config <file>');
  }
  if (port === undefined) {
    cliFail('serve: 缺少必填参数 --port <port>');
  }
  return { config, port };
}

interface CompareOptions {
  oldFile: string;
  newFile: string;
}

function parseCompareArgv(argv: readonly string[]): CompareOptions {
  let oldFile: string | undefined;
  let newFile: string | undefined;

  const readValue = (flag: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) {
      return [inline, index];
    }
    const value = argv[index + 1];
    if (value === undefined) {
      cliFail(`compare: 参数 ${flag} 缺少取值`);
    }
    return [value as string, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    }

    let flag = token;
    let inline: string | undefined;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flag = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }

    if (flag === '--old' || flag === '-o') {
      [oldFile, i] = readValue(flag, inline, i);
    } else if (flag === '--new' || flag === '-n') {
      [newFile, i] = readValue(flag, inline, i);
    } else {
      cliFail(`compare: 不支持的命令行参数: ${token}`);
    }
  }

  if (oldFile === undefined) {
    cliFail('compare: 缺少必填参数 --old <file>');
  }
  if (newFile === undefined) {
    cliFail('compare: 缺少必填参数 --new <file>');
  }
  return { oldFile, newFile };
}

interface ImportOptions {
  openapi: string;
  config: string;
}

function parseImportArgv(argv: readonly string[]): ImportOptions {
  let openapi: string | undefined;
  let config: string | undefined;

  const readValue = (flag: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) {
      return [inline, index];
    }
    const value = argv[index + 1];
    if (value === undefined) {
      cliFail(`import: 参数 ${flag} 缺少取值`);
    }
    return [value as string, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    }

    let flag = token;
    let inline: string | undefined;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flag = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }

    if (flag === '--openapi' || flag === '-s') {
      [openapi, i] = readValue(flag, inline, i);
    } else if (flag === '--config' || flag === '-c') {
      [config, i] = readValue(flag, inline, i);
    } else {
      cliFail(`import: 不支持的命令行参数: ${token}`);
    }
  }

  if (openapi === undefined) {
    cliFail('import: 缺少必填参数 --openapi <file>');
  }
  if (config === undefined) {
    cliFail('import: 缺少必填参数 --config <file>');
  }
  return { openapi, config };
}

interface VerifyOptions {
  requests: string;
  config: string;
}

function parseVerifyArgv(argv: readonly string[]): VerifyOptions {
  let requests: string | undefined;
  let config: string | undefined;

  const readValue = (flag: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) {
      return [inline, index];
    }
    const value = argv[index + 1];
    if (value === undefined) {
      cliFail(`verify: 参数 ${flag} 缺少取值`);
    }
    return [value as string, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    }

    let flag = token;
    let inline: string | undefined;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flag = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }

    if (flag === '--requests' || flag === '-r') {
      [requests, i] = readValue(flag, inline, i);
    } else if (flag === '--config' || flag === '-c') {
      [config, i] = readValue(flag, inline, i);
    } else {
      cliFail(`verify: 不支持的命令行参数: ${token}`);
    }
  }

  if (requests === undefined) {
    cliFail('verify: 缺少必填参数 --requests <file>');
  }
  if (config === undefined) {
    cliFail('verify: 缺少必填参数 --config <file>');
  }
  return { requests, config };
}

interface ReplayOptions {
  requests: string;
  port: number;
  timeoutMs: number;
  strategy?: string;
}

function parseReplayArgv(argv: readonly string[]): ReplayOptions {
  let requests: string | undefined;
  let port: number | undefined;
  let timeoutMs: number | undefined;
  let strategy: string | undefined;

  const readValue = (flag: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) {
      return [inline, index];
    }
    const value = argv[index + 1];
    if (value === undefined) {
      cliFail(`replay: 参数 ${flag} 缺少取值`);
    }
    return [value as string, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    }

    let flag = token;
    let inline: string | undefined;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flag = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }

    if (flag === '--requests' || flag === '-r') {
      [requests, i] = readValue(flag, inline, i);
    } else if (flag === '--port' || flag === '-p') {
      let value: string;
      [value, i] = readValue(flag, inline, i);
      if (!/^\d+$/.test(value)) {
        cliFail(`replay: 端口必须是整数，收到 "${value}"`);
      }
      port = Number(value);
      if (port < 1 || port > 65535) {
        cliFail(`replay: 端口必须是 1 至 65535 之间的有效非零端口，收到 ${port}`);
      }
    } else if (flag === '--timeout' || flag === '-t') {
      let value: string;
      [value, i] = readValue(flag, inline, i);
      if (!/^\d+$/.test(value)) {
        cliFail(`replay: 总超时必须是正整数毫秒数，收到 "${value}"`);
      }
      timeoutMs = Number(value);
      if (timeoutMs < 1) {
        cliFail(`replay: 总超时必须是正整数毫秒数，收到 ${timeoutMs}`);
      }
    } else if (flag === '--strategy' || flag === '-s') {
      [strategy, i] = readValue(flag, inline, i);
    } else {
      cliFail(`replay: 不支持的命令行参数: ${token}`);
    }
  }

  if (requests === undefined) {
    cliFail('replay: 缺少必填参数 --requests <file>');
  }
  if (port === undefined) {
    cliFail('replay: 缺少必填参数 --port <port>');
  }
  if (timeoutMs === undefined) {
    cliFail('replay: 缺少必填参数 --timeout <ms>');
  }
  return strategy === undefined
    ? { requests, port, timeoutMs }
    : { requests, port, timeoutMs, strategy };
}

interface ReachOptions {
  config: string;
  path: string;
}

function parseReachArgv(argv: readonly string[]): ReachOptions {
  let config: string | undefined;
  let routePath: string | undefined;

  const readValue = (flag: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) {
      return [inline, index];
    }
    const value = argv[index + 1];
    if (value === undefined) {
      cliFail(`reach: 参数 ${flag} 缺少取值`);
    }
    return [value as string, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    }

    let flag = token;
    let inline: string | undefined;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flag = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }

    if (flag === '--config' || flag === '-c') {
      [config, i] = readValue(flag, inline, i);
    } else if (flag === '--path' || flag === '-p') {
      [routePath, i] = readValue(flag, inline, i);
    } else {
      cliFail(`reach: 不支持的命令行参数: ${token}`);
    }
  }

  if (config === undefined) {
    cliFail('reach: 缺少必填参数 --config <file>');
  }
  if (routePath === undefined) {
    cliFail('reach: 缺少必填参数 --path <literal-path>');
  }
  if (routePath.length === 0 || routePath[0] !== '/') {
    cliFail(`reach: --path 必须是以 "/" 开头的接口字面路径，收到 ${JSON.stringify(routePath)}`);
  }
  return { config, path: routePath };
}

function main(): void {
  const argv = process.argv.slice(2);

  // 保留行为：无参数、--help、-h 显示应用名与帮助
  if (
    argv.length === 0 ||
    (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h'))
  ) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  if (argv[0] === 'serve') {
    const options = parseServeArgv(argv.slice(1));
    startServer(options.config, options.port).catch((e: unknown) => {
      process.stderr.write(`${APP_NAME}: 启动失败：${describeError(e)}\n`);
      process.exit(1);
    });
    return;
  }

  if (argv[0] === 'compare') {
    const options = parseCompareArgv(argv.slice(1));
    runCompare(options.oldFile, options.newFile).catch((e: unknown) => {
      process.stderr.write(`${APP_NAME}: compare 失败：${describeError(e)}\n`);
      process.exit(2);
    });
    return;
  }

  if (argv[0] === 'import') {
    const options = parseImportArgv(argv.slice(1));
    runImport(options.openapi, options.config).catch((e: unknown) => {
      process.stderr.write(`${APP_NAME}: import 失败：${describeError(e)}\n`);
      process.exit(2);
    });
    return;
  }

  if (argv[0] === 'verify') {
    const options = parseVerifyArgv(argv.slice(1));
    runVerify(options.requests, options.config).catch((e: unknown) => {
      process.stderr.write(`${APP_NAME}: verify 失败：${describeError(e)}\n`);
      process.exit(2);
    });
    return;
  }

  if (argv[0] === 'replay') {
    const options = parseReplayArgv(argv.slice(1));
    runReplay(options.requests, options.port, options.timeoutMs, options.strategy).catch((e: unknown) => {
      process.stderr.write(`${APP_NAME}: replay 失败：${describeError(e)}\n`);
      process.exit(2);
    });
    return;
  }

  if (argv[0] === 'reach') {
    const options = parseReachArgv(argv.slice(1));
    runReach(options.config, options.path).catch((e: unknown) => {
      process.stderr.write(`${APP_NAME}: reach 失败：${describeError(e)}\n`);
      process.exit(2);
    });
    return;
  }

  // 不支持的命令行参数：报错并以状态码 2 退出
  process.stderr.write(`${APP_NAME}: 不支持的命令行参数: ${argv.join(' ')}\n`);
  process.stderr.write(`运行 'node app.ts --help' 查看用法。\n`);
  process.exit(2);
}

main();

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
//   校验通过才按“完整接收”顺序预留响应项。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const APP_NAME = 'contractlab';

// 管理入口（保留前缀，业务接口不得使用）
const ADMIN_PREFIX = '/__contractlab/';
const HEALTH_PATH = '/__contractlab/health';
const RELOAD_PATH = '/__contractlab/reload';

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
// 字段规则 = 任意规则 + 可选 "required": true（缺省为可缺省）；
// object 的 fields / additionalProperties 可省略（默认无字段声明、拒绝未声明字段）；
// array 必须声明 items。

type ScalarKind = 'string' | 'number' | 'integer' | 'boolean' | 'null';

type BodyRule =
  | {
      readonly kind: 'object';
      readonly fields: ReadonlyMap<string, FieldRule>;
      readonly additionalProperties: boolean;
    }
  | { readonly kind: 'array'; readonly items: BodyRule }
  | { readonly kind: ScalarKind };

interface FieldRule {
  readonly rule: BodyRule;
  readonly required: boolean;
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
  readonly responses: readonly ResponseSpec[];
  readonly bodyRule: BodyRule | undefined;
}

interface LiveEndpoint {
  readonly key: string;
  readonly responses: readonly ResponseSpec[];
  readonly bodyRule: BodyRule | undefined;
  // 下一个待预留位置；到达末项后停在末项（持续复用）
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
  const cleanHeaders: { [name: string]: string } = {};
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

// inField 为真时，该规则是 object.fields 的条目：额外允许 "required"。
// 直接在原始对象上校验，绝不逐键复制到普通对象——未知键 "__proto__"
// 经 JSON.parse 是自有数据属性，一旦用赋值复制就会被当成原型设置而丢失。
function validateBodyRule(raw: unknown, where: string, inField = false): BodyRule {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} 必须是对象（含 "type" 字段）`);
  }

  const type = raw.type;
  const allowed = new Set(['type']);
  if (inField) {
    allowed.add('required');
  }
  if (type === 'object') {
    allowed.add('fields');
    allowed.add('additionalProperties');
  } else if (type === 'array') {
    allowed.add('items');
  } else if (!SCALAR_KINDS.has(type as string)) {
    throw new ConfigError(
      `${where}.type 必须是 "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"，收到 ${JSON.stringify(type)}`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`${where} 含未知字段 "${key}"`);
    }
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
    return { kind: 'object', fields, additionalProperties: additional === true };
  }

  if (type === 'array') {
    if (raw.items === undefined) {
      throw new ConfigError(`${where}.items 数组规则必须声明元素规则`);
    }
    return { kind: 'array', items: validateBodyRule(raw.items, `${where}.items`) };
  }

  return { kind: type as ScalarKind };
}

// 字段规则 = 任意规则 + 可选 "required"（仅允许出现在 object 的 fields 条目中）
function validateFieldRule(raw: unknown, where: string): FieldRule {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} 必须是对象（含 "type" 字段）`);
  }
  let required = false;
  if (Object.prototype.hasOwnProperty.call(raw, 'required')) {
    if (typeof raw.required !== 'boolean') {
      throw new ConfigError(`${where}.required 必须是布尔值`);
    }
    required = raw.required;
  }
  return { rule: validateBodyRule(raw, where, true), required };
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
    if (key !== 'method' && key !== 'path' && key !== 'responses' && key !== 'requestBody') {
      throw new ConfigError(`${where} 含未知字段 "${key}"`);
    }
  }

  const { method, path: routePath, responses, requestBody } = raw;

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

  return { method, path: routePath, responses: cleanResponses, bodyRule };
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
      cursor: 0,
    });
  }
  return { version, endpoints };
}

// 同步预留下一项；同一事件循环内按“完整接收”事件的先后串行调用，天然保序。
// 末项之后持续返回末项，不跳项、不复用未到位置的项。
function reserveNext(endpoint: LiveEndpoint): ResponseSpec {
  const last = endpoint.responses.length - 1;
  const position = endpoint.cursor < last ? endpoint.cursor : last;
  if (endpoint.cursor < last) {
    endpoint.cursor += 1;
  }
  return endpoint.responses[position];
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

// 结构比对：父节点类型不符时只报告该节点，不再深入制造子节点错误；
// 字段缺失（hasOwnProperty 为假）与合法的 JSON null 分开判断。
function checkRule(
  rule: BodyRule,
  value: unknown,
  pointer: string,
  problems: StructureProblem[],
): void {
  switch (rule.kind) {
    case 'string':
    case 'boolean':
      if (typeof value !== rule.kind) {
        problems.push({ pointer, expected: rule.kind, actual: jsonTypeOf(value) });
      }
      return;
    case 'null':
      if (value !== null) {
        problems.push({ pointer, expected: 'null', actual: jsonTypeOf(value) });
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push({ pointer, expected: 'number', actual: jsonTypeOf(value) });
      }
      return;
    case 'integer':
      if (!Number.isInteger(value)) {
        problems.push({ pointer, expected: 'integer', actual: jsonTypeOf(value) });
      }
      return;
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
}

// 返回 null 表示校验通过；否则为可直接序列化的 400 差异报告
function validateRequestBody(
  req: http.IncomingMessage,
  body: Buffer,
  rule: BodyRule,
): BodyReport | null {
  const contentType = req.headers['content-type'];
  const mediaType =
    typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
  if (mediaType !== 'application/json') {
    return parseFailure(
      typeof contentType === 'string'
        ? `媒体类型不符：期望 application/json（可带参数、忽略大小写），收到 "${contentType}"`
        : '缺少 Content-Type 头：期望 application/json（可带参数、忽略大小写）',
    );
  }

  if (body.length === 0) {
    return parseFailure('请求正文为空，无法解析为 JSON');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return parseFailure('请求正文不是合法的 UTF-8 编码');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return parseFailure(`请求正文不是合法 JSON：${describeError(e)}`);
  }

  const problems: StructureProblem[] = [];
  checkRule(rule, parsed, '', problems);
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

// ---------------------------------------------------------------------------
// 文件读取与（重新）加载：读、解析、校验全部通过后才一次性替换
// ---------------------------------------------------------------------------

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadStateFromFile(configPath: string, version: number): Promise<LiveState> {
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
    const specs = validateConfig(raw);
    return buildState(version, specs);
  } catch (e) {
    throw new Error(`配置文件 ${configPath} 校验失败：${describeError(e)}`);
  }
}

// ---------------------------------------------------------------------------
// 离线兼容报告（compat 子命令）：旧配置 -> 新配置的请求接受集合包含判定
// ---------------------------------------------------------------------------
//
// 判定的是“递归规则接受的 JSON 值集合”的包含关系，而非文本比较或抽样：
// - 结构类型在根处即互不相交（object/array/各标量）；
// - integer 接受集合 ⊊ number；
// - object：新增必填（旧版可缺省）、同名字段规则收紧、旧允许的键新版拒绝；
// - array：用非空数组把 items 的收紧体现在元素 /0 上。
// 每处不兼容都构造一个“旧规则接受、新规则拒绝”的具体 JSON 值作为反例。

interface CompatReason {
  readonly code: 'endpoint_not_found' | 'body_rejected';
  // RFC 6901 指针；接口删除时为 null
  readonly pointer: string | null;
  readonly message: string;
}

interface CounterexampleRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers: { readonly [name: string]: string };
  // 原始请求正文（字符串原样发送）
  readonly body: string;
}

interface EndpointVerdict {
  readonly method: HttpMethod;
  readonly path: string;
  readonly compatible: boolean;
  readonly reason?: CompatReason;
  readonly counterexample?: CounterexampleRequest;
}

interface CompatReport {
  readonly direction: 'old-to-new';
  readonly compatible: boolean;
  readonly summary: {
    readonly total: number;
    readonly compatible: number;
    readonly incompatible: number;
  };
  readonly endpoints: readonly EndpointVerdict[];
}

// 一次值集合层面的不兼容：指针、原因、旧规则接受而新规则拒绝的 JSON 值
interface RuleWitness {
  readonly pointer: string;
  readonly message: string;
  readonly value: unknown;
}

// 规则在根处可能接受的 JSON 类型标签（integer 与 number 分开列出）
type JsonKind = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array';

function scalarAcceptsKind(kind: ScalarKind, accepted: JsonKind): boolean {
  if (kind === 'number') {
    return accepted === 'number' || accepted === 'integer';
  }
  return kind === accepted;
}

function ruleAcceptsKind(rule: BodyRule, kind: JsonKind): boolean {
  switch (rule.kind) {
    case 'object':
      return kind === 'object';
    case 'array':
      return kind === 'array';
    default:
      return scalarAcceptsKind(rule.kind, kind);
  }
}

function acceptedKinds(rule: BodyRule): JsonKind[] {
  const all: JsonKind[] = ['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'];
  return all.filter((k) => ruleAcceptsKind(rule, k));
}

// 构造用于反例的 JSON 对象：必须以 null 为原型，否则键名为 "__proto__"
// （合法业务字段名）时，赋值会被解释为设置原型，JSON.stringify 也会漏掉它。
function makeJsonObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

// 规则一定接受的最小 JSON 值
function minimalAcceptedValue(rule: BodyRule): unknown {
  switch (rule.kind) {
    case 'string':
      return '';
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
      const value = makeJsonObject();
      for (const [name, field] of rule.fields) {
        if (field.required) {
          value[name] = minimalAcceptedValue(field.rule);
        }
      }
      return value;
    }
  }
}

function kindSample(kind: JsonKind): unknown {
  switch (kind) {
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'object':
      return {};
    case 'array':
      return [];
  }
}

function kindLabel(kind: JsonKind): string {
  return kind;
}

function pointerChild(pointer: string, segment: string): string {
  return `${pointer}/${escapePointerSegment(segment)}`;
}

// 旧规则缺失（any：旧接口未配置 requestBody 或旧 object 允许额外键）时，
// 构造一个必被新规则拒绝的值：优先用根处类型不符。
function witnessAgainstAny(rule: BodyRule, pointer: string): RuleWitness {
  if (rule.kind === 'object') {
    return {
      pointer,
      message: `新规则在 ${pointer || '""'} 要求 object，旧规则允许任意类型的值（array 即不被接受）`,
      value: [],
    };
  }
  if (rule.kind === 'array') {
    return {
      pointer,
      message: `新规则在 ${pointer || '""'} 要求 array，旧规则允许任意类型的值（object 即不被接受）`,
      value: {},
    };
  }
  const rejected: JsonKind =
    rule.kind === 'null'
      ? 'string'
      : rule.kind === 'string'
        ? 'number'
        : 'null'; // number / integer / boolean 都不接受 null
  return {
    pointer,
    message: `新规则在 ${pointer || '""'} 要求 ${rule.kind}，旧规则允许 ${kindLabel(rejected)} 类型的值`,
    value: kindSample(rejected),
  };
}

// 在根类型层面寻找“旧接受、新拒绝”的类型；integer 对 number 的收紧不在此处理
function typeLevelWitness(newRule: BodyRule, oldKinds: readonly JsonKind[], pointer: string): RuleWitness | null {
  for (const kind of oldKinds) {
    if (!ruleAcceptsKind(newRule, kind)) {
      return {
        pointer,
        message: `新规则在 ${pointer || '""'} 要求 ${newRule.kind}，旧规则允许 ${kindLabel(kind)} 类型的值`,
        value: kindSample(kind),
      };
    }
  }
  return null;
}

// 为 oldObject 构造一个通过其校验的对象底版：填齐旧规则的全部必填字段，
// 跳过 skip 中的键（该处将放入专门的反例值或刻意缺省）。
function seedOldRequired(
  oldObject: Extract<BodyRule, { kind: 'object' }>,
  skip: ReadonlySet<string>,
): Record<string, unknown> {
  const value = makeJsonObject();
  for (const [name, field] of oldObject.fields) {
    if (field.required && !skip.has(name)) {
      value[name] = minimalAcceptedValue(field.rule);
    }
  }
  return value;
}

// 核心递归：返回 null 表示新规则接受集合覆盖旧规则；否则给出反例。
// oldRule 为 undefined 表示旧侧在该位置接受任意 JSON（any）。
function deriveWitness(
  newRule: BodyRule,
  oldRule: BodyRule | undefined,
  pointer: string,
): RuleWitness | null {
  if (oldRule === undefined) {
    return witnessAgainstAny(newRule, pointer);
  }

  // number -> integer 是唯一“同根类型内的收紧”：0 这类整数会被接受，
  // 必须用非整数才能构成反例，故先于类型层面判断处理。
  if (newRule.kind === 'integer' && oldRule.kind === 'number') {
    return {
      pointer,
      message: `新规则在 ${pointer || '""'} 要求 integer，旧 number 规则允许非整数（如 0.5）`,
      value: 0.5,
    };
  }

  const oldKinds = acceptedKinds(oldRule);
  const typed = typeLevelWitness(newRule, oldKinds, pointer);
  if (typed) {
    return typed;
  }

  if (newRule.kind === 'array') {
    // 旧规则必为 array（只有 array 接受 array 类型）；用非空数组体现元素收紧
    const child = deriveWitness(newRule.items, oldRule.kind === 'array' ? oldRule.items : undefined, `${pointer}/0`);
    if (child) {
      // 元素位置的反例包进单元素数组，根值才是旧数组规则接受的 JSON
      return { ...child, value: [child.value] };
    }
    return null;
  }

  if (newRule.kind === 'object') {
    // 旧规则必为 object
    const oldObject = oldRule.kind === 'object' ? oldRule : undefined;

    // 1) 新版必填而旧版允许缺省（旧版无此字段声明，或声明为可选）
    for (const [name, newField] of newRule.fields) {
      const oldField = oldObject ? oldObject.fields.get(name) : undefined;
      if (newField.required && (!oldField || !oldField.required)) {
        const value = oldObject ? seedOldRequired(oldObject, new Set([name])) : {};
        return {
          pointer: pointerChild(pointer, name),
          message: `新规则将字段 ${JSON.stringify(name)} 列为必填（指针 ${pointerChild(pointer, name)}），旧规则允许请求缺省该字段`,
          value,
        };
      }
    }

    // 2) 同名字段：递归比较值集合
    if (oldObject) {
      for (const [name, oldField] of oldObject.fields) {
        const newField = newRule.fields.get(name);
        if (!newField) {
          continue; // 字段删除在第 3 步统一判断
        }
        const child = deriveWitness(newField.rule, oldField.rule, pointerChild(pointer, name));
        if (child) {
          // 包上一层：填齐旧侧其他必填字段，目标字段放入子反例
          const value = seedOldRequired(oldObject, new Set([name]));
          value[name] = child.value;
          return { ...child, value };
        }
      }
    }

    // 3) 旧版允许、新版拒绝的键
    if (!newRule.additionalProperties) {
      if (oldObject) {
        for (const [name, oldField] of oldObject.fields) {
          if (!newRule.fields.has(name)) {
            const value = seedOldRequired(oldObject, new Set([name]));
            value[name] = minimalAcceptedValue(oldField.rule);
            return {
              pointer: pointerChild(pointer, name),
              message: `字段 ${JSON.stringify(name)}（指针 ${pointerChild(pointer, name)}）在旧规则中声明且允许发送，新规则未声明该字段且 additionalProperties 为 false，请求被拒绝`,
              value,
            };
          }
        }
        // 旧规则无字段边界：任意额外键都合法
        if (oldObject.additionalProperties) {
          const value = seedOldRequired(oldObject, new Set());
          let extraName = 'x';
          while (newRule.fields.has(extraName) || Object.prototype.hasOwnProperty.call(value, extraName)) {
            extraName = `x${extraName.length}`;
          }
          value[extraName] = 1;
          return {
            pointer: pointerChild(pointer, extraName),
            message: `旧规则允许未声明的额外字段（additionalProperties 为 true），新规则拒绝；如字段 ${JSON.stringify(extraName)}（指针 ${pointerChild(pointer, extraName)}）`,
            value,
          };
        }
      }
    }

    return null;
  }

  // 新规则为标量（number/string/boolean/null）：能走到这里说明旧接受的
  // 全部根类型都被覆盖（number 已覆盖 integer），无收紧
  return null;
}

function bodyCounterexample(
  method: HttpMethod,
  routePath: string,
  witness: RuleWitness,
): { reason: CompatReason; counterexample: CounterexampleRequest } {
  return {
    reason: {
      code: 'body_rejected',
      pointer: witness.pointer,
      message: witness.message,
    },
    counterexample: {
      method,
      path: routePath,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(witness.value),
    },
  };
}

// 旧接口启用了规则、新接口未启用：移除规则是兼容；
// 旧接口无规则、新接口启用：旧版允许任意正文与媒体类型，判不兼容。
function compareEndpoint(old: EndpointSpec, next: EndpointSpec | undefined): EndpointVerdict {
  if (!next) {
    return {
      method: old.method,
      path: old.path,
      compatible: false,
      reason: {
        code: 'endpoint_not_found',
        pointer: null,
        message: `新版配置中不存在接口 ${old.method} ${old.path}（接口已删除）`,
      },
      counterexample: {
        method: old.method,
        path: old.path,
        headers: {},
        body: '',
      },
    };
  }

  if (!old.bodyRule && next.bodyRule) {
    const witness = witnessAgainstAny(next.bodyRule, '');
    const built = bodyCounterexample(old.method, old.path, witness);
    return {
      method: old.method,
      path: old.path,
      compatible: false,
      reason: {
        code: 'body_rejected',
        pointer: '',
        message:
          '旧接口未配置 requestBody，旧版允许任意正文与媒体类型；新版启用正文规则后，原本可发送的请求被正文检查拒绝。' +
          witness.message,
      },
      counterexample: built.counterexample,
    };
  }

  if (old.bodyRule && next.bodyRule) {
    const witness = deriveWitness(next.bodyRule, old.bodyRule, '');
    if (witness) {
      const built = bodyCounterexample(old.method, old.path, witness);
      return {
        method: old.method,
        path: old.path,
        compatible: false,
        reason: built.reason,
        counterexample: built.counterexample,
      };
    }
  }

  // 双方均无规则，或新版移除了规则：接口存在且接受条件未收紧
  return { method: old.method, path: old.path, compatible: true };
}

function buildCompatReport(oldSpecs: readonly EndpointSpec[], newSpecs: readonly EndpointSpec[]): CompatReport {
  const newIndex = new Map<string, EndpointSpec>();
  for (const spec of newSpecs) {
    newIndex.set(`${spec.method} ${spec.path}`, spec);
  }

  const endpoints = oldSpecs.map((old) => compareEndpoint(old, newIndex.get(`${old.method} ${old.path}`)));
  const incompatible = endpoints.filter((v) => !v.compatible).length;
  return {
    direction: 'old-to-new',
    compatible: incompatible === 0,
    summary: {
      total: endpoints.length,
      compatible: endpoints.length - incompatible,
      incompatible,
    },
    endpoints,
  };
}

async function loadSpecsForCompat(file: string, role: string): Promise<readonly EndpointSpec[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`读取${role}配置文件 ${file} 失败：${describeError(e)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${role}配置文件 ${file} 不是合法 JSON：${describeError(e)}`);
  }
  try {
    return validateConfig(raw);
  } catch (e) {
    throw new Error(`${role}配置文件 ${file} 校验失败：${describeError(e)}`);
  }
}

async function runCompat(oldFile: string, newFile: string): Promise<number> {
  // 两份文件全部读取、解析、严格校验通过后才输出报告；任一失败不输出部分报告
  const oldSpecs = await loadSpecsForCompat(oldFile, '旧');
  const newSpecs = await loadSpecsForCompat(newFile, '新');
  const report = buildCompatReport(oldSpecs, newSpecs);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.compatible ? 0 : 1;
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

// 模块级运行时句柄（启动后赋值）
let activeState: LiveState;
let server: http.Server;
let configFile = '';
let shuttingDown = false;

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
  const headers: { [name: string]: string } = {
    [VERSION_HEADER]: String(version),
  };
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

function sendBusinessResponse(
  res: http.ServerResponse,
  item: ResponseSpec,
  version: number,
): void {
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
  writeResponse(res, item.status, headers, item.body);
}

// 延迟结束才发送；即便客户端提前断开也继续计时（消费在预留时已经成立）
function scheduleBusinessResponse(
  res: http.ServerResponse,
  item: ResponseSpec,
  version: number,
): void {
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    sendBusinessResponse(res, item, version);
  }, item.delay);
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

  const { outcome, body } = await receiveBody(req, res);
  if (outcome !== 'received') {
    // aborted：未完整接收，不匹配、不预留、不推进任何序列
    // too-large：已回复 413
    return;
  }

  const method = String(req.method);
  const pathname = String(req.url ?? '/').split('?')[0]; // 查询串不参与匹配

  // 管理入口（不消费任何业务序列）
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

  // 业务匹配：在本次同步执行内抓取状态快照，预留后与后续 reload 互不影响
  const state = activeState;
  const endpoint =
    method === 'GET' || method === 'POST'
      ? state.endpoints.get(`${method} ${pathname}`)
      : undefined;

  if (!endpoint) {
    sendNotFound(res); // 未匹配请求：404，不消费
    return;
  }

  // 正文结构规则（如有）：校验失败返回 400 差异报告，不发送场景响应、不消费序列。
  // 规则、序列与版本均取自上面同一快照 state。
  if (endpoint.bodyRule) {
    const report = validateRequestBody(req, body, endpoint.bodyRule);
    if (report) {
      sendJson(res, 400, report, state.version);
      return;
    }
  }

  const item = reserveNext(endpoint); // 校验通过后立即预留
  scheduleBusinessResponse(res, item, state.version);
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
    '  node app.ts compat --old <old-file> --new <new-file>',
    '',
    'Options (serve):',
    '  -c, --config <file>   本地 JSON 场景配置文件（必填）',
    '  -p, --port <number>   监听端口，0 表示由操作系统分配（必填）',
    '                        服务仅监听 127.0.0.1',
    '',
    'Options (compat):',
    '  -o, --old <file>      旧版本地场景 JSON 文件（必填）',
    '  -n, --new <file>      新版本地场景 JSON 文件（必填）',
    '                        两份文件均读取、解析并严格校验通过后才输出报告；',
    '                        不启动监听、不修改任何文件。',
    '',
    '  -h, --help            显示本帮助',
    '',
    'compat 报告（stdout，JSON）：固定按旧到新方向，比较接口存在性与请求接受',
    '条件（查询串、响应状态/头/正文/延迟、序列差异均不参与）。兼容退出 0，',
    '存在不兼容接口退出 1，参数/读取/解析/校验失败退出 2（原因写 stderr）。',
    '',
    '管理入口（路径前缀 /__contractlab/ 为业务接口保留区之外的保留前缀）：',
    '  GET  /__contractlab/health   健康查询，返回当前配置版本',
    '  POST /__contractlab/reload   重新读取并热更新同一配置文件',
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

interface CompatOptions {
  oldFile: string;
  newFile: string;
}

function parseCompatArgv(argv: readonly string[]): CompatOptions {
  let oldFile: string | undefined;
  let newFile: string | undefined;

  const readValue = (flag: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) {
      return [inline, index];
    }
    const value = argv[index + 1];
    if (value === undefined) {
      cliFail(`compat: 参数 ${flag} 缺少取值`);
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
      cliFail(`compat: 不支持的命令行参数: ${token}`);
    }
  }

  if (oldFile === undefined) {
    cliFail('compat: 缺少必填参数 --old <file>');
  }
  if (newFile === undefined) {
    cliFail('compat: 缺少必填参数 --new <file>');
  }
  return { oldFile, newFile };
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

  if (argv[0] === 'compat') {
    const options = parseCompatArgv(argv.slice(1));
    runCompat(options.oldFile, options.newFile)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((e: unknown) => {
        process.stderr.write(`${APP_NAME}: compat: ${describeError(e)}\n`);
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

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
// - 管理入口 GET /__contractlab/requests 查询本次进程内的请求记录（一致快照、
//   不推进序列），POST /__contractlab/requests/clear 清空记录；记录只存在内存中，
//   管理范围（/__contractlab 本身及 /__contractlab/ 前缀）的请求一律不记录。
// - compare 子命令：离线比较旧、新两份场景文件，判断沿用旧接口约定的客户端
//   是否仍能调用新版；报告写 stdout，不启动监听、不修改文件。
// - import 子命令：读取本地 OpenAPI 3.0 JSON 与现有场景配置，按“方法 + 字面
//   路径”选择文档操作，仅用操作 requestBody 转换出的正文规则替换各接口的
//   requestBody（保留接口顺序与 responses），新场景 JSON 写 stdout。

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

function validateBodyRule(raw: unknown, where: string): BodyRule {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} 必须是对象（含 "type" 字段）`);
  }

  const type = raw.type;
  const allowed = new Set(['type']);
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
// 返回本次消费位置（0 起）与该项；末项复用时位置停在 length-1。
function reserveNext(endpoint: LiveEndpoint): { position: number; item: ResponseSpec } {
  const last = endpoint.responses.length - 1;
  const position = endpoint.cursor < last ? endpoint.cursor : last;
  if (endpoint.cursor < last) {
    endpoint.cursor += 1;
  }
  return { position, item: endpoint.responses[position] };
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
  // 场景请求在序列中的消费位置（0 起）；400/404 没有消费位置，记为 null
  sequencePosition: number | null;
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
function encodeBodyLosslessly(body: Buffer): { encoding: 'utf-8' | 'base64'; content: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
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

// 生成被规则接受的最小 JSON 值：object 只含必填字段，array 取空数组。
// 字段名可能是 "" 或 "__proto__"，一律用无原型对象按自有字段构造。
function sampleValue(rule: BodyRule): unknown {
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

// 递归判定 L(oldRule) ⊆ L(newRule)；把发现的每个反例（连同完整正文样本）推入 out。
// 不变式：value 必被 oldRule 接受、被 newRule 拒绝；pointer 用 RFC 6901 定位差异。
function collectViolations(
  oldRule: BodyRule,
  newRule: BodyRule,
  pointer: string,
  out: BodyViolation[],
): void {
  if (newRule.kind !== 'object' && newRule.kind !== 'array') {
    // 标量：仅同名兼容，外加 integer 放宽为 number；其余组合两集合相交为空或有差异
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
//   语义为允许，并在输出中显式写出）；title/description/example 与
//   nullable=false 忽略，其余关键字或非法值一律拒绝；
// - 支持本文件内 $ref（按 JSON Pointer 转义解析）：共享引用允许，目标缺失、
//   外部引用与循环引用拒绝并给出引用链；引用节点只含 $ref；
// - 支持纯对象 allOf：组合节点仅含 allOf 与上述注释，分支可引用或嵌套组合，
//   结果取各分支接受集合的交集（同名字段递归相交、number∩integer 取
//   integer、必填合并、各分支额外字段限制同时生效）；空交集或现有规则
//   无法表达时定位原因并拒绝，不扩展规则种类；
// - 未被场景选中的操作与不可达定义不参与转换（其中的错误不影响结果）；
//   全部输入与所选可达定义有效后才输出，成功退出 0，失败退出 2
//   （stderr 指明文件与操作或定义位置，stdout 为空）。

class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

// allOf 交集为空的标记性错误：对象字段合并时，“可选字段的交集为空”在结果
// 拒绝额外字段时可表达为“禁止该字段出现”，只有确实无法表达时才转为拒绝。
class EmptyIntersection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyIntersection';
  }
}

// 转换过程中的规范化规则：与 BodyRule 同构，但 object 的必填名集合单独保存，
// 便于 allOf 交集计算；输出时再展开为场景规则 JSON。
type NormRule =
  | {
      readonly kind: 'object';
      readonly props: ReadonlyMap<string, NormRule>;
      readonly required: ReadonlySet<string>;
      readonly addl: boolean;
    }
  | { readonly kind: 'array'; readonly items: NormRule }
  | { readonly kind: 'string' | 'number' | 'integer' | 'boolean' };

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

// schema（或引用链尽头的 schema）-> 规范化规则
function schemaToNorm(
  rawNode: unknown,
  ctx: ImportCtx,
  where: string,
  refChain: readonly string[],
): NormRule {
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
  const n = node as Record<string, unknown>;

  // nullable 仅允许 false（等同不声明，忽略）；true 属于非法值
  if (hasOwnKey(n, 'nullable') && n.nullable !== false) {
    importFail(ctx, `${nodeWhere}.nullable`, `仅支持 false（或不声明），收到 ${JSON.stringify(n.nullable)}`);
  }

  if (hasOwnKey(n, 'allOf')) {
    for (const key of Object.keys(n)) {
      if (key !== 'allOf' && !OPENAPI_ANNOTATION_KEYS.has(key)) {
        importFail(
          ctx,
          nodeWhere,
          `组合节点仅允许 allOf 及注释（title/description/example/nullable），含未支持的关键字 "${key}"`,
        );
      }
    }
    const list = n.allOf;
    if (!Array.isArray(list) || list.length === 0) {
      importFail(ctx, `${nodeWhere}.allOf`, '必须是非空数组');
    }
    const branches = (list as unknown[]).map((branch, i) =>
      schemaToNorm(branch, ctx, `${nodeWhere}.allOf[${i}]`, chain),
    );
    for (let i = 0; i < branches.length; i += 1) {
      const branch = branches[i] as NormRule;
      if (branch.kind !== 'object') {
        importFail(
          ctx,
          `${nodeWhere}.allOf[${i}]`,
          `仅支持纯对象 allOf 组合，该分支最终类型为 ${branch.kind}`,
        );
      }
    }
    return mergeObjectNorms(branches as NormObject[], ctx, nodeWhere);
  }

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
        : [];
  for (const key of Object.keys(n)) {
    if (key !== 'type' && !OPENAPI_ANNOTATION_KEYS.has(key) && !structural.includes(key)) {
      importFail(ctx, nodeWhere, `含未支持的关键字 "${key}"`);
    }
  }

  if (type === 'array') {
    if (!hasOwnKey(n, 'items')) {
      importFail(ctx, `${nodeWhere}.items`, '数组 schema 必须声明元素规则 items');
    }
    return { kind: 'array', items: schemaToNorm(n.items, ctx, `${nodeWhere}.items`, chain) };
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
    return { kind: 'object', props, required: new Set(requiredList), addl: addlRaw !== false };
  }

  return { kind: type as 'string' | 'number' | 'integer' | 'boolean' };
}

// 两个规范化规则的交集；交集为空抛 EmptyIntersection，现有规则种类无法表达
// 时抛 ImportError。
function intersectNorms(a: NormRule, b: NormRule, ctx: ImportCtx, where: string): NormRule {
  if (a.kind === 'object' && b.kind === 'object') {
    return mergeObjectNorms([a, b], ctx, where);
  }
  if (a.kind === 'array' && b.kind === 'array') {
    try {
      return { kind: 'array', items: intersectNorms(a.items, b.items, ctx, `${where}.items`) };
    } catch (e) {
      if (e instanceof EmptyIntersection) {
        throw new ImportError(
          importErrorMessage(
            ctx,
            where,
            `数组元素规则交集为空（${e.message}），交集结果仅含空数组，现有规则种类无法表达`,
          ),
        );
      }
      throw e;
    }
  }
  if (a.kind === 'object' || a.kind === 'array' || b.kind === 'object' || b.kind === 'array') {
    throw new EmptyIntersection(`类型 ${a.kind} 与 ${b.kind} 没有共同接受的值`);
  }
  if (a.kind === b.kind) {
    return a;
  }
  // number 与 integer 相交取 integer；其余标量组合交集为空
  if (
    (a.kind === 'number' && b.kind === 'integer') ||
    (a.kind === 'integer' && b.kind === 'number')
  ) {
    return { kind: 'integer' };
  }
  throw new EmptyIntersection(`类型 ${a.kind} 与 ${b.kind} 没有共同接受的值`);
}

// 纯对象 allOf 的交集：结果接受集合 = 各分支接受集合的交集。
// - 字段可出现的条件：在每个分支中都已声明，或该分支允许额外字段；
//   必填字段若被某分支禁止出现，则交集为空；
// - 同名字段递归相交（number∩integer 取 integer）；必填取并集；
// - 结果的 additionalProperties 为各分支的合取（任一分支拒绝则拒绝）；
// - 可选字段交集为空且结果拒绝额外字段时，不声明该字段即“禁止出现”，
//   集合语义不变；结果允许额外字段时无法表达，拒绝。
function mergeObjectNorms(
  branches: readonly NormObject[],
  ctx: ImportCtx,
  where: string,
): NormObject {
  const addl = branches.every((b) => b.addl);
  const props = new Map<string, NormRule>();
  const required = new Set<string>();

  const names: string[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    for (const name of branch.props.keys()) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }

  for (const name of names) {
    const fieldWhere = `${where}.properties[${JSON.stringify(name)}]`;
    const isRequired = branches.some((b) => b.required.has(name));
    const permitted = branches.every((b) => b.props.has(name) || b.addl);
    if (!permitted) {
      // 该字段在交集中禁止出现：不声明即可表达（此时必有分支 addl=false，
      // 结果 addl 必为 false）
      if (isRequired) {
        throw new EmptyIntersection(
          `字段 ${JSON.stringify(name)} 在部分分支中为必填，但被另一分支禁止出现（未声明且 additionalProperties 为 false），交集为空`,
        );
      }
      continue;
    }
    let merged: NormRule | undefined;
    for (const branch of branches) {
      const sub = branch.props.get(name);
      if (sub === undefined) {
        continue;
      }
      if (merged === undefined) {
        merged = sub;
        continue;
      }
      try {
        merged = intersectNorms(merged, sub, ctx, fieldWhere);
      } catch (e) {
        if (e instanceof EmptyIntersection) {
          if (isRequired) {
            throw new EmptyIntersection(
              `必填字段 ${JSON.stringify(name)} 的各分支规则交集为空：${e.message}`,
            );
          }
          if (addl) {
            throw new ImportError(
              importErrorMessage(
                ctx,
                fieldWhere,
                `各分支规则交集为空（${e.message}），且所有分支都允许额外字段，现有规则种类无法表达“禁止该字段出现”`,
              ),
            );
          }
          // 可选字段交集为空且结果拒绝额外字段：不声明该字段即“禁止出现”
          merged = undefined;
          break;
        }
        throw e;
      }
    }
    if (merged !== undefined) {
      props.set(name, merged);
      if (isRequired) {
        required.add(name);
      }
    }
  }

  return { kind: 'object', props, required, addl };
}

// 规范化规则 -> 场景规则 JSON（object 显式写出 fields 与 additionalProperties；
// 字段名可能是 ""/"__proto__"/含斜杠波浪号，一律用无原型对象按自有字段构造）
function normToRuleJson(rule: NormRule): Record<string, unknown> {
  switch (rule.kind) {
    case 'object': {
      const fields: Record<string, unknown> = Object.create(null);
      for (const [name, sub] of rule.props) {
        const subJson = normToRuleJson(sub);
        fields[name] = rule.required.has(name) ? { ...subJson, required: true } : subJson;
      }
      return { type: 'object', fields, additionalProperties: rule.addl };
    }
    case 'array':
      return { type: 'array', items: normToRuleJson(rule.items) };
    default:
      return { type: rule.kind };
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
    const ep = epRaw as { method: HttpMethod; path: string; responses: unknown };
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
    // 仅替换 requestBody：保留接口顺序与 responses 原文
    const out: { method: string; path: string; requestBody?: unknown; responses: unknown } = {
      method: ep.method,
      path: ep.path,
      responses: ep.responses,
    };
    if (rule !== undefined) {
      out.requestBody = rule;
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
  if (endpoint.bodyRule) {
    const report = validateRequestBody(req, body, endpoint.bodyRule);
    if (report) {
      record.bodyValidationPassed = false;
      record.bodyRejection = report;
      const planned = buildFrameworkPlanned(
        400,
        state.version,
        `${JSON.stringify(report)}\n`,
        'application/json; charset=utf-8',
      );
      record.plannedResponse = planned;
      writePlanned(res, planned, record.id);
      return;
    }
    record.bodyValidationPassed = true;
  }

  // 校验通过（或无规则）：立即预留，并把消费位置与场景计划响应记入同一条记录
  const { position, item } = reserveNext(endpoint);
  record.sequencePosition = position;
  record.sequenceLength = endpoint.responses.length;
  const planned = buildScenePlanned(item, state.version);
  record.plannedResponse = planned;
  schedulePlannedResponse(res, planned, item.delay, record.id);
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

  // 不支持的命令行参数：报错并以状态码 2 退出
  process.stderr.write(`${APP_NAME}: 不支持的命令行参数: ${argv.join(' ')}\n`);
  process.stderr.write(`运行 'node app.ts --help' 查看用法。\n`);
  process.exit(2);
}

main();

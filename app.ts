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
//   完成时不会推进新序列。
// - POST 接口可附加可选的 requestBody 正文结构规则：请求完整接收后先校验
//   媒体类型（application/json，忽略大小写、可带参数）、JSON 解析与结构；
//   失败返回 400 差异报告，不发送场景响应、不消费响应序列；校验通过才预留。

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

// 请求正文结构规则（仅 POST 接口可声明；递归声明）
type PrimitiveKind = 'string' | 'number' | 'integer' | 'boolean' | 'null';

type BodyRule =
  | {
      readonly kind: 'object';
      readonly fields: ReadonlyMap<string, FieldRule>;
      // 是否允许未声明字段（默认拒绝）
      readonly additional: boolean;
    }
  | { readonly kind: 'array'; readonly items: BodyRule }
  | { readonly kind: PrimitiveKind };

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
  readonly requestBody?: BodyRule;
}

interface LiveEndpoint {
  readonly key: string;
  readonly responses: readonly ResponseSpec[];
  readonly requestBody?: BodyRule;
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

const RULE_KINDS = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

// 解析一条正文规则；allowRequired 仅在对象字段声明位置为 true
function parseBodyRule(raw: unknown, where: string, allowRequired: boolean): FieldRule {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where} 必须是对象（正文规则声明）`);
  }
  for (const key of Object.keys(raw)) {
    const known =
      key === 'type' ||
      key === 'fields' ||
      key === 'additionalFields' ||
      key === 'items' ||
      (key === 'required' && allowRequired);
    if (!known) {
      throw new ConfigError(
        key === 'required'
          ? `${where}.required 仅对象字段声明中可用`
          : `${where} 含未知字段 "${key}"`,
      );
    }
  }

  const t = raw.type;
  if (typeof t !== 'string' || !RULE_KINDS.has(t)) {
    throw new ConfigError(
      `${where}.type 必须是 "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"，` +
        `收到 ${JSON.stringify(t)}`,
    );
  }

  let required = false;
  if (allowRequired && 'required' in raw) {
    if (typeof raw.required !== 'boolean') {
      throw new ConfigError(`${where}.required 必须是布尔值`);
    }
    required = raw.required;
  }

  const rejectMisplaced = (key: string): void => {
    if (key in raw) {
      throw new ConfigError(`${where}.${key} 与 type "${t}" 不匹配`);
    }
  };

  switch (t) {
    case 'object': {
      rejectMisplaced('items');
      const rawFields = raw.fields;
      if (rawFields !== undefined && !isPlainObject(rawFields)) {
        throw new ConfigError(`${where}.fields 必须是对象（字段名 -> 规则）`);
      }
      const additional = raw.additionalFields;
      if (additional !== undefined && typeof additional !== 'boolean') {
        throw new ConfigError(`${where}.additionalFields 必须是布尔值`);
      }
      const fields = new Map<string, FieldRule>();
      for (const [name, sub] of Object.entries(rawFields ?? {})) {
        if (name === '') {
          throw new ConfigError(`${where}.fields 含空字段名`);
        }
        fields.set(name, parseBodyRule(sub, `${where}.fields[${JSON.stringify(name)}]`, true));
      }
      return { rule: { kind: 'object', fields, additional: additional ?? false }, required };
    }
    case 'array': {
      rejectMisplaced('fields');
      rejectMisplaced('additionalFields');
      if (!('items' in raw)) {
        throw new ConfigError(`${where}.items 缺失：数组规则必须声明元素规则`);
      }
      const items = parseBodyRule(raw.items, `${where}.items`, false);
      return { rule: { kind: 'array', items: items.rule }, required };
    }
    default: {
      rejectMisplaced('fields');
      rejectMisplaced('additionalFields');
      rejectMisplaced('items');
      return { rule: { kind: t as PrimitiveKind }, required };
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

  const { method, path: routePath, responses } = raw;

  if (method !== 'GET' && method !== 'POST') {
    throw new ConfigError(`${where}.method 必须是 "GET" 或 "POST"，收到 ${JSON.stringify(method)}`);
  }

  let requestBody: BodyRule | undefined;
  if ('requestBody' in raw) {
    if (method !== 'POST') {
      throw new ConfigError(`${where}.requestBody 仅 POST 接口可声明请求正文规则`);
    }
    requestBody = parseBodyRule(raw.requestBody, `${where}.requestBody`, false).rule;
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

  return { method, path: routePath, responses: cleanResponses, requestBody };
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
      requestBody: spec.requestBody,
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
// 请求正文校验：媒体类型 -> UTF-8 JSON 解析 -> 结构比对
// ---------------------------------------------------------------------------

interface BodyProblem {
  readonly pointer: string;
  readonly expected: string;
  readonly actual: string;
}

interface BodyRejection {
  readonly error: string;
  readonly phase: 'content-type' | 'parse' | 'structure';
  readonly problems: readonly BodyProblem[];
}

function jsonTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

// JSON Pointer（RFC 6901）段转义：~ -> ~0，/ -> ~1
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

// 结构比对：父节点类型不符时只报告该节点，不再深入制造子节点错误；
// 合法 JSON null 是“存在的值”，与字段缺失分开判断。
function validateBodyValue(
  rule: BodyRule,
  value: unknown,
  pointer: string,
  problems: BodyProblem[],
): void {
  switch (rule.kind) {
    case 'object': {
      if (!isPlainObject(value)) {
        problems.push({ pointer, expected: 'object', actual: jsonTypeName(value) });
        return;
      }
      for (const [name, field] of rule.fields) {
        const childPointer = `${pointer}/${escapePointerSegment(name)}`;
        if (Object.prototype.hasOwnProperty.call(value, name)) {
          validateBodyValue(field.rule, value[name], childPointer, problems);
        } else if (field.required) {
          // 缺失字段：指针指向该字段本身
          problems.push({ pointer: childPointer, expected: field.rule.kind, actual: 'missing' });
        }
      }
      if (!rule.additional) {
        for (const key of Object.keys(value)) {
          if (!rule.fields.has(key)) {
            // 额外字段：指针指向其自身
            problems.push({
              pointer: `${pointer}/${escapePointerSegment(key)}`,
              expected: 'undeclared field (absent)',
              actual: jsonTypeName(value[key]),
            });
          }
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        problems.push({ pointer, expected: 'array', actual: jsonTypeName(value) });
        return;
      }
      for (let i = 0; i < value.length; i += 1) {
        validateBodyValue(rule.items, value[i], `${pointer}/${i}`, problems);
      }
      return;
    }
    case 'string':
      if (typeof value !== 'string') {
        problems.push({ pointer, expected: 'string', actual: jsonTypeName(value) });
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push({ pointer, expected: 'number', actual: jsonTypeName(value) });
      }
      return;
    case 'integer':
      if (!Number.isInteger(value)) {
        problems.push({ pointer, expected: 'integer', actual: jsonTypeName(value) });
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        problems.push({ pointer, expected: 'boolean', actual: jsonTypeName(value) });
      }
      return;
    case 'null':
      if (value !== null) {
        problems.push({ pointer, expected: 'null', actual: jsonTypeName(value) });
      }
      return;
  }
}

// 返回 null 表示通过；否则为可直接序列化的 400 差异报告
function checkRequestBody(
  req: http.IncomingMessage,
  body: Buffer,
  rule: BodyRule,
): BodyRejection | null {
  const rawContentType = req.headers['content-type'];
  const contentType = Array.isArray(rawContentType) ? rawContentType.join(', ') : rawContentType;
  // 忽略大小写匹配 application/json，允许携带 ; 参数
  const mediaType =
    typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
  if (mediaType !== 'application/json') {
    return {
      error: 'request body rejected',
      phase: 'content-type',
      problems: [
        {
          pointer: '',
          expected: 'Content-Type: application/json（可带参数，大小写不敏感）',
          actual: contentType === undefined ? '(未提供 Content-Type 头)' : contentType,
        },
      ],
    };
  }

  if (body.length === 0) {
    return {
      error: 'request body rejected',
      phase: 'parse',
      problems: [{ pointer: '', expected: 'UTF-8 JSON 文档', actual: '空正文' }],
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch (e) {
    return {
      error: 'request body rejected',
      phase: 'parse',
      problems: [{ pointer: '', expected: '合法 JSON', actual: describeError(e) }],
    };
  }

  const problems: BodyProblem[] = [];
  validateBodyValue(rule, value, '', problems);
  if (problems.length > 0) {
    return { error: 'request body rejected', phase: 'structure', problems };
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
    // 配置中允许声明 X-Contractlab-Version（任意大小写），但发送时忽略其值，
    // 保证响应只携带一个由服务器给出的准确版本头
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

interface ReceiveResult {
  readonly outcome: BodyOutcome;
  readonly body: Buffer;
}

// 完整接收请求体；未完整接收即断开返回 'aborted'（调用方不得推进序列）
function receiveBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<ReceiveResult> {
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
      if (settled) {
        return;
      }
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

  const received = await receiveBody(req, res);
  if (received.outcome !== 'received') {
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

  // 启用了正文规则的接口：校验失败返回 400 差异报告，
  // 不发送场景响应、不消费响应序列；规则与序列、版本取自同一快照 state
  if (endpoint.requestBody) {
    const rejection = checkRequestBody(req, received.body, endpoint.requestBody);
    if (rejection) {
      sendJson(res, 400, rejection, state.version);
      return;
    }
  }

  const item = reserveNext(endpoint); // 校验通过（或无需校验）后立即预留
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
    '',
    'Options (serve):',
    '  -c, --config <file>   本地 JSON 场景配置文件（必填）',
    '  -p, --port <number>   监听端口，0 表示由操作系统分配（必填）',
    '                        服务仅监听 127.0.0.1',
    '  -h, --help            显示本帮助',
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

  // 不支持的命令行参数：报错并以状态码 2 退出
  process.stderr.write(`${APP_NAME}: 不支持的命令行参数: ${argv.join(' ')}\n`);
  process.stderr.write(`运行 'node app.ts --help' 查看用法。\n`);
  process.exit(2);
}

main();

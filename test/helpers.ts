// 测试共享工具：子进程运行 compare、启动真实服务、发送真实 HTTP 请求、临时目录，
// 以及一套**独立**的“规则是否接受某 JSON 值”参考实现与有限代表值域生成器。
//
// 重要：accepts() / domainFor() 仅依据 README.md 记录的规则语义编写，
// 不 import、不复制 app.ts 中的校验、比较或反例构造函数，
// 用以为 compare 报告提供独立的期望值来源。

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

export const APP_PATH = fileURLToPath(new URL('../app.ts', import.meta.url));

// ---------------------------------------------------------------------------
// 子进程：运行 CLI（compare 等），带有限超时——卡住必须在有限时间内失败
// ---------------------------------------------------------------------------

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCli(args: readonly string[], timeoutMs = 20_000): Promise<CliResult> {
  const child = spawn(process.execPath, [APP_PATH, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const [code, signal] = (await once(child, 'exit')) as [number | null, string | null];
  clearTimeout(timer);

  if (timedOut) {
    throw new Error(
      `命令超过 ${timeoutMs}ms 未结束（疑似卡住），已强制终止：node app.ts ${args.join(' ')}`,
    );
  }
  if (code === null) {
    throw new Error(
      `子进程异常终止（信号 ${signal}）：node app.ts ${args.join(' ')}\nstderr:\n${stderr}`,
    );
  }
  return { code, stdout, stderr };
}

export function runCompare(oldFile: string, newFile: string, timeoutMs = 20_000): Promise<CliResult> {
  return runCli(['compare', '--old', oldFile, '--new', newFile], timeoutMs);
}

// ---------------------------------------------------------------------------
// 真实本机服务：端口 0 由操作系统分配，解析启动日志得到实际监听地址，
// 不依赖固定端口，也不依赖固定等待时间（事件驱动，超时兜底）。
// ---------------------------------------------------------------------------

export interface RunningServer {
  readonly port: number;
  readonly stderr: () => string;
  readonly close: () => Promise<void>;
}

export async function startServer(configPath: string, timeoutMs = 20_000): Promise<RunningServer> {
  return spawnServerWith(['serve', '--config', configPath, '--port', '0'], timeoutMs);
}

// 更底层的服务启动：自定义 serve 参数（如 --requests-file），并暴露子进程句柄，
// 便于测试主动发信号（SIGTERM/SIGKILL）、等待退出与读取退出码。
// 未在超时内输出监听地址（例如启动前拒绝启动）时 reject。
export interface SpawnedServer extends RunningServer {
  readonly pid: number | undefined;
  stdout(): string;
  send(signal: NodeJS.Signals): void;
  waitExit(): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

export async function spawnServerWith(
  args: readonly string[],
  timeoutMs = 20_000,
): Promise<SpawnedServer> {
  const child = spawn(process.execPath, [APP_PATH, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));

  const exitPromise = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;

  const port = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const fail = (e: Error): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(e);
      }
    };
    const timer = setTimeout(() => {
      fail(
        new Error(
          `服务 ${timeoutMs}ms 内未输出监听地址（疑似卡住）\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);
    child.stdout.on('data', () => {
      const m = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code, signal) => {
      fail(new Error(`服务在监听前退出（code=${code} signal=${signal}）\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });

  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exitPromise.catch(() => undefined);
    clearTimeout(force);
  };

  return {
    port,
    pid: child.pid,
    stdout: () => stdout,
    stderr: () => stderr,
    send: (signal) => child.kill(signal),
    waitExit: async () => {
      const [code, signal] = await exitPromise;
      return { code, signal };
    },
    close,
  };
}

// 带持久记录文件的服务：等价于 serve --config <cfg> --port 0 --requests-file <file>
export function startPersistentServer(
  configPath: string,
  requestsFile: string,
  timeoutMs = 20_000,
): Promise<SpawnedServer> {
  return spawnServerWith(
    ['serve', '--config', configPath, '--port', '0', '--requests-file', requestsFile],
    timeoutMs,
  );
}

// ---------------------------------------------------------------------------
// 真实 HTTP 请求：把报告给出的完整请求（方法/路径/头/正文）原样发出
// ---------------------------------------------------------------------------

export interface RawRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: { readonly [name: string]: string };
  readonly body: string;
}

export interface RawResponse {
  readonly status: number;
  readonly body: string;
}

export function sendRequest(port: number, req: RawRequest, timeoutMs = 10_000): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method: req.method, path: req.path, headers: req.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (d: string) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on('error', reject);
    r.setTimeout(timeoutMs, () => {
      r.destroy(new Error(`请求 ${timeoutMs}ms 内未完成（疑似卡住）：${req.method} ${req.path}`));
    });
    if (req.body !== '') {
      r.write(req.body);
    }
    r.end();
  });
}

// ---------------------------------------------------------------------------
// 独立临时目录与配置文件：每个用例互不影响，无论成败均清理
// ---------------------------------------------------------------------------

export async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'contractlab-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function writeConfig(dir: string, name: string, value: unknown): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return p;
}

export async function writeText(
  dir: string,
  name: string,
  text: string,
): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, text, 'utf8');
  return p;
}

// 场景中统一使用的可辨认成功响应：状态码与正文都足够独特，
// 不会与 400 校验拒绝或 404 接口缺失混淆。
export const SCENE_STATUS = 299;
export const SCENE_BODY = 'contractlab-scene-success';

export function sceneResponse(): { status: number; headers: Record<string, never>; body: string; delay: number } {
  return { status: SCENE_STATUS, headers: {}, body: SCENE_BODY, delay: 0 };
}

// ---------------------------------------------------------------------------
// 独立参考实现：按 README 记录的规则语义判断“规则是否接受某 JSON 值”
// ---------------------------------------------------------------------------

export interface RuleJson {
  readonly type: string;
  readonly nullable?: boolean;
  readonly enum?: readonly unknown[];
  readonly fields?: { readonly [name: string]: RuleJson & { readonly required?: boolean } };
  readonly additionalProperties?: boolean;
  readonly items?: RuleJson;
  readonly required?: boolean;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 标量类型的取值是否通过枚举候选（数字按数值相等，0 与 -0 等价，不做类型转换）
function enumAccepts(rule: RuleJson, value: unknown): boolean {
  return rule.enum === undefined || rule.enum.some((candidate) => candidate === value);
}

export function accepts(rule: RuleJson, value: unknown): boolean {
  // nullable:true 在原接受集合上加入 null；null 被接受时不产生子节点差异；
  // 有枚举时可空不越过枚举：null 仍须列入候选才被接受
  if (value === null && rule.nullable === true) {
    return enumAccepts(rule, null);
  }
  switch (rule.type) {
    case 'string':
      return typeof value === 'string' && enumAccepts(rule, value);
    case 'boolean':
      return typeof value === 'boolean' && enumAccepts(rule, value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && enumAccepts(rule, value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && enumAccepts(rule, value);
    case 'array':
      return Array.isArray(value) && value.every((item) => accepts(rule.items as RuleJson, item));
    case 'object': {
      if (!isPlainJsonObject(value)) {
        return false;
      }
      const fields = rule.fields ?? {};
      for (const [name, fieldRule] of Object.entries(fields)) {
        const has = Object.prototype.hasOwnProperty.call(value, name);
        if (!has) {
          if (fieldRule.required === true) {
            return false;
          }
        } else if (!accepts(fieldRule, value[name])) {
          return false;
        }
      }
      if (rule.additionalProperties !== true) {
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(fields, key)) {
            return false;
          }
        }
      }
      return true;
    }
    default:
      throw new Error(`参考实现遇到未知规则类型: ${JSON.stringify(rule.type)}`);
  }
}

// ---------------------------------------------------------------------------
// 有限代表值域
// ---------------------------------------------------------------------------
//
// 设计目标：对本测试矩阵中的每一对（旧规则, 新规则），只要二者接受的 JSON
// 值集合不同，域中就存在一个见证值。为此域必须区分：
// - 整数与非整数（0/1 与 0.5）：区分 integer 与 number 的双向变化；
// - 字段缺失与 null（删除变体 与 显式 null）：区分“必填缺失”与“类型为 null”；
// - 空数组与非空数组（[] 与 [v]）：元素规则收紧在空数组上不可见；
// - 已声明字段与未声明额外字段（zz_extra）：区分 additionalProperties 两种策略；
// - 对象与数组的嵌套（递归到 MAX_DEPTH 层）。
//
// 构造方式（对每层对象规则）：
// - 标量代表值全集；
// - 空数组，以及元素代表值构成的单元素数组（若任一规则声明了数组元素规则，
//   元素域递归生成，否则用标量）；
// - 空对象、仅含额外字段的对象；
// - “基对象”：两规则声明字段的并集各取一个双方（退化为旧方）都接受的值，
//   再叠加额外字段；随后对每个字段做“删除”与“逐代表值替换”变体。
// 这样，新增必填字段由删除变体见证、字段类型收紧由替换变体见证、
// additionalProperties 收紧由叠加额外字段的对象见证、嵌套收紧由递归域见证。
//
// 注意：这只是针对本矩阵所测规则对的充分见证域，不构成对任意递归规则
// 包含关系的证明；矩阵中每条用例的期望都来自该域的穷举结果。

const MAX_DEPTH = 2;

// 标量代表值：覆盖 string（含空串）、整数、非整数、boolean、null
const SCALAR_REPS: readonly unknown[] = ['txt', '', 0, 1, 0.5, true, false, null];

type FieldMap = { readonly [name: string]: RuleJson & { readonly required?: boolean } };

function objectFields(rule: RuleJson | undefined): FieldMap {
  return rule !== undefined && rule.type === 'object' ? (rule.fields ?? {}) : {};
}

function pickBase(
  subDomain: readonly unknown[],
  oldField: RuleJson | undefined,
  newField: RuleJson | undefined,
): unknown {
  const ok = (rule: RuleJson | undefined, v: unknown): boolean =>
    rule === undefined || accepts(rule, v);
  // 优先选双方规则都接受的值（基对象尽量是“好公民”），退化为旧规则接受，再退化为首元素
  return (
    subDomain.find((v) => ok(oldField, v) && ok(newField, v)) ??
    subDomain.find((v) => ok(oldField, v)) ??
    subDomain[0]
  );
}

export function domainFor(
  oldRule: RuleJson | undefined,
  newRule: RuleJson | undefined,
  depth = 0,
): unknown[] {
  const values: unknown[] = [...SCALAR_REPS];
  if (depth >= MAX_DEPTH) {
    values.push([], {});
    return values;
  }

  // 数组：空数组 + 元素代表值的单元素数组
  values.push([]);
  const itemOld = oldRule !== undefined && oldRule.type === 'array' ? oldRule.items : undefined;
  const itemNew = newRule !== undefined && newRule.type === 'array' ? newRule.items : undefined;
  const itemDomain =
    itemOld !== undefined || itemNew !== undefined
      ? domainFor(itemOld, itemNew, depth + 1)
      : SCALAR_REPS;
  for (const v of itemDomain) {
    values.push([v]);
  }

  // 对象：空对象、额外字段对象、基对象及其删除/替换变体
  const fieldsOld = objectFields(oldRule);
  const fieldsNew = objectFields(newRule);
  const names = [...new Set([...Object.keys(fieldsOld), ...Object.keys(fieldsNew)])];
  let extra = 'zz_extra';
  while (names.includes(extra)) {
    extra = `${extra}_x`;
  }
  values.push({}, { [extra]: 0 }, { [extra]: 'txt' });

  if (names.length > 0) {
    const subDomains = new Map<string, unknown[]>();
    const base: Record<string, unknown> = {};
    for (const name of names) {
      const sd = domainFor(fieldsOld[name], fieldsNew[name], depth + 1);
      subDomains.set(name, sd);
      base[name] = pickBase(sd, fieldsOld[name], fieldsNew[name]);
    }
    values.push(base, { ...base, [extra]: 0 }, { ...base, [extra]: 'txt' });
    for (const name of names) {
      const deleted = { ...base };
      delete deleted[name];
      values.push(deleted);
      for (const v of subDomains.get(name) as unknown[]) {
        if (!Object.is(v, base[name])) {
          values.push({ ...base, [name]: v });
        }
      }
    }
  }

  return values;
}

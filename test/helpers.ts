// 测试公共工具：子进程拉起（带有限超时）、真实本机服务、HTTP 请求、临时文件，
// 以及**测试侧独立实现**的规则语义（accepts）与有限代表值域（pairDomain）。
//
// 重要约定：accepts / pairDomain / domainInclusive 只依据 README 描述的规则语义
// 在测试侧独立实现，不 import、不调用产品（app.ts）的校验、比较或反例构造函数，
// 以免用被测实现自己证明自己。

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_PATH = fileURLToPath(new URL('../app.ts', import.meta.url));

// 所有等待都有上限：比较或服务一旦卡住，会在有限时间内表现为测试失败而非挂起。
export const PROCESS_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// 运行子进程并收集输出；超过 timeoutMs 未退出则 SIGKILL 并标记 timedOut。
export function runProcess(
  args: readonly string[],
  timeoutMs = PROCESS_TIMEOUT_MS,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export function runCompare(
  oldFile: string,
  newFile: string,
  timeoutMs = PROCESS_TIMEOUT_MS,
): Promise<RunResult> {
  return runProcess([APP_PATH, 'compare', '--old', oldFile, '--new', newFile], timeoutMs);
}

// ---------------------------------------------------------------------------
// 真实本机服务：端口 0 由操作系统分配，解析启动日志中的实际监听地址后继续
// ---------------------------------------------------------------------------

export interface RunningService {
  port: number;
  close: () => Promise<void>;
}

export async function startService(
  configFile: string,
  timeoutMs = PROCESS_TIMEOUT_MS,
): Promise<RunningService> {
  const child: ChildProcess = spawn(
    process.execPath,
    [APP_PATH, 'serve', '--config', configFile, '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  let settled = false;
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`服务启动超时（${timeoutMs}ms）：${stdout}${stderr}`));
      }
    }, timeoutMs);
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      const match = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`服务在就绪前退出（code=${code}）：${stdout}${stderr}`));
      }
    });
  });

  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill('SIGTERM'); // 服务实现保证 SIGTERM 后正常退出
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await once(child, 'exit');
    } finally {
      clearTimeout(killer);
    }
  };
  return { port, close };
}

// ---------------------------------------------------------------------------
// HTTP 请求：把报告给出的完整请求反例原样发送
// ---------------------------------------------------------------------------

export interface ExampleRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export function sendExample(
  port: number,
  example: ExampleRequest,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: example.method,
        path: example.path,
        headers: example.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`请求超时（${timeoutMs}ms）：${example.method} ${example.path}`)),
    );
    req.on('error', reject);
    if (example.body !== '') {
      req.write(example.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 临时文件：每个测试独立目录，结束（无论成败）统一清理
// ---------------------------------------------------------------------------

interface TestContext {
  after: (fn: () => unknown) => void;
}

export async function makeTempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'contractlab-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// value 为字符串时按原文写入（用于手写 JSON / 非法 JSON），否则序列化。
export async function writeConfig(dir: string, name: string, value: unknown): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return file;
}

// ---------------------------------------------------------------------------
// 独立规则语义（测试侧实现）
// ---------------------------------------------------------------------------

export interface RuleJson {
  type?: string;
  fields?: Record<string, RuleJson & { required?: boolean }>;
  additionalProperties?: boolean;
  items?: RuleJson;
  required?: boolean;
}

// 按 README 的规则语义判断值是否被接受；rule 为 undefined 表示“未声明、取值自由”
// （仅用于代表值域构造中一侧未声明的位置，不对应任何产品行为）。
export function accepts(rule: RuleJson | undefined, value: unknown): boolean {
  if (rule === undefined) {
    return true;
  }
  switch (rule.type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'array':
      return Array.isArray(value) && value.every((item) => accepts(rule.items, item));
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
      }
      const fields = rule.fields ?? {};
      const allowAdditional = rule.additionalProperties === true;
      const record = value as Record<string, unknown>;
      for (const [name, fieldRule] of Object.entries(fields)) {
        if (!Object.prototype.hasOwnProperty.call(record, name)) {
          if (fieldRule.required === true) {
            return false;
          }
        } else if (!accepts(fieldRule, record[name])) {
          return false;
        }
      }
      if (!allowAdditional) {
        for (const key of Object.keys(record)) {
          if (!Object.prototype.hasOwnProperty.call(fields, key)) {
            return false;
          }
        }
      }
      return true;
    }
    default:
      throw new Error(`未知规则类型：${JSON.stringify(rule)}`);
  }
}

// ---------------------------------------------------------------------------
// 有限代表值域
// ---------------------------------------------------------------------------
//
// 标量代表值：每种 JSON 标量类型各取代表，且 number/integer 之间用
// 0（整数）与 0.5（非整数）区分 —— 对本规则语言中的 5 种标量类型，
// 这 5 个值的接受/拒绝组合恰好一一对应 5 种类型（integer 接受 {0}、
// number 接受 {0, 0.5}，其余各接受唯一代表），因此任意两种标量规则的
// 接受差集非空时，差集中必有代表值。
const SCALAR_VALUES: readonly unknown[] = ['s', 0, 0.5, true, null];

// 规则组保持小型，组合数远超此上限说明规则组设计失控（确定性报错而非截断）。
const MAX_OBJECT_COMBOS = 1000;

// 构造能区分 a、b 两条规则接受差异的有限代表值集（确定性）：
// - 任何位置都放入 5 个标量代表值；
// - 任一侧为 object：对每个双方声明的字段取“缺省 + 字段对域中的每个值”
//   （缺省与 null 都被覆盖，null 在标量代表值中），再叠加一个双方都未声明的
//   额外字段（缺省 / 0 / "s"）做笛卡尔积，另补非对象形状 [];
// - 任一侧为 array：放入空数组 []、以元素对域中每个值构造的单元素非空数组，
//   另补非数组形状 {}。
export function pairDomain(a: RuleJson | undefined, b: RuleJson | undefined): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    const key = JSON.stringify(value) ?? '<unserializable>';
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  };

  for (const scalar of SCALAR_VALUES) {
    add(scalar);
  }

  const aObj = a?.type === 'object';
  const bObj = b?.type === 'object';
  const aArr = a?.type === 'array';
  const bArr = b?.type === 'array';

  if (aObj || bObj) {
    add([]); // 非对象形状
    const names = new Set<string>();
    for (const rule of [a, b]) {
      if (rule?.type === 'object' && rule.fields) {
        for (const name of Object.keys(rule.fields)) {
          names.add(name);
        }
      }
    }
    if (names.has('zz_extra')) {
      throw new Error('规则组不得声明保留字段名 zz_extra');
    }
    const ABSENT: unique symbol = Symbol('absent');
    const slots: { name: string; values: unknown[] }[] = [...names].map((name) => ({
      name,
      values: [
        ABSENT,
        ...pairDomain(
          aObj ? a?.fields?.[name] : undefined,
          bObj ? b?.fields?.[name] : undefined,
        ),
      ],
    }));
    // 双方都未声明的额外字段：区分 additionalProperties 两种策略
    slots.push({ name: 'zz_extra', values: [ABSENT, 0, 's'] });

    let combos = 1;
    for (const slot of slots) {
      combos *= slot.values.length;
    }
    if (combos > MAX_OBJECT_COMBOS) {
      throw new Error(`代表值域组合数 ${combos} 超过上限：规则组须保持小型`);
    }
    const build = (index: number, acc: Record<string, unknown>): void => {
      if (index === slots.length) {
        add({ ...acc });
        return;
      }
      const slot = slots[index];
      for (const value of slot.values) {
        if (value === ABSENT) {
          build(index + 1, acc);
        } else {
          acc[slot.name] = value;
          build(index + 1, acc);
          delete acc[slot.name];
        }
      }
    };
    build(0, {});
  }

  if (aArr || bArr) {
    add({}); // 非数组形状
    add([]); // 空数组
    const elemDomain = pairDomain(
      aArr ? a?.items : undefined,
      bArr ? b?.items : undefined,
    );
    for (const value of elemDomain) {
      add([value]); // 非空数组：逐元素代表值
    }
  }

  return out;
}

// 在代表值域上判定 L(oldRule) ⊆ L(newRule)：旧规则接受的每个代表值也须被新规则接受。
export function domainInclusive(oldRule: RuleJson, newRule: RuleJson): boolean {
  return pairDomain(oldRule, newRule).every(
    (value) => !accepts(oldRule, value) || accepts(newRule, value),
  );
}

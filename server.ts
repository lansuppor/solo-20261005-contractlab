import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

interface ResponseItem {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
}

interface EndpointState {
  responses: ResponseItem[];
  next: number;
}

interface ConfigState {
  version: number;
  endpoints: Map<string, EndpointState>;
}

interface ReloadResult {
  ok: boolean;
  version: number;
  error?: string;
}

const ADMIN_PREFIX = '/__contractlab/';
const HEALTH_PATH = `${ADMIN_PREFIX}health`;
const RELOAD_PATH = `${ADMIN_PREFIX}reload`;
const VERSION_HEADER = 'x-contractlab-config-version';
const MANAGED_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection']);

function fail(where: string, message: string): never {
  throw new Error(`config ${where}: ${message}`);
}

function parseItem(raw: unknown, where: string): ResponseItem {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(where, 'expected an object');
  }
  const item = raw as Record<string, unknown>;
  for (const key of Object.keys(item)) {
    if (!['status', 'headers', 'body', 'delayMs'].includes(key)) {
      fail(`${where}.${key}`, 'unknown field');
    }
  }
  const status = item.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
    fail(`${where}.status`, 'expected an integer between 200 and 599');
  }
  if (typeof item.body !== 'string') {
    fail(`${where}.body`, 'expected a string');
  }
  const body = item.body;
  if ((status === 204 || status === 304) && body !== '') {
    fail(`${where}.body`, `status ${status} requires an empty body`);
  }
  const headers: Record<string, string> = {};
  if (item.headers !== undefined) {
    if (typeof item.headers !== 'object' || item.headers === null || Array.isArray(item.headers)) {
      fail(`${where}.headers`, 'expected an object mapping header names to string values');
    }
    const seen = new Set<string>();
    for (const [headerName, headerValue] of Object.entries(item.headers as Record<string, unknown>)) {
      const lower = headerName.toLowerCase();
      if (headerName === '' || /[\r\n]/.test(headerName)) {
        fail(`${where}.headers`, `invalid header name ${JSON.stringify(headerName)}`);
      }
      if (MANAGED_HEADERS.has(lower)) {
        fail(`${where}.headers.${headerName}`, 'this header is managed by the server and cannot be set');
      }
      if (seen.has(lower)) {
        fail(`${where}.headers.${headerName}`, 'duplicate header name (case-insensitive)');
      }
      seen.add(lower);
      if (typeof headerValue !== 'string') {
        fail(`${where}.headers.${headerName}`, 'expected a string value');
      }
      if (/[\r\n]/.test(headerValue)) {
        fail(`${where}.headers.${headerName}`, 'header value must not contain newlines');
      }
      headers[headerName] = headerValue;
    }
  }
  let delayMs = 0;
  if (item.delayMs !== undefined) {
    if (typeof item.delayMs !== 'number' || !Number.isInteger(item.delayMs) || item.delayMs < 0 || item.delayMs > 60000) {
      fail(`${where}.delayMs`, 'expected an integer between 0 and 60000');
    }
    delayMs = item.delayMs;
  }
  return { status, headers, body, delayMs };
}

export function parseConfig(text: string): Map<string, ResponseItem[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`config: invalid JSON: ${(err as Error).message}`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    fail('$', 'expected an object');
  }
  const root = doc as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== 'endpoints') fail(`$.${key}`, 'unknown field');
  }
  if (!Array.isArray(root.endpoints)) {
    fail('$.endpoints', 'expected an array');
  }
  const endpoints = new Map<string, ResponseItem[]>();
  root.endpoints.forEach((raw: unknown, i: number) => {
    const where = `$.endpoints[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail(where, 'expected an object');
    }
    const endpoint = raw as Record<string, unknown>;
    for (const key of Object.keys(endpoint)) {
      if (!['method', 'path', 'responses'].includes(key)) {
        fail(`${where}.${key}`, 'unknown field');
      }
    }
    if (endpoint.method !== 'GET' && endpoint.method !== 'POST') {
      fail(`${where}.method`, 'expected "GET" or "POST"');
    }
    if (
      typeof endpoint.path !== 'string' ||
      !endpoint.path.startsWith('/') ||
      endpoint.path.includes('?') ||
      endpoint.path.includes('#')
    ) {
      fail(`${where}.path`, 'expected an absolute path starting with "/" and containing no query string');
    }
    if (endpoint.path.startsWith(ADMIN_PREFIX)) {
      fail(`${where}.path`, `conflicts with the reserved admin prefix ${ADMIN_PREFIX}`);
    }
    const key = `${endpoint.method} ${endpoint.path}`;
    if (endpoints.has(key)) {
      fail(where, `duplicate endpoint ${key}`);
    }
    if (!Array.isArray(endpoint.responses) || endpoint.responses.length === 0) {
      fail(`${where}.responses`, 'expected a non-empty array');
    }
    const responses = endpoint.responses.map((item: unknown, j: number) => parseItem(item, `${where}.responses[${j}]`));
    endpoints.set(key, responses);
  });
  return endpoints;
}

function buildState(parsed: Map<string, ResponseItem[]>): Map<string, EndpointState> {
  const states = new Map<string, EndpointState>();
  for (const [key, responses] of parsed) {
    states.set(key, { responses, next: 0 });
  }
  return states;
}

function drain(req: IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    req.on('data', () => {});
    req.on('end', () => done(true));
    req.on('aborted', () => done(false));
    req.on('error', () => done(false));
    req.on('close', () => done(false));
  });
}

export async function serve(configPath: string, port: number): Promise<void> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read config file ${configPath}: ${(err as Error).message}`);
  }
  let current: ConfigState = { version: 1, endpoints: buildState(parseConfig(text)) };

  // Reloads run one at a time, in the order their requests were fully received.
  let reloadChain: Promise<unknown> = Promise.resolve();
  const requestReload = (): Promise<ReloadResult> => {
    const result = reloadChain.then(async (): Promise<ReloadResult> => {
      let fresh: string;
      try {
        fresh = await readFile(configPath, 'utf8');
      } catch (err) {
        return { ok: false, version: current.version, error: `cannot read config file: ${(err as Error).message}` };
      }
      try {
        const parsed = parseConfig(fresh);
        current = { version: current.version + 1, endpoints: buildState(parsed) };
        return { ok: true, version: current.version };
      } catch (err) {
        return { ok: false, version: current.version, error: (err as Error).message };
      }
    });
    reloadChain = result.catch(() => {});
    return result;
  };

  const delayed = new Map<ServerResponse, NodeJS.Timeout>();

  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
    });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? '';
    let path = req.url ?? '/';
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      // keep the raw target; it simply will not match any endpoint
    }

    if (path === HEALTH_PATH || path === RELOAD_PATH) {
      if (path === HEALTH_PATH && method === 'GET') {
        sendJson(res, 200, { status: 'ok', version: current.version });
        return;
      }
      if (path === RELOAD_PATH && method === 'POST') {
        if (!(await drain(req))) {
          res.destroy();
          return;
        }
        const result = await requestReload();
        sendJson(res, result.ok ? 200 : 422, result);
        return;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (path.startsWith(ADMIN_PREFIX)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // Only a fully received request may consume a sequence position.
    if (!(await drain(req))) {
      res.destroy();
      return;
    }

    const state = current;
    const endpoint = state.endpoints.get(`${method} ${path}`);
    if (endpoint === undefined) {
      const body = Buffer.from(`contractlab: no scenario for ${method} ${path}\n`, 'utf8');
      res.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(body.length),
        [VERSION_HEADER]: String(state.version),
      });
      res.end(body);
      return;
    }

    // Reserve the next response immediately; exhaustion replays the last item.
    const index = endpoint.next < endpoint.responses.length ? endpoint.next : endpoint.responses.length - 1;
    endpoint.next += 1;
    const item = endpoint.responses[index];
    const version = state.version;

    const timer = setTimeout(() => {
      delayed.delete(res);
      if (res.destroyed || res.writableEnded) return;
      const body = Buffer.from(item.body, 'utf8');
      const headers: Record<string, string> = { ...item.headers };
      const hasContentType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type');
      if (!hasContentType) headers['content-type'] = 'text/plain; charset=utf-8';
      headers['content-length'] = String(body.length);
      headers[VERSION_HEADER] = String(version);
      res.writeHead(item.status, headers);
      res.end(body);
    }, item.delayMs);
    delayed.set(res, timer);
    res.on('close', () => {
      const pendingTimer = delayed.get(res);
      if (pendingTimer !== undefined) {
        clearTimeout(pendingTimer);
        delayed.delete(res);
      }
    });
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} on 127.0.0.1 is already in use`));
      } else {
        reject(new Error(`cannot listen on 127.0.0.1:${port}: ${err.message}`));
      }
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`contractlab: loaded ${current.endpoints.size} endpoint(s) from ${configPath} (config version ${current.version})`);
  console.log(`contractlab: listening at http://127.0.0.1:${actualPort}`);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`contractlab: received ${signal}, shutting down`);
      for (const timer of delayed.values()) clearTimeout(timer);
      delayed.clear();
      server.close(() => resolve());
      server.closeAllConnections();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
  console.log('contractlab: stopped');
}

// 请求记录持久化（serve --requests-file）的本机回归测试。
//
// 覆盖（均使用独立临时文件与端口 0）：
// - 无损正文持久化：UTF-8（含 BOM/中文/空白）与非法 UTF-8 的 base64，原始请求头、
//   接收时版本、校验/分支结论、消费位置与计划响应在重启后原样保留，不按当前配置重判；
// - 正常信号关闭（SIGTERM，退出 0）后恢复；强制终止（SIGKILL）后 pending→interrupted；
// - 清空待发送（pending）记录后重启：记录不重现，在途响应仍完成但不复活记录；
// - 清空后重启续号：编号持续递增，不依据剩余记录的最大编号；
// - reload 期间旧计划：在途请求钉住旧版本与旧计划并已落盘，重启后保留各自版本；
//   恢复不重发、不恢复业务序列与配置版本（新服务从版本 1、各序列首项开始）；
// - 文件损坏 / 格式不符：监听前拒绝启动（非零退出）、stdout 无监听、原文件不改；
// - 运行中保存失败：尚未保存的新记录不发送计划响应、清空不报成功、stderr 定位文件、
//   服务非零退出，此前已成功保存的状态保留、已写出的响应不回滚。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat, chmod } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import {
  APP_PATH,
  makeTempDir,
  writeConfig,
  writeText,
  startPersistentServer,
  spawnServerWith,
  type SpawnedServer,
} from './helpers.ts';

const SLOW_DELAY = 600;

function config(): unknown {
  return {
    endpoints: [
      {
        method: 'GET',
        path: '/api/seq',
        responses: [
          { status: 200, headers: { 'X-Item': 'one' }, body: 'one', delay: 0 },
          { status: 201, headers: { 'X-Item': 'two' }, body: 'two', delay: 0 },
          { status: 202, headers: { 'X-Item': 'last' }, body: 'last', delay: 0 },
        ],
      },
      {
        method: 'GET',
        path: '/api/slow',
        responses: [
          { status: 200, headers: {}, body: 'slow-one', delay: SLOW_DELAY },
          { status: 201, headers: {}, body: 'slow-two', delay: SLOW_DELAY },
        ],
      },
      {
        method: 'POST',
        path: '/api/echo',
        requestBody: {
          type: 'object',
          fields: { id: { type: 'integer', required: true } },
          additionalProperties: false,
        },
        responses: [{ status: 200, headers: {}, body: 'echo-ok', delay: 0 }],
      },
    ],
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface StoredFile {
  readonly format: string;
  readonly version: number;
  readonly nextId: number;
  readonly records: StoredRecord[];
}

interface StoredRecord {
  readonly id: number;
  readonly configVersion: number;
  readonly delivery: string;
  readonly request: {
    readonly method: string;
    readonly target: string;
    readonly path: string;
    readonly rawHeaders: readonly string[];
    readonly bodyBytes: number;
    readonly body: { readonly encoding: string; readonly content: string };
  };
  readonly sequencePosition: number | null;
  readonly sequenceLength: number | null;
  readonly plannedResponse: { readonly kind: string; readonly status: number; readonly body: string } | null;
}

async function readStore(file: string): Promise<StoredFile> {
  return JSON.parse(await readFile(file, 'utf8')) as StoredFile;
}

async function waitFor<T>(fn: () => Promise<T | null> | (T | null), timeoutMs = 4000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined) {
        return v as T;
      }
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${label}${lastErr ? `（${String(lastErr)}）` : ''}`);
    }
    await sleep(20);
  }
}

function textRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) {
      h['Content-Length'] = String(Buffer.byteLength(body));
    }
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) {
      r.write(body);
    }
    r.end();
  });
}

async function getRecords(port: number): Promise<StoredRecord[]> {
  const reply = await textRequest(port, 'GET', '/__contractlab/requests');
  assert.equal(reply.status, 200);
  const parsed = JSON.parse(reply.body) as { count: number; records: StoredRecord[] };
  assert.equal(parsed.count, parsed.records.length);
  return parsed.records;
}

function rawConnect(port: number, raw: Buffer): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(raw);
      resolve(socket);
    });
    socket.on('error', reject);
  });
}

async function readStatusLine(socket: net.Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('未读到状态行'));
    }, 5000);
    socket.on('data', (c: Buffer) => {
      chunks.push(c);
      const m = Buffer.concat(chunks).toString('latin1').match(/^HTTP\/1\.\d (\d{3})/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// 直接 spawn serve 并等待退出（用于断言“监听前拒绝启动”）。
async function serveAndExit(
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [APP_PATH, 'serve', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);
  return { code, signal, stdout, stderr };
}

// ---------------------------------------------------------------------------

test('持久化：UTF-8（含 BOM/中文）与非法 UTF-8 base64 无损恢复，结论与计划响应原样保留', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  let server: SpawnedServer = await startPersistentServer(file, storeFile);
  t.after(server.close);
  const port = server.port;

  // UTF-8：BOM 开头 + 中文 + 尾随空白；Content-Type 头小写
  const utf8Body = '﻿{"id": 1}   ';
  const utf8 = await textRequest(port, 'POST', '/api/echo?x=%E4%B8%AD', utf8Body, {
    'content-type': 'application/json',
  });
  assert.equal(utf8.status, 200);

  // 400：结构差异（消费位置 null，框架计划响应）
  const bad = await textRequest(port, 'POST', '/api/echo', '{"id":"nope","extra":1}', {
    'Content-Type': 'application/json',
  });
  assert.equal(bad.status, 400);

  // 404
  const nf = await textRequest(port, 'GET', '/api/missing?q=1');
  assert.equal(nf.status, 404);

  // 非法 UTF-8：原始套接字，parse 阶段 400，正文按 base64 无损记录
  const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x80, 0x7d]);
  const raw = Buffer.concat([
    Buffer.from(
      [
        'POST /api/echo HTTP/1.1',
        'Host: 127.0.0.1',
        'X-Raw: Keep-Me',
        'Content-Type: application/json',
        `Content-Length: ${bytes.byteLength}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
      'utf8',
    ),
    bytes,
  ]);
  const sock = await rawConnect(port, raw);
  sock.resume();
  assert.equal(await readStatusLine(sock), 400);
  sock.destroy();

  await waitFor(async () => ((await readStore(storeFile)).records.length === 4 ? true : null), 4000, '4 条记录落盘');

  await server.close();

  // 重启：在监听前完整恢复
  server = await startPersistentServer(file, storeFile);
  const port2 = server.port;
  const records = await getRecords(port2);
  assert.deepEqual(records.map((r) => r.id), [1, 2, 3, 4]);

  // UTF-8 记录：BOM 与空白原样保留、字节数一致
  const rUtf = records[0];
  assert.equal(rUtf.request.target, '/api/echo?x=%E4%B8%AD');
  assert.equal(rUtf.request.path, '/api/echo');
  assert.equal(rUtf.request.body.encoding, 'utf-8');
  assert.equal(rUtf.request.body.content, utf8Body);
  assert.equal(rUtf.request.bodyBytes, Buffer.byteLength(utf8Body));
  const rh = rUtf.request.rawHeaders;
  assert.equal(rh[rh.indexOf('content-type') + 1], 'application/json');
  assert.equal(rUtf.configVersion, 1);
  assert.equal(rUtf.sequencePosition, 0);
  assert.equal(rUtf.sequenceLength, 1);
  assert.equal(rUtf.plannedResponse?.kind, 'scene');
  assert.equal(rUtf.plannedResponse?.status, 200);
  assert.equal(rUtf.plannedResponse?.body, 'echo-ok');
  assert.equal(rUtf.delivery, 'sent');

  // 400 记录：结论与计划响应保留，不重判
  const rBad = records[1];
  assert.equal(rBad.sequencePosition, null);
  assert.equal(rBad.plannedResponse?.kind, 'framework');
  assert.equal(rBad.plannedResponse?.status, 400);
  assert.equal(rBad.plannedResponse?.body, `${bad.body}`);

  // 404
  assert.equal(records[2].plannedResponse?.status, 404);

  // 非法 UTF-8：base64 无损还原原始字节
  const rBin = records[3];
  assert.equal(rBin.request.body.encoding, 'base64');
  assert.ok(Buffer.from(rBin.request.body.content, 'base64').equals(bytes));
  assert.equal(rBin.request.bodyBytes, bytes.byteLength);
  const binRaw = rBin.request.rawHeaders;
  assert.equal(binRaw[binRaw.indexOf('X-Raw') + 1], 'Keep-Me');
  assert.equal(rBin.plannedResponse?.status, 400);

  await server.close();
});

test('正常关闭（SIGTERM 退出 0）后完整恢复；强制终止（SIGKILL）后 pending 恢复为 interrupted', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');

  // 第一段：制造一个 sent 与一个 pending，然后 SIGKILL（pending 未及正常关闭）
  let server = await startPersistentServer(file, storeFile);
  const port = server.port;
  await textRequest(port, 'GET', '/api/seq'); // id1 sent
  await waitFor(async () => {
    const r = (await readStore(storeFile)).records.find((x) => x.id === 1);
    return r && r.delivery === 'sent' ? true : null;
  }, 4000, 'id1 sent 落盘');
  const inflight = textRequest(port, 'GET', '/api/slow'); // id2 pending
  inflight.catch(() => undefined); // SIGKILL 会断开此连接：预先注册 rejection handler
  await waitFor(async () => {
    const r = (await readStore(storeFile)).records.find((x) => x.id === 2);
    return r && r.delivery === 'pending' ? true : null;
  }, 4000, 'id2 pending 落盘');
  server.send('SIGKILL');
  await server.waitExit();
  await inflight.catch(() => undefined); // 连接被强杀，客户端报错可忽略

  // 磁盘上仍是 pending（响应未确认写出）
  let store = await readStore(storeFile);
  assert.deepEqual(store.records.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'pending']]);

  // 重启：pending → interrupted，sent 不回退；不重发
  server = await startPersistentServer(file, storeFile);
  let recs = await getRecords(server.port);
  assert.deepEqual(recs.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'interrupted']]);
  // 计划响应仍保留（interrupted 不代表客户端未收到，也不代表要补发）
  const interrupted = recs.find((r) => r.id === 2);
  assert.equal(interrupted?.plannedResponse?.body, 'slow-one');

  // 正常 SIGTERM：保存尚存记录最终状态后退出 0
  server.send('SIGTERM');
  const exited = await server.waitExit();
  assert.equal(exited.code, 0);
  store = await readStore(storeFile);
  assert.deepEqual(store.records.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'interrupted']]);

  // 再次重启：状态保持 interrupted，不重发、不补待发送项
  server = await startPersistentServer(file, storeFile);
  recs = await getRecords(server.port);
  assert.deepEqual(recs.map((r) => [r.id, r.delivery]), [[1, 'sent'], [2, 'interrupted']]);
  await server.close();
});

test('清空待发送记录后重启：记录不重现；在途响应仍完成但不复活记录；编号继续递增', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  let server = await startPersistentServer(file, storeFile);
  const port = server.port;

  const pending = textRequest(port, 'GET', '/api/slow'); // id1 pending
  await waitFor(async () => ((await readStore(storeFile)).records.some((r) => r.id === 1) ? true : null), 4000, 'id1 落盘');

  // 清空含 pending 的全部记录
  const cleared = await textRequest(port, 'POST', '/__contractlab/requests/clear');
  assert.equal(cleared.status, 200);
  assert.equal(JSON.parse(cleared.body).removed, 1);
  await waitFor(async () => ((await readStore(storeFile)).records.length === 0 ? true : null), 4000, '清空落盘');

  // 在途响应未被取消，仍正常完成
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body, 'slow-one');
  await sleep(SLOW_DELAY + 100);

  // 旧响应完成后记录不得复活
  let store = await readStore(storeFile);
  assert.equal(store.records.length, 0);
  assert.ok(store.nextId >= 2, '编号进度必须保留（nextId 不回退为 1）');

  // 重启：仍为空；新请求编号在清空基础上继续（不复用 1）
  await server.close();
  server = await startPersistentServer(file, storeFile);
  assert.equal((await getRecords(server.port)).length, 0);
  const next = await textRequest(server.port, 'GET', '/api/seq');
  assert.equal(next.status, 200);
  await waitFor(async () => ((await readStore(storeFile)).records.length === 1 ? true : null), 4000, '新记录落盘');
  store = await readStore(storeFile);
  assert.equal(store.records[0].id, 2, '清空并重启后编号继续递增，不复用已清空编号');
  await server.close();
});

test('清空后重启的编号进度独立于剩余记录最大编号（不能按剩余 max 续号）', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  let server = await startPersistentServer(file, storeFile);

  await textRequest(server.port, 'GET', '/api/seq'); // 1
  await textRequest(server.port, 'GET', '/api/seq'); // 2
  await textRequest(server.port, 'GET', '/api/seq'); // 3
  await textRequest(server.port, 'POST', '/__contractlab/requests/clear');
  await waitFor(async () => ((await readStore(storeFile)).records.length === 0 ? true : null), 4000, '清空落盘');
  await server.close();

  // 重启后剩余记录为 0：若按“剩余最大编号”续号会得到 1；正确应为 4
  server = await startPersistentServer(file, storeFile);
  await textRequest(server.port, 'GET', '/api/seq');
  await waitFor(async () => ((await readStore(storeFile)).records.length === 1 ? true : null), 4000, '新记录落盘');
  let store = await readStore(storeFile);
  assert.equal(store.records[0].id, 4);
  assert.equal(store.nextId, 5);

  // 再清空、再重启，编号仍单调
  await textRequest(server.port, 'POST', '/__contractlab/requests/clear');
  await waitFor(async () => ((await readStore(storeFile)).records.length === 0 ? true : null), 4000, '二次清空');
  await server.close();
  server = await startPersistentServer(file, storeFile);
  await textRequest(server.port, 'GET', '/api/seq');
  await waitFor(async () => ((await readStore(storeFile)).records.length === 1 ? true : null), 4000, '新记录落盘');
  store = await readStore(storeFile);
  assert.equal(store.records[0].id, 5);
  assert.equal(store.nextId, 6);
  await server.close();
});

test('reload 期间在途请求钉住旧版本与旧计划并已落盘；重启保留各自版本；业务序列与版本从首项/版本1开始', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  let server = await startPersistentServer(file, storeFile);
  const port = server.port;

  // 在途：v1 的 slow-one（延迟中）
  const inflight = textRequest(port, 'GET', '/api/slow?pin=1');
  await waitFor(async () => {
    const r = (await readStore(storeFile)).records.find((x) => x.id === 1);
    return r && r.delivery === 'pending' ? true : null;
  }, 4000, '在途记录 pending');
  let stored = await readStore(storeFile);
  assert.equal(stored.records[0].configVersion, 1);
  assert.equal(stored.records[0].plannedResponse?.body, 'slow-one');

  // reload 为 v2：/api/slow 单响应 202 v2-body，无延迟
  await writeConfig(
    dir,
    'scenes.json',
    { endpoints: [{ method: 'GET', path: '/api/slow', responses: [{ status: 202, headers: {}, body: 'v2-body', delay: 0 }] }] },
  );
  const reloaded = await textRequest(port, 'POST', '/__contractlab/reload');
  assert.equal(JSON.parse(reloaded.body).version, 2);

  // 在途仍按 v1 完成
  const oldRes = await inflight;
  assert.equal(oldRes.status, 200);
  assert.equal(oldRes.headers['x-contractlab-version'], '1');
  assert.equal(oldRes.body, 'slow-one');

  // 新请求用 v2
  const newRes = await textRequest(port, 'GET', '/api/slow');
  assert.equal(newRes.status, 202);
  assert.equal(newRes.headers['x-contractlab-version'], '2');
  assert.equal(newRes.body, 'v2-body');
  await waitFor(async () => ((await readStore(storeFile)).records.length === 2 ? true : null), 4000, '两条记录落盘');

  stored = await readStore(storeFile);
  assert.equal(stored.records[0].configVersion, 1);
  assert.equal(stored.records[0].plannedResponse?.body, 'slow-one');
  assert.equal(stored.records[1].configVersion, 2);
  assert.equal(stored.records[1].plannedResponse?.body, 'v2-body');

  // 重启恢复：结论不按当前配置重判（id1 仍是 v1/slow-one）
  await server.close();
  server = await startPersistentServer(file, storeFile);
  const recs = await getRecords(server.port);
  assert.equal(recs[0].configVersion, 1);
  assert.equal(recs[0].plannedResponse?.body, 'slow-one');
  assert.equal(recs[1].configVersion, 2);
  assert.equal(recs[1].plannedResponse?.body, 'v2-body');

  // 业务序列与配置版本不恢复：新服务按当前场景从版本 1、序列首项开始
  const after = await textRequest(server.port, 'GET', '/api/slow');
  assert.equal(after.status, 202);
  assert.equal(after.headers['x-contractlab-version'], '1', '恢复后配置版本恒为 1');
  assert.equal(after.body, 'v2-body');
  await server.close();
});

test('清空与在途/新请求交错：旧记录的延迟完成或失败都不复活，查询与文件一致', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  const storeFile = path.join(dir, 'reqlog.json');
  const server = await startPersistentServer(file, storeFile);
  const port = server.port;

  const pending = textRequest(port, 'GET', '/api/slow'); // id1 pending
  await waitFor(async () => ((await readStore(storeFile)).records.some((r) => r.id === 1) ? true : null), 4000, 'id1 落盘');

  // 清空后立即来一个会很快完成的请求（id2）
  await textRequest(port, 'POST', '/__contractlab/requests/clear');
  const quick = await textRequest(port, 'GET', '/api/seq');
  assert.equal(quick.status, 200);

  // 被清空的在途请求随后完成
  const old = await pending;
  assert.equal(old.status, 200);
  assert.equal(old.body, 'slow-one');
  await sleep(SLOW_DELAY + 100);

  const store = await waitFor(async () => {
    const s = await readStore(storeFile);
    return s.records.length === 1 ? s : null;
  }, 4000, '文件只剩 id2');
  assert.deepEqual(store.records.map((r) => r.id), [2]);

  const recs = await getRecords(port);
  assert.deepEqual(recs.map((r) => r.id), [2]);
  assert.equal(recs[0].plannedResponse?.body, 'one');
  await server.close();
});

test('文件损坏或格式不符：监听前拒绝启动（非零退出）、无监听输出、原文件不改', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());

  const cases: ReadonlyArray<{ name: string; content: string; expect: RegExp }> = [
    { name: '非法 JSON', content: '{ broken', expect: /不是合法 JSON/ },
    { name: '顶层非对象', content: '[1,2,3]', expect: /顶层必须是 JSON 对象/ },
    { name: '格式标识不符', content: JSON.stringify({ format: 'other', version: 1, nextId: 1, records: [] }), expect: /format/ },
    { name: '版本不符', content: JSON.stringify({ format: 'contractlab-request-log-1', version: 9, nextId: 1, records: [] }), expect: /version/ },
    { name: '编号进度损坏', content: JSON.stringify({
      format: 'contractlab-request-log-1',
      version: 1,
      nextId: 2,
      records: [{
        id: 5,
        receivedAt: '2026-10-08T00:00:00.000Z',
        configVersion: 1,
        matched: false,
        endpoint: 'GET /x',
        bodyValidationPassed: null,
        bodyRejection: null,
        branchSelection: null,
        sequencePosition: null,
        sequenceLength: null,
        plannedResponse: { kind: 'framework', status: 404, headers: {}, body: 'not found\n' },
        delivery: 'sent',
        request: { method: 'GET', target: '/x', path: '/x', rawHeaders: [], bodyBytes: 0, body: { encoding: 'utf-8', content: '' } },
      }],
    }), expect: /nextId/ },
    { name: '记录正文无法无损还原', content: JSON.stringify({
      format: 'contractlab-request-log-1',
      version: 1,
      nextId: 2,
      records: [{
        id: 1,
        receivedAt: '2026-10-08T00:00:00.000Z',
        configVersion: 1,
        matched: false,
        endpoint: 'GET /x',
        bodyValidationPassed: null,
        bodyRejection: null,
        branchSelection: null,
        sequencePosition: null,
        sequenceLength: null,
        plannedResponse: { kind: 'framework', status: 404, headers: {}, body: 'not found\n' },
        delivery: 'sent',
        request: { method: 'GET', target: '/x', path: '/x', rawHeaders: [], bodyBytes: 5, body: { encoding: 'utf-8', content: '' } },
      }],
    }), expect: /records\[0\]\.request\.body/ },
  ];

  for (const c of cases) {
    const bad = path.join(dir, `bad-${encodeURIComponent(c.name)}.json`);
    await writeText(dir, path.basename(bad), c.content);
    const before = await stat(bad);
    const r = await serveAndExit(['--config', file, '--port', '0', '--requests-file', bad]);
    assert.notEqual(r.code, 0, `${c.name}: 必须非零退出`);
    assert.ok(!/listening on/.test(r.stdout), `${c.name}: 不得开始监听`);
    assert.match(r.stderr, c.expect, `${c.name}: stderr 应定位原因`);
    assert.match(r.stderr, new RegExp(path.basename(bad).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${c.name}: stderr 应定位文件`);
    const after = await stat(bad);
    assert.equal(after.size, before.size, `${c.name}: 原文件不得被修改`);
  }
});

test('运行中保存失败：未保存的新记录不发送、清空不报成功、stderr 定位、非零退出、已保存状态保留', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());

  // 情形 A：新记录的计划响应尚未保存，不得发送，服务非零退出
  const storeA = path.join(dir, 'a.json');
  let server = await startPersistentServer(file, storeA);
  const portA = server.port;
  await textRequest(portA, 'GET', '/api/seq'); // 已成功保存 id1
  await waitFor(async () => {
    const r = (await readStore(storeA)).records.find((x) => x.id === 1);
    return r && r.delivery === 'sent' ? true : null;
  }, 4000, 'id1 sent 落盘');
  await chmod(dir, 0o555); // 目录只读：tmp+rename 无法成功
  t.after(() => chmod(dir, 0o755).catch(() => undefined));

  const blocked = textRequest(portA, 'GET', '/api/seq');
  blocked.catch(() => undefined); // 致命关闭会断开连接：预先注册 rejection handler
  const exitA = await server.waitExit();
  assert.notEqual(exitA.code, 0, '保存失败必须非零退出');
  await assert.rejects(blocked, '未保存的新记录不得发送计划响应（连接被关闭）');
  await chmod(dir, 0o755);
  assert.match(server.stderr(), /保存失败/, 'stderr 应说明保存失败');
  assert.match(server.stderr(), new RegExp(path.basename(storeA)), 'stderr 应定位记录文件');
  const keptA = await readStore(storeA);
  assert.deepEqual(keptA.records.map((r) => r.id), [1], '此前已成功保存的状态保留');

  // 情形 B：清空的删除结果保存失败时不得报成功，服务非零退出
  const storeB = path.join(dir, 'b.json');
  server = await startPersistentServer(file, storeB);
  await textRequest(server.port, 'GET', '/api/seq');
  await waitFor(async () => {
    const r = (await readStore(storeB)).records.find((x) => x.id === 1);
    return r && r.delivery === 'sent' ? true : null;
  }, 4000, 'id1 sent 落盘');
  await chmod(dir, 0o555);
  const clearAttempt = textRequest(server.port, 'POST', '/__contractlab/requests/clear');
  clearAttempt.catch(() => undefined); // 致命关闭会断开连接：预先注册 rejection handler
  const exitB = await server.waitExit();
  assert.notEqual(exitB.code, 0);
  // 清空请求不得拿到 200 成功（连接被关闭或非 200）
  await clearAttempt.then(
    (reply) => assert.notEqual(reply.status, 200),
    () => undefined,
  );
  await chmod(dir, 0o755);
  assert.match(server.stderr(), /保存失败/);
  const keptB = await readStore(storeB);
  assert.deepEqual(keptB.records.map((r) => r.id), [1], '清空未保存成功：记录仍保留');
});

test('未启用持久化时保持纯进程内行为：不产生记录文件', { timeout: 20_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', config());
  // 走默认 startServer（无 --requests-file）
  const server = await spawnServerWith(['serve', '--config', file, '--port', '0']);
  await textRequest(server.port, 'GET', '/api/seq');
  const recs = await getRecords(server.port);
  assert.equal(recs.length, 1);
  await server.close();
  // 目录内只有场景配置，没有记录文件
  const entries = await import('node:fs/promises').then((fs) => fs.readdir(dir));
  assert.deepEqual(entries.sort(), ['scenes.json']);
});

// 按请求正文值选择响应分支（endpoints[].branches）回归测试
//
// 覆盖（真实本机服务 + 真实 HTTP/原始套接字，独立临时文件与端口 0）：
// - 首支命中、重叠条件取第一支；根指针、对象自有字段（空字段名、__proto__）、
//   数组下标、~0/~1 转义；取值不存在/无法遍历不命中；缺失不同于显式 null；
//   不做类型转换；0 与 -0 相等；
// - 各分支与兜底独立计数、交错消费互不挤占、耗尽复用末项、查询串共享计数；
// - 400/404/413/未收完整不消费；预留后断开仍消费选中项；
// - 请求记录区分 branch/fallback/未选择，sequencePosition/Length 对应选中序列，
//   计划响应与线上一致；
// - reload 成功原子替换规则/分支/响应并重置全部计数，失败保留旧状态；
//   重载期间旧延迟响应保留原选中项与版本、不推进新序列；
// - 非法分支配置整份拒绝（启动退出 1）并定位；
// - compare/verify 只看接口与正文接受条件，分支变化不影响结论；
// - import 保留分支/顺序/响应，仅替换正文规则；移除规则致前提失效时退出 2；
// - 无分支场景与 replay 行为保持（分支请求也能被 replay 判 same）。

import assert from 'node:assert/strict';
import net from 'node:net';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import {
  makeTempDir,
  runCli,
  runCompare,
  sendRequest,
  startServer,
  writeConfig,
  writeText,
  type RawRequest,
  type RunningServer,
} from './helpers.ts';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const SLOW = 350;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function resp(status: number, body: string, headers: Record<string, string> = {}, delay = 0) {
  return { status, headers, body, delay };
}
function br(id: string, when: Record<string, unknown>, responses: unknown[]) {
  return { id, when, responses };
}
function post(path: string, body: string): RawRequest {
  return { method: 'POST', path, headers: { ...JSON_HEADERS }, body };
}

// 分支与兜底各自独立序列的主场景
function mainConfig(): unknown {
  return {
    endpoints: [
      {
        method: 'POST',
        path: '/orders',
        requestBody: {
          type: 'object',
          fields: {
            state: { type: 'string', required: true },
            amount: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        responses: [resp(200, 'fb-0', { 'X-Seq': 'fb0' }), resp(200, 'fb-1', { 'X-Seq': 'fb1' })],
        branches: [
          {
            id: 'paid',
            when: { '/state': 'paid' },
            responses: [resp(201, 'paid-0', { 'X-Seq': 'p0' }), resp(201, 'paid-1', { 'X-Seq': 'p1' })],
          },
          {
            id: 'paid-big',
            when: { '/state': 'paid', '/amount': 100 },
            responses: [resp(202, 'big-0'), resp(202, 'big-1')],
          },
          {
            id: 'tag-a',
            when: { '/tags/0': 'a' },
            responses: [resp(203, 'tag-a')],
          },
        ],
      },
      {
        method: 'POST',
        path: '/slow',
        requestBody: {
          type: 'object',
          fields: { k: { type: 'string', required: true } },
          additionalProperties: false,
        },
        responses: [resp(200, 'slow-fb', {}, SLOW), resp(200, 'slow-fb-2', {}, SLOW)],
        branches: [
          {
            id: 'b1',
            when: { '/k': 'x' },
            responses: [resp(201, 'slow-b1-1', {}, SLOW), resp(201, 'slow-b1-2', {}, SLOW)],
          },
        ],
      },
    ],
  };
}

interface WireRecord {
  readonly id: number;
  readonly matched: boolean;
  readonly bodyValidationPassed: boolean | null;
  readonly branchSelection: { kind: string; id?: string } | null;
  readonly sequencePosition: number | null;
  readonly sequenceLength: number | null;
  readonly plannedResponse: { readonly status: number; readonly body: string } | null;
  readonly delivery: string;
  readonly configVersion: number;
}

async function clearRecords(port: number): Promise<void> {
  await sendRequest(port, { method: 'POST', path: '/__contractlab/requests/clear', headers: {}, body: '' });
}

async function getRecords(port: number): Promise<WireRecord[]> {
  const reply = await sendRequest(port, {
    method: 'GET',
    path: '/__contractlab/requests',
    headers: {},
    body: '',
  });
  assert.equal(reply.status, 200);
  const parsed = JSON.parse(reply.body) as { count: number; records: WireRecord[] };
  assert.equal(parsed.count, parsed.records.length);
  return parsed.records;
}

test('重叠条件取第一支；分支与兜底独立计数、交错消费、耗尽复用末项', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', mainConfig());
  const server: RunningServer = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  const r1 = await sendRequest(port, post('/orders', '{"state":"paid"}'));
  assert.equal(r1.status, 201);
  assert.equal(r1.body, 'paid-0');

  const r2 = await sendRequest(port, post('/orders?z=1', '{"state":"new"}'));
  assert.equal(r2.status, 200);
  assert.equal(r2.body, 'fb-0');

  // 同时满足 paid 与 paid-big：取排在前面的 paid（其位置 1）
  const r3 = await sendRequest(port, post('/orders?z=2', '{"state":"paid","amount":100}'));
  assert.equal(r3.status, 201);
  assert.equal(r3.body, 'paid-1');

  // paid 序列已耗尽：再命中 paid 仍复用末项 paid-1（位置停在 1）
  const r4 = await sendRequest(port, post('/orders', '{"state":"paid","amount":100}'));
  assert.equal(r4.body, 'paid-1');

  // 兜底序列独立推进到位置 1
  const r5 = await sendRequest(port, post('/orders', '{"state":"other"}'));
  assert.equal(r5.status, 200);
  assert.equal(r5.body, 'fb-1');

  // 第三个分支
  const r6 = await sendRequest(port, post('/orders', '{"state":"z","tags":["a"]}'));
  assert.equal(r6.status, 203);
  assert.equal(r6.body, 'tag-a');

  const records = await getRecords(port);
  assert.deepEqual(
    records.map((r) => [r.branchSelection?.kind, r.branchSelection?.id ?? null, r.sequencePosition, r.sequenceLength]),
    [
      ['branch', 'paid', 0, 2],
      ['fallback', null, 0, 2],
      ['branch', 'paid', 1, 2],
      ['branch', 'paid', 1, 2], // 末项复用
      ['fallback', null, 1, 2],
      ['branch', 'tag-a', 0, 1],
    ],
  );
  // 计划响应与线上一致
  assert.equal(records[0].plannedResponse?.body, 'paid-0');
  assert.equal(records[1].plannedResponse?.status, 200);
  assert.equal(records[5].plannedResponse?.body, 'tag-a');
});

test('查询串共享同一组分支/兜底计数；无命中稳定走兜底', { timeout: 20_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', mainConfig());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  const a = await sendRequest(port, post('/orders?a=1', '{"state":"paid"}'));
  const b = await sendRequest(port, post('/orders?b=2', '{"state":"paid"}'));
  assert.equal(a.body, 'paid-0');
  assert.equal(b.body, 'paid-1', '查询串不参与匹配，共享 paid 序列');
});

test('指针语义：根、空字段名、__proto__、数组下标、转义、不可遍历；缺失≠null；无类型转换；0===-0', {
  timeout: 20_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const pointerConfig = {
    endpoints: [
      {
        method: 'POST',
        path: '/p',
        requestBody: {
          type: 'object',
          fields: {
            '': { type: 'string' },
            __proto__: { type: 'string' },
            a: { type: 'integer', nullable: true },
            'a/b': { type: 'string' },
            'c~d': { type: 'string' },
            nested: { type: 'object', fields: { x: { type: 'string' } }, additionalProperties: false },
          },
          additionalProperties: true,
        },
        responses: [resp(200, 'fb')],
        branches: [
          br('empty', { '/': 'x' }, [resp(201, 'empty')]),
          br('proto', { '/__proto__': 'y' }, [resp(202, 'proto')]),
          br('anull', { '/a': null }, [resp(203, 'anull')]),
          br('zero', { '/a': 0 }, [resp(204, '', {}, 0)]),
          br('slash', { '/a~1b': 's' }, [resp(205, 'slash')]),
          br('tilde', { '/c~0d': 't' }, [resp(206, 'tilde')]),
          br('nested', { '/nested/x': 'deep' }, [resp(207, 'nested')]),
          br('untraversable', { '/deep/a': 1 }, [resp(208, 'should-never-hit')]),
          br('numcoerce', { '/strnum': 0 }, [resp(209, 'should-never-hit')]),
        ],
      },
      {
        method: 'POST',
        path: '/root',
        requestBody: { type: 'string' },
        responses: [resp(200, 'fb')],
        branches: [br('ishello', { '': 'hello' }, [resp(210, 'root-hello')])],
      },
      {
        method: 'POST',
        path: '/arr',
        requestBody: { type: 'array', items: { type: 'string' } },
        responses: [resp(200, 'fb')],
        branches: [
          br('first-a', { '/0': 'a' }, [resp(211, 'arr-a')]),
          br('deep', { '/2': 'c' }, [resp(212, 'arr-c')]),
        ],
      },
    ],
  };
  const file = await writeConfig(dir, 'pointer.json', pointerConfig);
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  const expect = async (path: string, body: string, status: number, out: string | null): Promise<void> => {
    const r = await sendRequest(port, post(path, body));
    assert.equal(r.status, status, `body=${body}`);
    if (out !== null) {
      assert.equal(r.body, out, `body=${body}`);
    }
  };

  await expect('/p', '{"":"x"}', 201, 'empty');
  await expect('/p', '{"__proto__":"y"}', 202, 'proto');
  await expect('/p', '{"a":null}', 203, 'anull');
  await expect('/p', '{"a":0}', 204, '');
  await expect('/p', '{"a":-0}', 204, ''); // 0 与 -0 相等
  await expect('/p', '{"a/b":"s"}', 205, 'slash');
  await expect('/p', '{"c~d":"t"}', 206, 'tilde');
  await expect('/p', '{"nested":{"x":"deep"}}', 207, 'nested');

  // 在合法但为标量的未声明字段（additionalProperties 允许）上继续遍历：取不到值，不命中
  await expect('/p', '{"deep":1}', 200, 'fb');
  // 中间段缺失：指针取不到值，不命中
  await expect('/p', '{"nested":{}}', 200, 'fb');
  // 不做类型转换：合法正文中字符串 "0" ≠ 数字条件 0，不命中
  await expect('/p', '{"strnum":"0"}', 200, 'fb');

  // 缺失字段不命中显式 null；无命中走兜底
  await expect('/p', '{}', 200, 'fb');
  // 不做类型转换：字段声明 integer，字符串 "0" 在结构校验阶段即被拒绝（不到分支选择）
  await expect('/p', '{"a":"0"}', 400, null);
  // 无法继续遍历：nested 是字符串却取 /nested/x（该值结构不接受，先 400）
  await expect('/p', '{"nested":"str"}', 400, null);

  // 根指针
  await expect('/root', '"hello"', 210, 'root-hello');
  await expect('/root', '"other"', 200, 'fb');

  // 数组下标
  await expect('/arr', '["a","b"]', 211, 'arr-a');
  await expect('/arr', '["x","y","c"]', 212, 'arr-c');
  await expect('/arr', '[]', 200, 'fb'); // 越界取下标不命中
  await expect('/arr', '["x"]', 200, 'fb'); // /2 越界不命中
});

test('400 正文拒绝与 404 不消费任何分支/兜底序列', { timeout: 20_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', mainConfig());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  // 结构非法：state 必填缺失 + 额外字段
  const bad = await sendRequest(port, post('/orders', '{"amount":1,"extra":2}'));
  assert.equal(bad.status, 400);
  // 媒体类型错误
  const badMedia = await sendRequest(port, {
    method: 'POST',
    path: '/orders',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"state":"paid"}',
  });
  assert.equal(badMedia.status, 400);
  // 未匹配
  const nf = await sendRequest(port, post('/no/such', '{}'));
  assert.equal(nf.status, 404);

  // 均未消费：首个合格 paid 仍取 paid-0，首个兜底仍取 fb-0
  const ok = await sendRequest(port, post('/orders', '{"state":"paid"}'));
  assert.equal(ok.body, 'paid-0');
  const fb = await sendRequest(port, post('/orders', '{"state":"new"}'));
  assert.equal(fb.body, 'fb-0');

  const records = await getRecords(port);
  const rejected = records.slice(0, 3);
  for (const r of rejected) {
    assert.equal(r.branchSelection, null);
    assert.equal(r.sequencePosition, null);
    assert.equal(r.sequenceLength, null);
  }
  assert.equal(rejected[0].bodyValidationPassed, false);
  assert.equal(rejected[2].matched, false);
});

test('未收完整不消费；预留后断开仍消费选中分支项', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', mainConfig());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  // 完整接收一个命中 b1 的延迟请求，等待记录变 pending（已预留），随后断开
  const body = '{"k":"x"}';
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    ['POST /slow HTTP/1.1', 'Host: 127.0.0.1', 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, '', ''].join('\r\n'),
    'utf8',
  );
  socket.write(body);
  // 等到完整接收并预留（记录出现且 pending）
  for (let i = 0; i < 100; i += 1) {
    const recs = await getRecords(port);
    if (recs.length === 1 && recs[0].delivery === 'pending') {
      break;
    }
    await sleep(10);
  }
  let recs = await getRecords(port);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].branchSelection?.kind, 'branch');
  assert.equal(recs[0].branchSelection?.id, 'b1');
  assert.equal(recs[0].sequencePosition, 0);
  socket.resume();
  socket.destroy();
  await sleep(80);
  recs = await getRecords(port);
  assert.equal(recs[0].delivery, 'interrupted');

  // 预留已成立：下一次命中 b1 取第 1 项（不是第 0 项）
  const next = await sendRequest(port, post('/slow', '{"k":"x"}'));
  assert.equal(next.status, 201);
  assert.equal(next.body, 'slow-b1-2');
  recs = await getRecords(port);
  assert.equal(recs[1].sequencePosition, 1);
});

test('未收完整：不创建记录、不消费任何分支序列', { timeout: 20_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', mainConfig());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  // 声明 100 字节、只发半个 JSON 即断开
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    ['POST /orders HTTP/1.1', 'Host: 127.0.0.1', 'Content-Type: application/json', 'Content-Length: 100', 'Connection: close', '', '{"state"'].join('\r\n'),
    'utf8',
  );
  socket.resume();
  await sleep(80);
  socket.destroy();
  await sleep(100);

  const records = await getRecords(port);
  assert.equal(records.length, 0, '未完整接收不创建记录');

  const ok = await sendRequest(port, post('/orders', '{"state":"paid"}'));
  assert.equal(ok.body, 'paid-0', '未完整接收不消费：首个合格请求仍取分支第 0 项');
});

test('reload 成功原子替换并重置全部计数；重载期间旧延迟响应保留原选中项与版本、不推进新序列', {
  timeout: 30_000,
}, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', mainConfig());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  // 在途：v1 命中 b1 的延迟响应（b1 位置 0）
  const inflight = sendRequest(port, post('/slow?pin=1', '{"k":"x"}'));
  await sleep(100);
  let recs = await getRecords(port);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].delivery, 'pending');
  assert.equal(recs[0].configVersion, 1);
  assert.equal(recs[0].branchSelection?.id, 'b1');
  assert.equal(recs[0].plannedResponse?.body, 'slow-b1-1');

  // reload 成 v2：/slow 去掉分支、单条无延迟响应
  const v2 = {
    endpoints: [
      {
        method: 'POST',
        path: '/slow',
        requestBody: { type: 'object', fields: { k: { type: 'string', required: true } }, additionalProperties: false },
        responses: [resp(202, 'v2-body')],
      },
    ],
  };
  await writeConfig(dir, 'scenes.json', v2);
  const reloaded = await sendRequest(port, {
    method: 'POST',
    path: '/__contractlab/reload',
    headers: {},
    body: '',
  });
  const reloadBody = JSON.parse(reloaded.body);
  assert.equal(reloadBody.ok, true);
  assert.equal(reloadBody.version, 2);

  // 在途记录钉在 v1 的 b1 选中项
  recs = await getRecords(port);
  assert.equal(recs[0].configVersion, 1);
  assert.equal(recs[0].branchSelection?.id, 'b1');
  assert.equal(recs[0].plannedResponse?.body, 'slow-b1-1');

  // 实际写出也按旧版本旧选中项
  const oldRes = await inflight;
  assert.equal(oldRes.status, 201);
  assert.equal(oldRes.body, 'slow-b1-1');

  // 新请求用 v2：无分支 -> fallback，计数已重置（位置 0、长度 1）
  const newRes = await sendRequest(port, post('/slow', '{"k":"x"}'));
  assert.equal(newRes.status, 202);
  assert.equal(newRes.body, 'v2-body');
  recs = await getRecords(port);
  assert.equal(recs[1].configVersion, 2);
  assert.deepEqual(recs[1].branchSelection, { kind: 'fallback' });
  assert.equal(recs[1].sequencePosition, 0);
  assert.equal(recs[1].sequenceLength, 1);
});

test('reload 失败保留旧规则、分支、版本与消费位置', { timeout: 20_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', mainConfig());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  const first = await sendRequest(port, post('/orders', '{"state":"paid"}'));
  assert.equal(first.body, 'paid-0');

  await writeFile(file, '{ broken', 'utf8');
  const failed = await sendRequest(port, { method: 'POST', path: '/__contractlab/reload', headers: {}, body: '' });
  const body = JSON.parse(failed.body);
  assert.equal(body.ok, false);
  assert.equal(body.version, 1);

  // 旧分支序列位置保留：下一次 paid 取 paid-1；版本头仍为 1
  const again = await sendRequest(port, post('/orders', '{"state":"paid"}'));
  assert.equal(again.body, 'paid-1');
});

test('非法分支配置：启动整份拒绝（退出 1）且 stderr 定位', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const okRule = { type: 'string' };
  const goodResponses = [resp(200, 'a')];
  const goodBranch = br('x', { '': 'v' }, goodResponses);

  const cases: ReadonlyArray<{ name: string; config: unknown; needle: string }> = [
    {
      name: 'GET 分支',
      config: { endpoints: [{ method: 'GET', path: '/g', responses: goodResponses, branches: [goodBranch] }] },
      needle: 'branches 仅允许在 POST',
    },
    {
      name: 'POST 无正文规则',
      config: { endpoints: [{ method: 'POST', path: '/p', responses: goodResponses, branches: [goodBranch] }] },
      needle: '必须先声明正文规则',
    },
    {
      name: 'branches 空数组',
      config: { endpoints: [{ method: 'POST', path: '/p', requestBody: okRule, responses: goodResponses, branches: [] }] },
      needle: 'branches 必须是非空数组',
    },
    {
      name: '重复 id',
      config: {
        endpoints: [
          {
            method: 'POST',
            path: '/p',
            requestBody: okRule,
            responses: goodResponses,
            branches: [goodBranch, br('x', { '': 'w' }, goodResponses)],
          },
        ],
      },
      needle: 'branches[1].id',
    },
    {
      name: '空 id',
      config: {
        endpoints: [
          { method: 'POST', path: '/p', requestBody: okRule, responses: goodResponses, branches: [br('', { '': 1 }, goodResponses)] },
        ],
      },
      needle: '.id 必须是非空字符串',
    },
    {
      name: '空 when',
      config: {
        endpoints: [
          { method: 'POST', path: '/p', requestBody: okRule, responses: goodResponses, branches: [br('x', {}, goodResponses)] },
        ],
      },
      needle: 'when 必须至少包含一条',
    },
    {
      name: '非法指针（不以 / 开头）',
      config: {
        endpoints: [
          { method: 'POST', path: '/p', requestBody: okRule, responses: goodResponses, branches: [br('x', { 'a/b': 1 }, goodResponses)] },
        ],
      },
      needle: '非根指针必须以',
    },
    {
      name: '非法转义 ~2',
      config: {
        endpoints: [
          { method: 'POST', path: '/p', requestBody: okRule, responses: goodResponses, branches: [br('x', { '/a~2': 1 }, goodResponses)] },
        ],
      },
      needle: '非法转义',
    },
    {
      name: '条件值为数组',
      config: {
        endpoints: [
          { method: 'POST', path: '/p', requestBody: okRule, responses: goodResponses, branches: [br('x', { '': [1] }, goodResponses)] },
        ],
      },
      needle: '条件值必须是字符串、有限数字、布尔或 null',
    },
    {
      name: '分支响应为空',
      config: {
        endpoints: [
          { method: 'POST', path: '/p', requestBody: okRule, responses: goodResponses, branches: [br('x', { '': 1 }, [])] },
        ],
      },
      needle: '.responses 必须是非空数组',
    },
    {
      name: '分支未知字段',
      config: {
        endpoints: [
          {
            method: 'POST',
            path: '/p',
            requestBody: okRule,
            responses: goodResponses,
            branches: [{ ...goodBranch, extra: 1 }],
          },
        ],
      },
      needle: '含未知字段 "extra"',
    },
    {
      name: '分支响应非法状态码',
      config: {
        endpoints: [
          {
            method: 'POST',
            path: '/p',
            requestBody: okRule,
            responses: goodResponses,
            branches: [br('x', { '': 1 }, [{ status: 99, headers: {}, body: '', delay: 0 }])],
          },
        ],
      },
      needle: 'responses[0].status',
    },
  ];

  for (const c of cases) {
    const path = await writeConfig(dir, `bad-${c.name.replace(/\W/g, '_')}.json`, c.config);
    const result = await runCli(['serve', '--config', path, '--port', '0']);
    assert.equal(result.code, 1, `${c.name}: 应退出 1`);
    assert.ok(result.stderr.includes(c.needle), `${c.name}: stderr 应含 "${c.needle}"，实际：${result.stderr}`);
    assert.equal(result.stdout, '', `${c.name}: 不应监听输出`);
  }
});

test('compare：仅判接口与正文接受条件，分支/响应变化不影响结论', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const rule = { type: 'string' };
  const mk = (withBranches: boolean, bodyRule: unknown): unknown => ({
    endpoints: [
      {
        method: 'POST',
        path: '/p',
        requestBody: bodyRule,
        responses: [resp(200, withBranches ? 'fb-a' : 'fb-b')],
        ...(withBranches
          ? { branches: [br('b', { '': 'x' }, [resp(201, 'br-a')])] }
          : {}),
      },
    ],
  });

  const oldFile = await writeConfig(dir, 'old.json', mk(true, rule));
  // 新配置删除分支、修改响应：正文规则未变 -> 兼容
  const newFile = await writeConfig(dir, 'new.json', mk(false, rule));
  const same = await runCompare(oldFile, newFile);
  assert.equal(same.code, 0);
  const report = JSON.parse(same.stdout);
  assert.equal(report.compatible, true);

  // 新配置收紧正文规则 string -> integer：即使保留同样分支也不兼容
  const tightFile = await writeConfig(dir, 'tight.json', mk(true, { type: 'integer' }));
  const tight = await runCompare(oldFile, tightFile);
  assert.equal(tight.code, 1);
  assert.equal(JSON.parse(tight.stdout).compatible, false);
});

test('verify：分支差异不影响通过/拒绝结论；结论只随正文规则翻转', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const v1 = await writeConfig(dir, 'v1.json', mainConfig());
  const server = await startServer(v1);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  // 两支不同分支各一个请求，加一个结构拒绝
  await sendRequest(port, post('/orders', '{"state":"paid"}'));
  await sendRequest(port, post('/orders', '{"state":"new"}'));
  await sendRequest(port, post('/orders', '{"state":123}'));

  const snapReply = await sendRequest(port, { method: 'GET', path: '/__contractlab/requests', headers: {}, body: '' });
  const snapFile = await writeText(dir, 'snap.json', snapReply.body);

  const runVerify = (config: string) => runCli(['verify', '--requests', snapFile, '--config', config]);

  const verify1 = await runVerify(v1);
  assert.equal(verify1.code, 1, '存在一个结构拒绝 -> 退出 1');
  const report1 = JSON.parse(verify1.stdout);
  assert.deepEqual(
    report1.results.map((r: { outcome: string }) => r.outcome),
    ['passed', 'passed', 'rejected'],
  );
  for (const r of report1.results) {
    assert.equal('branchSelection' in r, false, 'verify 报告不含分支字段');
  }

  // 删除所有分支但保留同一正文规则：结论不变
  const noBranches = {
    endpoints: mainConfig().endpoints.map((e) => ({ method: e.method, path: e.path, requestBody: e.requestBody, responses: e.responses })),
  };
  const v1NoBranches = await writeConfig(dir, 'v1-nobranch.json', noBranches);
  const verify2 = await runVerify(v1NoBranches);
  assert.equal(verify2.code, 1);
  assert.deepEqual(
    JSON.parse(verify2.stdout).results.map((r: { outcome: string }) => r.outcome),
    ['passed', 'passed', 'rejected'],
  );
});

test('import：保留分支/顺序/响应仅替换正文规则；移除规则致分支前提失效时退出 2', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const scene: unknown = {
    endpoints: [
      {
        method: 'POST',
        path: '/orders',
        requestBody: { type: 'object', fields: { state: { type: 'string', required: true } }, additionalProperties: false },
        responses: [resp(200, 'fb')],
        branches: [
          br('paid', { '/state': 'paid' }, [resp(201, 'paid-1'), resp(201, 'paid-2')]),
          br('other', { '/state': 'other' }, [resp(202, 'other')]),
        ],
      },
    ],
  };
  const sceneFile = await writeConfig(dir, 'scene.json', scene);

  const api: unknown = {
    openapi: '3.0.0',
    paths: {
      '/orders': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { state: { type: 'string' }, n: { type: 'integer' } },
                  required: ['state'],
                },
              },
            },
          },
        },
      },
    },
  };
  const apiFile = await writeConfig(dir, 'api.json', api);

  const ok = await runCli(['import', '--openapi', apiFile, '--config', sceneFile]);
  assert.equal(ok.code, 0);
  const out = JSON.parse(ok.stdout);
  const ep = out.endpoints[0];
  // requestBody 被替换（新增 n，且 additionalProperties 按 OpenAPI 显式 true）
  assert.ok('n' in ep.requestBody.fields);
  assert.equal(ep.requestBody.additionalProperties, true);
  // branches、顺序与响应原样保留
  assert.deepEqual(
    ep.branches.map((b: { id: string }) => b.id),
    ['paid', 'other'],
  );
  assert.deepEqual(ep.branches[0].responses.map((r: { body: string }) => r.body), ['paid-1', 'paid-2']);
  assert.equal(ep.responses[0].body, 'fb');

  // 导入结果可直接被 serve 加载，且分支行为正常
  const newSceneFile = await writeText(dir, 'imported.json', `${JSON.stringify(out, null, 2)}\n`);
  const server = await startServer(newSceneFile);
  t.after(server.close);
  const port = server.port;
  const r1 = await sendRequest(port, post('/orders', '{"state":"paid","n":1}'));
  assert.equal(r1.body, 'paid-1');

  // OpenAPI 操作未声明 requestBody：移除规则使分支前提失效 -> 退出 2、stdout 空
  const apiNobody: unknown = {
    openapi: '3.0.0',
    paths: { '/orders': { post: { responses: { '200': { description: 'ok' } } } } },
  };
  const nobodyFile = await writeConfig(dir, 'api-nobody.json', apiNobody);
  const reject = await runCli(['import', '--openapi', nobodyFile, '--config', sceneFile]);
  assert.equal(reject.code, 2);
  assert.equal(reject.stdout, '');
  assert.ok(reject.stderr.includes('branches'));
  assert.ok(reject.stderr.includes('paths["/orders"].post'));
});

test('replay：分支请求的计划响应重放到同配置判 same', { timeout: 30_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const file = await writeConfig(dir, 'scenes.json', mainConfig());
  const server = await startServer(file);
  t.after(server.close);
  const port = server.port;
  await clearRecords(port);

  await sendRequest(port, post('/orders', '{"state":"paid"}'));
  await sendRequest(port, post('/orders', '{"state":"new"}'));
  const snapReply = await sendRequest(port, { method: 'GET', path: '/__contractlab/requests', headers: {}, body: '' });
  const snapFile = await writeText(dir, 'snap.json', snapReply.body);

  // 注意：上面两个请求已各自消费了选中序列的第 0 项；用一台全新的同配置服务
  // 重放，序列从 0 开始，计划响应即可与实际一致（same）。
  const fresh = await startServer(file);
  t.after(fresh.close);
  const replay = await runCli(['replay', '--requests', snapFile, '--port', String(fresh.port), '--timeout', '5000']);
  assert.equal(replay.code, 0, replay.stderr);
  const report = JSON.parse(replay.stdout);
  assert.equal(report.total, 2);
  assert.equal(report.same, 2);
  assert.equal(report.different, 0);
  assert.equal(report.failed, 0);
});

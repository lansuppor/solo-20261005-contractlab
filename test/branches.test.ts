// 按请求正文值选择响应分支（branches）的回归测试（真实本机服务 + 真实 HTTP/原始套接字请求）
//
// 覆盖：
// - 重叠条件按配置顺序取第一支；各分支与兜底独立计数、交错消费、耗尽复用末项、
//   查询串共享计数；
// - 400（媒体类型/结构）、404 与未收完整断开都不消费任何序列；
// - 条件语义：缺失不同于 null、不做类型转换、0 与 -0 相等、根指针、空字段名、
//   "__proto__"、~0/~1 转义、数组下标、途经标量不匹配；
// - 请求记录区分 branch/fallback/none，序列位置与长度对应选中序列，
//   计划响应与线上字节一致；清空不取消响应、不重置计数；
// - reload：成功原子替换并重置分支计数、在途延迟响应保留原选中项与旧版本、
//   失败保留旧配置与消费位置；
// - 非法分支配置整份拒绝并定位（compare 通道，退出 2、stderr 定位、stdout 为空）；
// - compare 不受分支差异影响；import 原样保留分支与响应、移除规则致分支失去
//   前提时整份拒绝；verify 对含分支记录的快照结论与在线一致。

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import {
  APP_PATH,
  makeTempDir,
  runCli,
  startServer,
  writeConfig,
  writeText,
  type RunningServer,
} from './helpers.ts';

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: string;
}

function textRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) {
      h['Content-Length'] = String(Buffer.byteLength(body));
    }
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (data += d));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
      );
    });
    r.on('error', reject);
    if (body !== undefined) {
      r.write(body);
    }
    r.end();
  });
}

function postJson(port: number, path: string, json: string): Promise<Reply> {
  return textRequest(port, 'POST', path, json, { 'Content-Type': 'application/json' });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 主场景：两个分支（第一支条件为第二支的真子集，考察重叠优先级）+ 兜底
function mainConfig(vipBodies: [string, string] = ['vip-1', 'vip-2'], vipDelay = 0): unknown {
  return {
    endpoints: [
      {
        method: 'POST',
        path: '/api/order',
        requestBody: {
          type: 'object',
          fields: {
            state: { type: 'string' },
            buyer: { type: 'object', fields: { vip: { type: 'boolean' } } },
          },
          additionalProperties: true,
        },
        branches: [
          {
            id: 'vip-paid',
            when: [
              { pointer: '/buyer/vip', value: true },
              { pointer: '/state', value: 'paid' },
            ],
            responses: [
              { status: 200, headers: {}, body: vipBodies[0], delay: vipDelay },
              { status: 200, headers: {}, body: vipBodies[1], delay: vipDelay },
            ],
          },
          {
            id: 'paid',
            when: [{ pointer: '/state', value: 'paid' }],
            responses: [{ status: 200, headers: {}, body: 'paid-1', delay: 0 }],
          },
        ],
        responses: [
          { status: 200, headers: {}, body: 'fallback-1', delay: 0 },
          { status: 200, headers: {}, body: 'fallback-2', delay: 0 },
        ],
      },
    ],
  };
}

const VIP_PAID = '{"state":"paid","buyer":{"vip":true}}';
const PAID = '{"state":"paid"}';
const CREATED = '{"state":"created"}';

test('重叠条件取第一支；各分支与兜底独立计数、交错消费、耗尽复用末项、查询串共享', async (t) => {
  const dir = await makeTempDir(t);
  const configPath = await writeConfig(dir, 'scenes.json', mainConfig());
  const server: RunningServer = await startServer(configPath);
  t.after(() => server.close());

  const bodies: string[] = [];
  // 交错命中三个序列：vip-paid / paid / fallback
  bodies.push((await postJson(server.port, '/api/order', VIP_PAID)).body); // vip-1
  bodies.push((await postJson(server.port, '/api/order', PAID)).body); // paid-1
  bodies.push((await postJson(server.port, '/api/order', CREATED)).body); // fallback-1
  bodies.push((await postJson(server.port, '/api/order', VIP_PAID)).body); // vip-2
  bodies.push((await postJson(server.port, '/api/order', VIP_PAID)).body); // vip-2（耗尽复用末项）
  bodies.push((await postJson(server.port, '/api/order', PAID)).body); // paid-1（耗尽复用末项）
  bodies.push((await postJson(server.port, '/api/order', CREATED)).body); // fallback-2
  bodies.push((await postJson(server.port, '/api/order', CREATED)).body); // fallback-2（复用）
  // 查询串差异命中同一接口、共享计数
  bodies.push((await postJson(server.port, '/api/order?ignored=yes', VIP_PAID)).body); // vip-2
  assert.deepEqual(bodies, [
    'vip-1',
    'paid-1',
    'fallback-1',
    'vip-2',
    'vip-2',
    'paid-1',
    'fallback-2',
    'fallback-2',
    'vip-2',
  ]);
});

test('400（结构/媒体类型）、404 与未收完整断开都不消费任何序列', async (t) => {
  const dir = await makeTempDir(t);
  const configPath = await writeConfig(dir, 'scenes.json', mainConfig());
  const server = await startServer(configPath);
  t.after(() => server.close());

  // 结构差异 -> 400
  const badStructure = await postJson(server.port, '/api/order', '{"state":123}');
  assert.equal(badStructure.status, 400);
  // 媒体类型不符 -> 400
  const badMedia = await textRequest(server.port, 'POST', '/api/order', PAID, {
    'Content-Type': 'text/plain',
  });
  assert.equal(badMedia.status, 400);
  // 未匹配 -> 404
  const notFound = await textRequest(server.port, 'GET', '/no/such');
  assert.equal(notFound.status, 404);
  // 未收完整即断开：Content-Length 声明 20 字节，只发一半就断开
  const socket = net.connect(server.port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    'POST /api/order HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{"state":"p',
  );
  await sleep(100);
  socket.destroy();
  await sleep(50);

  // 上述请求都没有消费任何序列：三个序列的第一项仍按序给出
  assert.equal((await postJson(server.port, '/api/order', VIP_PAID)).body, 'vip-1');
  assert.equal((await postJson(server.port, '/api/order', PAID)).body, 'paid-1');
  assert.equal((await postJson(server.port, '/api/order', CREATED)).body, 'fallback-1');
});

test('条件语义：缺失不同于 null、不转换类型、0 与 -0 相等、特殊字段名、转义、数组下标、途经标量', async (t) => {
  const dir = await makeTempDir(t);
  const config = {
    endpoints: [
      {
        method: 'POST',
        path: '/api/cond',
        requestBody: { type: 'object', additionalProperties: true },
        branches: [
          {
            id: 'null-state',
            when: [{ pointer: '/state', value: null }],
            responses: [{ status: 200, headers: {}, body: 'null-hit', delay: 0 }],
          },
          {
            id: 'zero',
            when: [{ pointer: '/qty', value: 0 }],
            responses: [{ status: 200, headers: {}, body: 'zero-hit', delay: 0 }],
          },
          {
            id: 'empty-name',
            when: [{ pointer: '/', value: 'x' }],
            responses: [{ status: 200, headers: {}, body: 'empty-hit', delay: 0 }],
          },
          {
            id: 'proto',
            when: [{ pointer: '/__proto__', value: 'p' }],
            responses: [{ status: 200, headers: {}, body: 'proto-hit', delay: 0 }],
          },
          {
            id: 'escaped',
            when: [{ pointer: '/a~1b~0c', value: 1 }],
            responses: [{ status: 200, headers: {}, body: 'esc-hit', delay: 0 }],
          },
          {
            id: 'idx',
            when: [{ pointer: '/tags/0', value: 't' }],
            responses: [{ status: 200, headers: {}, body: 'idx-hit', delay: 0 }],
          },
          {
            id: 'deep',
            when: [{ pointer: '/state/x', value: 1 }],
            responses: [{ status: 200, headers: {}, body: 'deep-hit', delay: 0 }],
          },
        ],
        responses: [{ status: 200, headers: {}, body: 'fb', delay: 0 }],
      },
      {
        method: 'POST',
        path: '/api/root',
        requestBody: { type: 'string' },
        branches: [
          {
            id: 'root-hello',
            when: [{ pointer: '', value: 'hello' }],
            responses: [{ status: 200, headers: {}, body: 'root-hit', delay: 0 }],
          },
        ],
        responses: [{ status: 200, headers: {}, body: 'root-fb', delay: 0 }],
      },
    ],
  };
  const configPath = await writeConfig(dir, 'scenes.json', config);
  const server = await startServer(configPath);
  t.after(() => server.close());

  const cases: Array<[string, string]> = [
    ['{"state":null}', 'null-hit'], // 显式 null 命中
    ['{}', 'fb'], // 缺失不同于 null
    ['{"qty":0}', 'zero-hit'],
    ['{"qty":-0}', 'zero-hit'], // 0 与 -0 相等
    ['{"qty":"0"}', 'fb'], // 不做类型转换
    ['{"qty":0.5}', 'fb'],
    ['{"":"x"}', 'empty-hit'], // 空字段名（指针 "/"）
    ['{"__proto__":"p"}', 'proto-hit'], // __proto__ 按自有字段
    ['{"a/b~c":1}', 'esc-hit'], // ~1 -> /，~0 -> ~
    ['{"a~1b~0c":1}', 'fb'], // 转义是字面语义，不再二次解释
    ['{"tags":["t"]}', 'idx-hit'], // 数组下标
    ['{"tags":[]}', 'fb'], // 下标越界
    ['{"tags":["x","t"]}', 'fb'], // 下标 0 不是 "t"
    ['{"tags":"t"}', 'fb'], // 途经值不是数组
    ['{"state":"str"}', 'fb'], // 途经标量无法继续遍历
  ];
  for (const [body, expected] of cases) {
    const reply = await postJson(server.port, '/api/cond', body);
    assert.equal(reply.status, 200, `请求 ${body} 应被场景响应`);
    assert.equal(reply.body, expected, `请求 ${body}`);
  }

  // 根指针：空字符串指针指向整个正文
  assert.equal((await postJson(server.port, '/api/root', '"hello"')).body, 'root-hit');
  assert.equal((await postJson(server.port, '/api/root', '"other"')).body, 'root-fb');
});

test('请求记录区分 branch/fallback/none，位置与长度对应选中序列，计划响应与线上一致；清空不重置计数', async (t) => {
  const dir = await makeTempDir(t);
  const configPath = await writeConfig(dir, 'scenes.json', mainConfig());
  const server = await startServer(configPath);
  t.after(() => server.close());

  const wire1 = await postJson(server.port, '/api/order', VIP_PAID); // vip-1
  const wire2 = await postJson(server.port, '/api/order', CREATED); // fallback-1
  const wire3 = await postJson(server.port, '/api/order', '{"state":123}'); // 400
  const wire4 = await textRequest(server.port, 'GET', '/no/such'); // 404

  const listReply = await textRequest(server.port, 'GET', '/__contractlab/requests');
  assert.equal(listReply.status, 200);
  const { records } = JSON.parse(listReply.body) as { records: Array<Record<string, unknown>> };
  assert.equal(records.length, 4);

  const [r1, r2, r3, r4] = records as [
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  // 分支命中：位置/长度对应分支自己的序列
  assert.equal(r1.selection, 'branch');
  assert.equal(r1.branch, 'vip-paid');
  assert.equal(r1.sequencePosition, 0);
  assert.equal(r1.sequenceLength, 2);
  assert.equal((r1.plannedResponse as { body: string }).body, wire1.body);
  // 兜底：branch 为 null，位置/长度对应兜底序列
  assert.equal(r2.selection, 'fallback');
  assert.equal(r2.branch, null);
  assert.equal(r2.sequencePosition, 0);
  assert.equal(r2.sequenceLength, 2);
  assert.equal((r2.plannedResponse as { body: string }).body, wire2.body);
  // 400：未选择，无消费位置
  assert.equal(r3.selection, 'none');
  assert.equal(r3.branch, null);
  assert.equal(r3.sequencePosition, null);
  assert.equal(r3.sequenceLength, null);
  assert.equal((r3.plannedResponse as { status: number }).status, 400);
  assert.equal((r3.plannedResponse as { body: string }).body, wire3.body);
  // 404：未选择
  assert.equal(r4.selection, 'none');
  assert.equal(r4.branch, null);
  assert.equal(r4.matched, false);
  assert.equal((r4.plannedResponse as { body: string }).body, wire4.body);

  // 清空记录：不取消响应、不重置任何计数；旧记录不重现
  const clear = await textRequest(server.port, 'POST', '/__contractlab/requests/clear');
  assert.equal(clear.status, 200);
  assert.equal(JSON.parse(clear.body).removed, 4);
  const afterClear = await postJson(server.port, '/api/order', VIP_PAID);
  assert.equal(afterClear.body, 'vip-2', '清空不重置分支计数');
  const list2 = await textRequest(server.port, 'GET', '/__contractlab/requests');
  const records2 = (JSON.parse(list2.body) as { records: Array<Record<string, unknown>> }).records;
  assert.equal(records2.length, 1, '清空前已接收的请求不得重现');
  assert.equal(records2[0].selection, 'branch');
  assert.equal(records2[0].sequencePosition, 1);
});

test('reload：成功原子替换并重置分支计数、在途延迟响应保留原选中项与旧版本、失败保留旧配置与消费位置', async (t) => {
  const dir = await makeTempDir(t);
  const configPath = await writeConfig(
    dir,
    'scenes.json',
    mainConfig(['vip-old-1', 'vip-old-2'], 400),
  );
  const server = await startServer(configPath);
  t.after(() => server.close());

  // 发起延迟响应的分支请求（预留 vip-old-1，400ms 后才发送）
  const pending = postJson(server.port, '/api/order', VIP_PAID);
  await sleep(80);

  // reload 成功：版本 +1，分支计数重置
  await writeConfig(dir, 'scenes.json', mainConfig(['vip-new-1', 'vip-new-2'], 0));
  const reload = await textRequest(server.port, 'POST', '/__contractlab/reload');
  assert.deepEqual(JSON.parse(reload.body), { ok: true, version: 2 });

  // 在途请求仍按旧快照响应：旧正文、旧版本头
  const delayed = await pending;
  assert.equal(delayed.body, 'vip-old-1');
  assert.equal(delayed.headers['x-contractlab-version'], '1');

  // 新请求使用新配置：分支计数从第 1 项重新开始
  const first = await postJson(server.port, '/api/order', VIP_PAID);
  assert.equal(first.body, 'vip-new-1');
  assert.equal(first.headers['x-contractlab-version'], '2');

  // reload 失败（非法分支配置）：保留旧配置、版本与各序列消费位置
  await writeText(dir, 'scenes.json', '{"endpoints":');
  const failed = await textRequest(server.port, 'POST', '/__contractlab/reload');
  const failedBody = JSON.parse(failed.body) as { ok: boolean; version: number; error: string };
  assert.equal(failedBody.ok, false);
  assert.equal(failedBody.version, 2);
  const second = await postJson(server.port, '/api/order', VIP_PAID);
  assert.equal(second.body, 'vip-new-2', '失败的 reload 不得重置分支消费位置');
  assert.equal(second.headers['x-contractlab-version'], '2');

  // 在途请求的记录钉住旧版本与旧计划响应，不随 reload 改变
  const list = await textRequest(server.port, 'GET', '/__contractlab/requests');
  const { records } = JSON.parse(list.body) as {
    records: Array<Record<string, unknown>>;
  };
  assert.equal(records.length, 3);
  assert.equal(records[0].configVersion, 1);
  assert.equal(records[0].selection, 'branch');
  assert.equal(records[0].branch, 'vip-paid');
  assert.equal((records[0].plannedResponse as { body: string }).body, 'vip-old-1');
  assert.equal(
    (records[0].plannedResponse as { headers: Record<string, string> }).headers[
      'X-Contractlab-Version'
    ],
    '1',
  );
  assert.equal(records[1].configVersion, 2);
  assert.equal(records[2].configVersion, 2);
});

// ---------------------------------------------------------------------------
// 配置校验：非法分支配置整份拒绝并定位（经 compare 通道：退出 2、stderr 定位、
// stdout 为空；serve 启动同样拒绝）
// ---------------------------------------------------------------------------

function endpointWith(branches: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    endpoints: [
      {
        method: 'POST',
        path: '/api/order',
        requestBody: { type: 'object', additionalProperties: true },
        responses: [{ status: 200, headers: {}, body: 'fb', delay: 0 }],
        branches,
        ...extra,
      },
    ],
  };
}

function validBranch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b1',
    when: [{ pointer: '/state', value: 'paid' }],
    responses: [{ status: 200, headers: {}, body: 'b1-1', delay: 0 }],
    ...overrides,
  };
}

async function expectConfigRejected(
  t: test.TestContext,
  name: string,
  config: unknown,
  markers: readonly string[],
): Promise<void> {
  await t.test(name, async (t2) => {
    const dir = await makeTempDir(t2);
    const badPath = await writeConfig(dir, 'bad.json', config);
    const goodPath = await writeConfig(dir, 'good.json', mainConfig());
    const result = await runCli(['compare', '--old', badPath, '--new', goodPath]);
    assert.equal(result.code, 2, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, '', '失败时 stdout 必须为空');
    for (const marker of markers) {
      assert.ok(result.stderr.includes(marker), `stderr 应包含 ${marker}：${result.stderr}`);
    }
    // serve 启动同样整份拒绝（退出 1，不留下监听）
    const serve = await runCli(['serve', '--config', badPath, '--port', '0']);
    assert.equal(serve.code, 1, `stderr: ${serve.stderr}`);
    for (const marker of markers) {
      assert.ok(serve.stderr.includes(marker), `serve stderr 应包含 ${marker}：${serve.stderr}`);
    }
  });
}

test('非法分支配置整份拒绝并定位', async (t) => {
  await expectConfigRejected(
    t,
    'GET 接口禁止分支',
    {
      endpoints: [
        {
          method: 'GET',
          path: '/api/g',
          responses: [{ status: 200, headers: {}, body: 'g', delay: 0 }],
          branches: [validBranch()],
        },
      ],
    },
    ['endpoints[0].branches', 'POST'],
  );

  await expectConfigRejected(
    t,
    '未声明 requestBody 的 POST 禁止分支',
    {
      endpoints: [
        {
          method: 'POST',
          path: '/api/p',
          responses: [{ status: 200, headers: {}, body: 'p', delay: 0 }],
          branches: [validBranch()],
        },
      ],
    },
    ['endpoints[0].branches', 'requestBody'],
  );

  await expectConfigRejected(
    t,
    '分支标识重复',
    endpointWith([validBranch(), validBranch({ id: 'b1', when: [{ pointer: '/x', value: 1 }] })]),
    ['endpoints[0].branches[1].id', '重复'],
  );

  await expectConfigRejected(
    t,
    '分支标识为空',
    endpointWith([validBranch({ id: '' })]),
    ['endpoints[0].branches[0].id', '非空字符串'],
  );

  await expectConfigRejected(
    t,
    '指针不是合法 RFC 6901（缺少前导斜杠）',
    endpointWith([validBranch({ when: [{ pointer: 'state', value: 'paid' }] })]),
    ['endpoints[0].branches[0].when[0].pointer'],
  );

  await expectConfigRejected(
    t,
    '指针含非法 ~ 转义',
    endpointWith([validBranch({ when: [{ pointer: '/a~2b', value: 1 }] })]),
    ['endpoints[0].branches[0].when[0].pointer', '转义'],
  );

  await expectConfigRejected(
    t,
    '条件值为对象',
    endpointWith([validBranch({ when: [{ pointer: '/state', value: { x: 1 } }] })]),
    ['endpoints[0].branches[0].when[0].value'],
  );

  await expectConfigRejected(
    t,
    '条件缺少 value 字段',
    endpointWith([validBranch({ when: [{ pointer: '/state' }] })]),
    ['endpoints[0].branches[0].when[0]', 'value'],
  );

  await expectConfigRejected(
    t,
    'when 为空数组',
    endpointWith([validBranch({ when: [] })]),
    ['endpoints[0].branches[0].when', '非空'],
  );

  await expectConfigRejected(
    t,
    '分支 responses 为空数组',
    endpointWith([validBranch({ responses: [] })]),
    ['endpoints[0].branches[0].responses', '非空'],
  );

  await expectConfigRejected(
    t,
    '分支响应项非法（状态码越界）',
    endpointWith([
      validBranch({ responses: [{ status: 199, headers: {}, body: 'x', delay: 0 }] }),
    ]),
    ['endpoints[0].branches[0].responses[0].status'],
  );

  await expectConfigRejected(
    t,
    '分支含未知字段',
    endpointWith([validBranch({ note: 'x' })]),
    ['endpoints[0].branches[0]', '未知字段'],
  );

  await expectConfigRejected(
    t,
    '条件含未知字段',
    endpointWith([validBranch({ when: [{ pointer: '/s', value: 1, op: 'eq' }] })]),
    ['endpoints[0].branches[0].when[0]', '未知字段'],
  );

  await expectConfigRejected(
    t,
    'branches 为空数组',
    endpointWith([]),
    ['endpoints[0].branches', '非空'],
  );

  await expectConfigRejected(
    t,
    '接口含未知字段（branches 拼写错误的近亲）',
    {
      endpoints: [
        {
          method: 'POST',
          path: '/api/p',
          requestBody: { type: 'object' },
          responses: [{ status: 200, headers: {}, body: 'p', delay: 0 }],
          branch: [],
        },
      ],
    },
    ['endpoints[0]', '未知字段'],
  );
});

test('compare 只判接口与正文接受条件：分支差异不影响结论', async (t) => {
  const dir = await makeTempDir(t);
  const oldPath = await writeConfig(dir, 'old.json', mainConfig());
  // 同一接口与正文规则，仅分支与响应不同
  const changed = mainConfig(['vip-x', 'vip-y']);
  (changed as { endpoints: Array<{ branches: unknown[] }> }).endpoints[0].branches.pop();
  const newPath = await writeConfig(dir, 'new.json', changed);
  const result = await runCli(['compare', '--old', oldPath, '--new', newPath]);
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).compatible, true);
});

test('import 保留分支、顺序与响应，仅替换正文规则；移除规则致分支失去前提时整份拒绝', async (t) => {
  const dir = await makeTempDir(t);
  const scene = mainConfig();
  const scenePath = await writeConfig(dir, 'scenes.json', scene);

  const openapi = {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: {
      '/api/order': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { state: { type: 'string' } },
                  required: ['state'],
                },
              },
            },
          },
        },
      },
    },
  };
  const openapiPath = await writeConfig(dir, 'api.json', openapi);

  // 成功：branches 与 responses 原样保留，requestBody 被替换
  const ok = await runCli(['import', '--openapi', openapiPath, '--config', scenePath]);
  assert.equal(ok.code, 0, `stderr: ${ok.stderr}`);
  const imported = JSON.parse(ok.stdout) as {
    endpoints: Array<Record<string, unknown>>;
  };
  const original = (scene as { endpoints: Array<Record<string, unknown>> }).endpoints[0];
  assert.deepEqual(imported.endpoints[0].branches, original.branches, '分支原样保留');
  assert.deepEqual(imported.endpoints[0].responses, original.responses, '响应原样保留');
  assert.notDeepEqual(imported.endpoints[0].requestBody, original.requestBody);
  assert.deepEqual(imported.endpoints[0].requestBody, {
    type: 'object',
    fields: { state: { type: 'string', required: true } },
    additionalProperties: true,
  });

  // 导入结果可直接 serve：分支选择按新正文规则工作
  const importedPath = await writeText(dir, 'imported.json', ok.stdout);
  const server = await startServer(importedPath);
  t.after(() => server.close());
  assert.equal((await postJson(server.port, '/api/order', VIP_PAID)).body, 'vip-1');
  assert.equal((await postJson(server.port, '/api/order', CREATED)).body, 'fallback-1');
  await server.close();

  // POST 操作未声明 requestBody -> 移除规则 -> 分支失去前提：整份拒绝
  const openapiNoBody = {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: { '/api/order': { post: {} } },
  };
  const noBodyPath = await writeConfig(dir, 'api-nobody.json', openapiNoBody);
  const rejected = await runCli(['import', '--openapi', noBodyPath, '--config', scenePath]);
  assert.equal(rejected.code, 2);
  assert.equal(rejected.stdout, '', '失败时 stdout 必须为空');
  assert.ok(
    rejected.stderr.includes('endpoints[0].branches'),
    `stderr 应定位分支位置：${rejected.stderr}`,
  );
  assert.ok(
    rejected.stderr.includes(scenePath),
    `stderr 应指明场景文件：${rejected.stderr}`,
  );
});

test('verify 对含分支记录的快照结论与在线一致', async (t) => {
  const dir = await makeTempDir(t);
  const configPath = await writeConfig(dir, 'scenes.json', mainConfig());
  const server = await startServer(configPath);
  t.after(() => server.close());

  await postJson(server.port, '/api/order', VIP_PAID); // 分支
  await postJson(server.port, '/api/order', CREATED); // 兜底
  const snapshot = await textRequest(server.port, 'GET', '/__contractlab/requests');
  const snapshotPath = await writeText(dir, 'snapshot.json', snapshot.body);

  const result = await runCli(['verify', '--requests', snapshotPath, '--config', configPath]);
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const report = JSON.parse(result.stdout) as {
    total: number;
    accepted: number;
    results: Array<{ outcome: string }>;
  };
  assert.equal(report.total, 2);
  assert.equal(report.accepted, 2);
  assert.deepEqual(
    report.results.map((r) => r.outcome),
    ['passed', 'passed'],
  );
});

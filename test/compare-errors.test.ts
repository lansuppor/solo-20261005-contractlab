// 失败路径：任一输入文件读取、JSON 解析或递归配置校验失败时，
// compare 必须以状态码 2 退出、stderr 给出可定位原因、stdout 不出现部分报告。

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { makeTempDir, runCompare, writeConfig } from './helpers.ts';

const OK_RESPONSE = { status: 200, headers: {}, body: 'ok', delay: 0 };
const VALID_CONFIG = {
  endpoints: [
    {
      method: 'POST',
      path: '/api/echo',
      requestBody: { type: 'object', fields: { id: { type: 'integer' } } },
      responses: [OK_RESPONSE],
    },
  ],
};

// 公共断言：退出 2、stdout 无任何部分报告、stderr 命中全部定位片段
function assertFailure(
  name: string,
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean },
  stderrFragments: string[],
): void {
  assert.equal(result.timedOut, false, `${name}：compare 超时`);
  assert.equal(result.code, 2, `${name}：退出码应为 2，stderr=${result.stderr}`);
  assert.equal(result.stdout, '', `${name}：stdout 不得出现部分报告`);
  for (const fragment of stderrFragments) {
    assert.ok(
      result.stderr.includes(fragment),
      `${name}：stderr 应包含可定位片段 ${JSON.stringify(fragment)}，实际：${result.stderr}`,
    );
  }
}

test('旧文件读取失败：退出 2、stderr 指向旧文件、stdout 无报告', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const missing = path.join(dir, 'missing-old.json');
  const newFile = await writeConfig(dir, 'new.json', VALID_CONFIG);
  const result = await runCompare(missing, newFile);
  assertFailure('旧文件读取失败', result, ['旧文件', missing]);
});

test('新文件读取失败：退出 2、stderr 指向新文件、stdout 无报告', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const oldFile = await writeConfig(dir, 'old.json', VALID_CONFIG);
  const missing = path.join(dir, 'missing-new.json');
  const result = await runCompare(oldFile, missing);
  assertFailure('新文件读取失败', result, ['新文件', missing]);
});

test('新文件 JSON 解析失败：退出 2、stderr 可定位、stdout 无报告', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const oldFile = await writeConfig(dir, 'old.json', VALID_CONFIG);
  const broken = await writeConfig(dir, 'broken.json', '{"endpoints": [ , ]');
  const result = await runCompare(oldFile, broken);
  assertFailure('新文件 JSON 解析失败', result, ['新文件', broken, 'JSON']);
});

test('递归配置校验失败（嵌套规则未知字段）：退出 2、stderr 含嵌套位置', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const oldFile = await writeConfig(dir, 'old.json', VALID_CONFIG);
  const invalid = await writeConfig(dir, 'invalid.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/api/echo',
        requestBody: {
          type: 'object',
          fields: {
            tags: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
        },
        responses: [OK_RESPONSE],
      },
    ],
  });
  const result = await runCompare(oldFile, invalid);
  assertFailure('递归配置校验失败', result, [
    '新文件',
    invalid,
    'endpoints[0].requestBody.fields["tags"].items',
    'minLength',
  ]);
});

test('递归配置校验失败（GET 接口声明 requestBody）：退出 2、stderr 可定位', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const invalid = await writeConfig(dir, 'invalid.json', {
    endpoints: [
      {
        method: 'GET',
        path: '/api/a',
        requestBody: { type: 'string' },
        responses: [OK_RESPONSE],
      },
    ],
  });
  const newFile = await writeConfig(dir, 'new.json', VALID_CONFIG);
  const result = await runCompare(invalid, newFile);
  assertFailure('GET 接口声明 requestBody', result, ['旧文件', invalid, 'endpoints[0]', 'requestBody']);
});

test('两份文件均失败：退出 2、两条错误都出现在 stderr、stdout 无报告', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const missing = path.join(dir, 'missing-old.json');
  const broken = await writeConfig(dir, 'broken-new.json', 'not json at all');
  const result = await runCompare(missing, broken);
  assertFailure('两份文件均失败', result, ['旧文件', missing, '新文件', broken]);
});

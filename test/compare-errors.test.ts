// compare 输入失败的回归测试
//
// 任一输入文件读取失败、JSON 解析失败或递归配置校验失败时：
// - 退出码必须为 2；
// - stderr 必须指明文件与可定位原因（含配置内的位置路径）；
// - stdout 不得出现部分报告（一个字节都不行）。

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  makeTempDir,
  runCompare,
  sceneResponse,
  writeConfig,
  writeText,
} from './helpers.ts';

const VALID_CONFIG = {
  endpoints: [
    {
      method: 'POST',
      path: '/api/ok',
      requestBody: {
        type: 'object',
        fields: { id: { type: 'integer', required: true } },
        additionalProperties: false,
      },
      responses: [sceneResponse()],
    },
  ],
};

test('旧文件读取失败：退出 2、stderr 可定位、stdout 无部分报告', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const missing = path.join(dir, 'does-not-exist.json');
  const newFile = await writeConfig(dir, 'new.json', VALID_CONFIG);

  const result = await runCompare(missing, newFile);
  assert.equal(result.code, 2, `读取失败应退出 2，实际 ${result.code}\nstdout:\n${result.stdout}`);
  assert.equal(result.stdout, '', '失败时 stdout 不得出现部分报告');
  assert.ok(result.stderr.includes(missing), `stderr 应指明失败文件：\n${result.stderr}`);
});

test('新文件 JSON 解析失败：退出 2、stderr 可定位、stdout 无部分报告', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const oldFile = await writeConfig(dir, 'old.json', VALID_CONFIG);
  const badJson = await writeText(dir, 'bad.json', '{ "endpoints": [ \n  not-json');

  const result = await runCompare(oldFile, badJson);
  assert.equal(result.code, 2, `解析失败应退出 2，实际 ${result.code}`);
  assert.equal(result.stdout, '', '失败时 stdout 不得出现部分报告');
  assert.ok(result.stderr.includes(badJson), `stderr 应指明失败文件：\n${result.stderr}`);
  assert.ok(/JSON/i.test(result.stderr), `stderr 应说明是 JSON 解析问题：\n${result.stderr}`);
});

test('递归配置校验失败：退出 2、stderr 给出嵌套位置、stdout 无部分报告', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const oldFile = await writeConfig(dir, 'old.json', VALID_CONFIG);
  // 深层规则错误：object 字段 a 的数组规则缺少 items
  const invalid = await writeConfig(dir, 'invalid-rule.json', {
    endpoints: [
      {
        method: 'POST',
        path: '/api/deep',
        requestBody: {
          type: 'object',
          fields: { a: { type: 'array' } },
          additionalProperties: false,
        },
        responses: [sceneResponse()],
      },
    ],
  });

  const result = await runCompare(oldFile, invalid);
  assert.equal(result.code, 2, `校验失败应退出 2，实际 ${result.code}`);
  assert.equal(result.stdout, '', '失败时 stdout 不得出现部分报告');
  assert.ok(result.stderr.includes(invalid), `stderr 应指明失败文件：\n${result.stderr}`);
  assert.ok(
    result.stderr.includes('endpoints[0].requestBody.fields["a"]'),
    `stderr 应给出可定位的嵌套位置：\n${result.stderr}`,
  );
});

test('两份文件都失败：退出 2、stderr 同时定位两份文件、stdout 无输出', { timeout: 60_000 }, async (t) => {
  const dir = await makeTempDir(t);
  const missing = path.join(dir, 'missing-old.json');
  const badJson = await writeText(dir, 'bad-new.json', '<<<');

  const result = await runCompare(missing, badJson);
  assert.equal(result.code, 2, `任一失败都应退出 2，实际 ${result.code}`);
  assert.equal(result.stdout, '', '失败时 stdout 不得出现部分报告');
  assert.ok(result.stderr.includes(missing), `stderr 应定位旧文件：\n${result.stderr}`);
  assert.ok(result.stderr.includes(badJson), `stderr 应定位新文件：\n${result.stderr}`);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { redactLogText } = require('../src/http/router');

test('日志文本遮蔽邮箱并移除 ANSI 控制符', () => {
  assert.equal(redactLogText('\u001b[31mops@example.com\u001b[0m failed'), '<email> failed');
});

test('日志文本截断到 500 字符', () => {
  assert.equal(redactLogText('x'.repeat(600)).length, 500);
});

test('空值安全处理', () => {
  assert.equal(redactLogText(null), '');
  assert.equal(redactLogText(undefined), '');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HistoryService } = require('../src/services/historyService');

test('历史文件超过上限时只保留最近记录', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acmedesk-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'history.jsonl');
  const service = new HistoryService(file, { maxBytes: 220 });

  for (let index = 0; index < 6; index += 1) {
    service.append({
      type: 'renew',
      target: `d${index}.example.com`,
      status: 'success',
      durationMs: index,
      exitCode: 0
    });
  }

  const size = fs.statSync(file).size;
  assert.ok(size <= 220, `文件大小 ${size} 超过上限`);

  const records = service.read(100);
  assert.ok(records.length >= 1);
  assert.equal(records[0].target, 'd5.example.com');
});

test('历史记录缺失时返回空列表', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acmedesk-history-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const service = new HistoryService(path.join(dir, 'history.jsonl'));
  assert.deepEqual(service.read(), []);
});

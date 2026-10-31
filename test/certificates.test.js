'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCertificates,
  summarize,
  daysLeft,
  toIso
} = require('../src/domain/certificates');

const NOW = Date.parse('2026-10-31T00:00:00Z');
const FUTURE = Math.floor(Date.parse('2027-01-29T06:46:00Z') / 1000);
const PAST = Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000);
const NEXT_RENEW = Math.floor(Date.parse('2026-12-29T11:10:32Z') / 1000);

function line({ domain, alt = '', keyLength = '2048', webroot = '/srv/acme', ca = 'https://acme-v02.api.letsencrypt.org/directory', start = FUTURE - 90 * 86400, end = FUTURE, dir = '' }) {
  return [domain, alt, keyLength, webroot, ca, NEXT_RENEW, start, end, dir || domain].join('\t');
}

test('解析生产与测试证书并区分状态', () => {
  const raw = [
    line({ domain: 'update.example.com', dir: 'update.example.com' }),
    line({
      domain: 'staging.example.com',
      keyLength: 'ec-256',
      ca: 'https://acme-staging-v02.api.letsencrypt.org/directory',
      dir: 'staging.example.com_ecc'
    })
  ].join('\n');

  const items = parseCertificates(raw, NOW);
  assert.equal(items.length, 2);

  const production = items.find((item) => item.domain === 'update.example.com');
  assert.equal(production.staging, false);
  assert.equal(production.keyAlgorithm, 'RSA');
  assert.equal(production.status, 'active');
  assert.equal(production.notAfter, new Date(FUTURE * 1000).toISOString());

  const staging = items.find((item) => item.domain === 'staging.example.com');
  assert.equal(staging.staging, true);
  assert.equal(staging.keyAlgorithm, 'ECDSA');
  assert.equal(staging.status, 'staging');
});

test('剩余天数按 UTC 精确换算', () => {
  const expected = Math.floor((FUTURE * 1000 - NOW) / 86400000);
  assert.equal(daysLeft(new Date(FUTURE * 1000).toISOString(), NOW), expected);
  assert.equal(daysLeft(null, NOW), null);
});

test('过期证书标记为 expired 并排在最前', () => {
  const raw = [
    line({ domain: 'fresh.example.com' }),
    line({ domain: 'old.example.com', start: PAST - 90 * 86400, end: PAST })
  ].join('\n');
  const items = parseCertificates(raw, NOW);
  assert.equal(items[0].domain, 'old.example.com');
  assert.equal(items[0].status, 'expired');
  assert.ok(items[0].daysLeft < 0);
});

test('SAN 列表排除主域名并去重', () => {
  const raw = line({ domain: 'a.example.com', alt: 'www.a.example.com, a.example.com, api.a.example.com,www.a.example.com' });
  const items = parseCertificates(raw, NOW);
  assert.deepEqual(items[0].altNames, ['www.a.example.com', 'api.a.example.com']);
});

test('acme.sh 的无 SAN 占位值不当作备用域名', () => {
  const raw = line({ domain: 'solo.example.com', alt: 'no' });
  assert.deepEqual(parseCertificates(raw, NOW)[0].altNames, []);
});

test('字段不足的行被丢弃，空输入返回空列表', () => {
  const broken = 'only.example.com\talt\t2048\t/var/www';
  assert.deepEqual(parseCertificates(broken, NOW), []);
  assert.deepEqual(parseCertificates('', NOW), []);
});

test('汇总统计区分正式、测试与需关注数量', () => {
  const raw = [
    line({ domain: 'active.example.com' }),
    line({ domain: 'soon.example.com', start: PAST - 80 * 86400, end: PAST + 5 * 86400 }),
    line({ domain: 'expired.example.com', start: PAST - 100 * 86400, end: PAST - 86400 }),
    line({
      domain: 'stage.example.com',
      ca: 'https://acme-staging-v02.api.letsencrypt.org/directory'
    })
  ].join('\n');
  const items = parseCertificates(raw, NOW);
  const summary = summarize(items, NOW);

  assert.equal(summary.total, 4);
  assert.equal(summary.production, 3);
  assert.equal(summary.staging, 1);
  assert.equal(summary.expiring, 2);
  assert.equal(summary.nearest.domain, 'expired.example.com');
});

test('非法时间戳不产生无效日期字符串', () => {
  assert.equal(toIso('0'), null);
  assert.equal(toIso('abc'), null);
  assert.equal(toIso('1761900000'), new Date(1761900000 * 1000).toISOString());
});

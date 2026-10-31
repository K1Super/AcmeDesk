'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOriginPolicy } = require('../src/http/originPolicy');

const assertAllowed = createOriginPolicy({ port: 8787 });

test('允许本机回环 Host', () => {
  assert.equal(assertAllowed({ host: '127.0.0.1:8787' }), null);
  assert.equal(assertAllowed({ host: 'localhost:8787' }), null);
});

test('拒绝非同源 Host，阻断 DNS rebinding', () => {
  assert.equal(assertAllowed({ host: 'evil.example.com:8787' }), 'host');
  assert.equal(assertAllowed({ host: '' }), 'host');
  assert.equal(assertAllowed({}), 'host');
});

test('拒绝跨站 Origin 与 Sec-Fetch-Site', () => {
  assert.equal(assertAllowed({ host: '127.0.0.1:8787', origin: 'http://evil.example.com' }), 'origin');
  assert.equal(assertAllowed({ host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }), 'site');
  assert.equal(assertAllowed({ host: '127.0.0.1:8787', 'sec-fetch-site': 'same-site' }), 'site');
});

test('允许同源 Origin 与直接访问', () => {
  assert.equal(assertAllowed({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' }), null);
  assert.equal(assertAllowed({ host: 'localhost:8787', origin: 'http://localhost:8787' }), null);
  assert.equal(assertAllowed({ host: '127.0.0.1:8787', 'sec-fetch-site': 'none' }), null);
  assert.equal(assertAllowed({ host: '127.0.0.1:8787', 'sec-fetch-site': 'same-origin' }), null);
});

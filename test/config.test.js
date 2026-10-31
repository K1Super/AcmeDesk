'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateSettings, isConfigured, resolveServerPort } = require('../src/config');
const { ValidationError } = require('../src/domain/validation');

const complete = {
  sshHost: 'server.example.com',
  sshPort: 22,
  sshUser: 'deploy',
  sshKeyPath: 'C:\\keys\\deploy.pem',
  issueScript: '/opt/issue-cert.sh',
  acmeHome: '/root/.acme.sh',
  defaultEmail: 'ops@example.com',
  defaultWebroot: '/srv/acme',
  defaultKeyType: '2048'
};

test('未配置时返回空字段与默认端口', () => {
  const settings = validateSettings({});
  assert.equal(settings.sshHost, '');
  assert.equal(settings.sshUser, '');
  assert.equal(settings.sshKeyPath, '');
  assert.equal(settings.issueScript, '');
  assert.equal(settings.acmeHome, '');
  assert.equal(settings.sshPort, 22);
  assert.equal(isConfigured(settings), false);
});

test('保存时缺少核心字段会被拒绝', () => {
  assert.throws(
    () => validateSettings({ sshHost: 'server.example.com' }, { requireComplete: true }),
    ValidationError
  );
});

test('完整配置通过校验并视为已配置', () => {
  const settings = validateSettings(complete, { requireComplete: true });
  assert.equal(settings.sshHost, 'server.example.com');
  assert.equal(settings.sshPort, 22);
  assert.equal(settings.defaultWebroot, '/srv/acme');
  assert.equal(isConfigured(settings), true);
});

test('保存时校验私钥文件是否存在', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acmedesk-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const keyPath = path.join(dir, 'deploy.pem');
  assert.throws(
    () => validateSettings({ ...complete, sshKeyPath: keyPath }, {
      requireComplete: true,
      checkKeyExists: true
    }),
    ValidationError
  );

  fs.writeFileSync(keyPath, '', 'utf8');
  assert.doesNotThrow(() => validateSettings({ ...complete, sshKeyPath: keyPath }, {
    requireComplete: true,
    checkKeyExists: true
  }));
});

test('监听端口只接受 1-65535 的整数', () => {
  assert.equal(resolveServerPort(undefined), 8787);
  assert.equal(resolveServerPort(''), 8787);
  assert.equal(resolveServerPort('9000'), 9000);
  assert.throws(() => resolveServerPort('abc'), ValidationError);
  assert.throws(() => resolveServerPort('0x16'), ValidationError);
  assert.throws(() => resolveServerPort('+22'), ValidationError);
  assert.throws(() => resolveServerPort('0'), ValidationError);
  assert.throws(() => resolveServerPort('65536'), ValidationError);
  assert.throws(() => resolveServerPort('22.5'), ValidationError);
});

test('非法端口被拒绝', () => {
  assert.throws(
    () => validateSettings({ ...complete, sshPort: '70000' }),
    ValidationError
  );
});

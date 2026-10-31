'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  quote,
  buildIssueCommand,
  buildRenewCommand,
  buildRevokeCommand,
  buildDownloadPath,
  buildListScript,
  buildPrecheckCommand,
  buildPrecheckScript,
  buildRemotePidFile,
  buildWrappedJobCommand,
  buildTerminationScript,
  buildTerminationCommand
} = require('../src/domain/commands');
const { ValidationError } = require('../src/domain/validation');

test('单引号转义可安全嵌入 shell 参数', () => {
  assert.equal(quote("it's"), "'it'\\''s'");
  assert.equal(quote(''), "''");
});

test('签发命令包含所有参数与开关', () => {
  const command = buildIssueCommand({
    issueScript: '/opt/issue-cert.sh',
    domains: ' update.example.com,www.update.example.com ',
    webroot: '/srv/acme',
    email: 'ops@example.com',
    keyType: '2048',
    staging: true,
    force: false
  });
  assert.match(command, /^'/);
  assert.match(command, /-d 'update.example.com' -d 'www.update.example.com'/);
  assert.match(command, /-w '\/srv\/acme'/);
  assert.match(command, /-e 'ops@example\.com'/);
  assert.match(command, /-k '2048'/);
  assert.match(command, /--staging/);
  assert.doesNotMatch(command, /--force/);
});

test('签发命令拒绝注入型域名', () => {
  assert.throws(() => buildIssueCommand({
    issueScript: '/opt/issue-cert.sh',
    domains: "a.example.com;reboot",
    webroot: '/srv/acme',
    email: 'ops@example.com',
    keyType: '2048'
  }), ValidationError);
});

test('ECDSA 续期命令带 --ecc，RSA 不带', () => {
  const ec = buildRenewCommand({
    acmeHome: '/root/.acme.sh',
    domain: 'update.example.com',
    keyType: 'ec-256'
  });
  assert.match(ec, /'\/root\/\.acme\.sh\/acme\.sh' --renew -d 'update.example.com' --ecc --force/);

  const rsa = buildRenewCommand({
    acmeHome: '/root/.acme.sh',
    domain: 'update.example.com',
    keyType: '2048'
  });
  assert.doesNotMatch(rsa, /--ecc/);
});

test('吊销命令在吊销成功后移出续期列表', () => {
  const command = buildRevokeCommand({
    acmeHome: '/root/.acme.sh',
    domain: 'update.example.com',
    keyType: '2048'
  });
  assert.match(command, /--revoke -d 'update\.example\.com' && /);
  assert.match(command, /--remove -d 'update\.example\.com'/);
  assert.doesNotMatch(command, /--ecc/);
  assert.doesNotMatch(command, /--staging/);
});

test('ECDSA 与测试证书的吊销参数正确', () => {
  const command = buildRevokeCommand({
    acmeHome: '/root/.acme.sh',
    domain: 'update.example.com',
    keyType: 'ec-256',
    staging: true
  });
  assert.match(command, /--revoke -d 'update\.example\.com' --ecc --staging && /);
  assert.equal((command.match(/--ecc/g) || []).length, 2);
  assert.match(command, /--remove -d 'update\.example\.com' --ecc/);
});

test('吊销命令拒绝注入型域名', () => {
  assert.throws(() => buildRevokeCommand({
    acmeHome: '/root/.acme.sh',
    domain: "a.example.com';reboot;'",
    keyType: '2048'
  }), ValidationError);
});

test('下载路径按密钥类型落到正确目录', () => {
  assert.equal(
    buildDownloadPath({
      acmeHome: '/root/.acme.sh',
      domain: 'update.example.com',
      keyType: '2048',
      kind: 'key'
    }),
    '/root/.acme.sh/update.example.com/update.example.com.key'
  );
  assert.equal(
    buildDownloadPath({
      acmeHome: '/root/.acme.sh',
      domain: 'update.example.com',
      keyType: 'ec-256',
      kind: 'fullchain'
    }),
    '/root/.acme.sh/update.example.com_ecc/fullchain.cer'
  );
  assert.equal(
    buildDownloadPath({
      acmeHome: '/root/.acme.sh',
      domain: 'update.example.com',
      keyType: '2048',
      kind: 'chain'
    }),
    '/root/.acme.sh/update.example.com/ca.cer'
  );
});

test('下载路径拒绝未知域名与非法类型', () => {
  assert.throws(() => buildDownloadPath({
    acmeHome: '/root/.acme.sh',
    domain: '../etc',
    keyType: '2048',
    kind: 'key'
  }), ValidationError);
  assert.throws(() => buildDownloadPath({
    acmeHome: '/root/.acme.sh',
    domain: 'update.example.com',
    keyType: '2048',
    kind: 'private'
  }), ValidationError);
});

test('清单脚本读取关键字段且拒绝相对目录', () => {
  const script = buildListScript('/root/.acme.sh');
  assert.match(script, /Le_Keylength/);
  assert.match(script, /Le_NextRenewTime/);
  assert.match(script, /openssl x509/);
  assert.throws(() => buildListScript('relative/dir'), ValidationError);
});

test('预检命令对域名做引号包裹', () => {
  const command = buildPrecheckCommand('update.example.com');
  assert.equal(command, "sh -s -- 'update.example.com'");
  assert.match(buildPrecheckScript(), /acme-challenge/);
});

test('任务标识只接受内部任务号', () => {
  const pidFile = buildRemotePidFile('0f0f0f0f-1111-2222-3333-444444444444');
  assert.equal(pidFile, '/tmp/acmedesk-0f0f0f0f-1111-2222-3333-444444444444.pid');
  assert.throws(() => buildRemotePidFile('../../etc/passwd'), ValidationError);
});

test('任务包装命令记录 PID/PGID、建立会话并清理标识', () => {
  const pidFile = '/tmp/acmedesk-job.pid';
  const command = buildWrappedJobCommand("'/opt/issue.sh' -d 'a.example.com'", pidFile);
  assert.match(command, /command -v setsid/);
  assert.match(command, /setsid -w true/);
  assert.match(command, /setsid -w sh -c/);
  assert.match(command, /mode="\$2"/);
  assert.match(command, /pgid=\$\$/);
  assert.match(command, /setsid; else/);
  assert.match(command, /ps -o pgid= -p \$\$/);
  assert.match(command, /mv -f/);
  assert.match(command, /printf/);
  assert.match(command, /%s %s/);
  assert.match(command, /\/opt\/issue\.sh/);
  assert.match(command, /rm -f "\$1" "\$1\.tmp"/);
  assert.match(command, /'\/tmp\/acmedesk-job\.pid'/);
  assert.throws(
    () => buildWrappedJobCommand('echo ok', '/etc/not-a-task.pid'),
    ValidationError
  );
});

test('终止脚本拒绝非法 PID 并按进程组回收', () => {
  const script = buildTerminationScript();
  assert.match(script, /read -r pid pgid/);
  assert.match(script, /case "\$pid" in/);
  assert.match(script, /case "\$pgid" in/);
  assert.match(script, /0\*/);
  assert.match(script, /alive\(\)/);
  assert.match(script, /kill -TERM -"\$pgid"/);
  assert.match(script, /kill -KILL -"\$pgid"/);
  assert.match(script, /\$pidfile\.tmp/);
  assert.match(script, /printf 'none/);
  assert.match(script, /printf 'requested/);
  const command = buildTerminationCommand('/tmp/acmedesk-job.pid');
  assert.equal(command, "sh -s -- '/tmp/acmedesk-job.pid'");
});

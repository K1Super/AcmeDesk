'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ValidationError,
  validateDomain,
  parseDomains,
  validateEmail,
  validateWebroot,
  validateKeyType,
  validateDownloadKind,
  validateSshHost,
  validateSshPort,
  validateSshUser,
  validateKeyPath,
  validateAcmeHome,
  parseBooleanFlag
} = require('../src/domain/validation');

test('域名统一转小写并接受合法子域', () => {
  assert.equal(validateDomain('UPDATE.EXAMPLE.COM'), 'update.example.com');
  assert.equal(validateDomain(' a.b-c.example.com '), 'a.b-c.example.com');
});

test('拒绝 IP、通配符与格式非法的域名', () => {
  assert.throws(() => validateDomain('192.0.2.1'), ValidationError);
  assert.throws(() => validateDomain('*.example.com'), ValidationError);
  assert.throws(() => validateDomain('localhost'), ValidationError);
  assert.throws(() => validateDomain('bad domain'), ValidationError);
  assert.throws(() => validateDomain(''), ValidationError);
});

test('批量域名支持逗号与换行并去重', () => {
  const list = parseDomains(' a.example.com,\n b.example.com a.example.com ');
  assert.deepEqual(list, ['a.example.com', 'b.example.com']);
});

test('批量域名数量与空输入受限', () => {
  assert.throws(() => parseDomains(''), ValidationError);
  const many = Array.from({ length: 11 }, (_, index) => `d${index}.example.com`).join('\n');
  assert.throws(() => parseDomains(many), ValidationError);
});

test('邮箱校验覆盖合法与非法输入', () => {
  assert.equal(validateEmail('ops@example.com'), 'ops@example.com');
  assert.equal(validateEmail('', { required: false }), '');
  assert.throws(() => validateEmail('not-an-email'), ValidationError);
  assert.throws(() => validateEmail(''), ValidationError);
});

test('校验目录必须是安全绝对路径', () => {
  assert.equal(validateWebroot('/srv/acme'), '/srv/acme');
  assert.equal(validateWebroot('/srv/acme/'), '/srv/acme');
  assert.throws(() => validateWebroot('relative/path'), ValidationError);
  assert.throws(() => validateWebroot('/srv/acme;rm -rf /'), ValidationError);
  assert.throws(() => validateWebroot('/srv/../etc'), ValidationError);
  assert.throws(() => validateWebroot('/srv/acme dir'), ValidationError);
});

test('acme.sh 目录同样执行绝对路径校验', () => {
  assert.equal(validateAcmeHome('/root/.acme.sh'), '/root/.acme.sh');
  assert.throws(() => validateAcmeHome('~/acme'), ValidationError);
});

test('密钥类型与下载类型使用白名单', () => {
  assert.equal(validateKeyType('2048'), '2048');
  assert.equal(validateKeyType('EC-256'), 'ec-256');
  assert.throws(() => validateKeyType('1024'), ValidationError);
  assert.equal(validateDownloadKind('fullchain'), 'fullchain');
  assert.throws(() => validateDownloadKind('kubeconfig'), ValidationError);
});

test('SSH 参数边界校验', () => {
  assert.equal(validateSshHost('192.0.2.1'), '192.0.2.1');
  assert.throws(() => validateSshHost('-oProxyCommand=evil'), ValidationError);
  assert.equal(validateSshPort('22'), 22);
  assert.throws(() => validateSshPort('0'), ValidationError);
  assert.throws(() => validateSshPort('22.5'), ValidationError);
  assert.equal(validateSshUser('root'), 'root');
  assert.throws(() => validateSshUser('root;id'), ValidationError);
});

test('私钥路径禁止换行与控制注入', () => {
  const keyPath = 'C:\\keys\\deploy.pem';
  assert.equal(validateKeyPath(keyPath), keyPath);
  assert.throws(() => validateKeyPath(''), ValidationError);
  assert.throws(() => validateKeyPath('C:\\key\n.pem'), ValidationError);
  assert.throws(() => validateKeyPath('C:\\key\0.pem'), ValidationError);
});

test('邮箱要求合法域名标签，不接受无点域名', () => {
  assert.equal(validateEmail('ops+alert@example.co.uk'), 'ops+alert@example.co.uk');
  assert.throws(() => validateEmail('a@b'), ValidationError);
  assert.throws(() => validateEmail('a@-'), ValidationError);
  assert.throws(() => validateEmail('a@b..c'), ValidationError);
  assert.throws(() => validateEmail('a..b@example.com'), ValidationError);
  assert.throws(() => validateEmail(`${'x'.repeat(65)}@example.com`), ValidationError);
});

test('SSH 主机拒绝空标签与非法边界', () => {
  assert.equal(validateSshHost('server.example.com'), 'server.example.com');
  assert.equal(validateSshHost('server'), 'server');
  assert.equal(validateSshHost('192.0.2.1'), '192.0.2.1');
  assert.throws(() => validateSshHost('.'), ValidationError);
  assert.throws(() => validateSshHost('-'), ValidationError);
  assert.throws(() => validateSshHost('a..b'), ValidationError);
  assert.throws(() => validateSshHost('-abc'), ValidationError);
  assert.throws(() => validateSshHost('abc.'), ValidationError);
});

test('布尔开关拒绝字符串与宽松转换', () => {
  assert.equal(parseBooleanFlag(undefined, 'staging'), false);
  assert.equal(parseBooleanFlag(null, 'staging'), false);
  assert.equal(parseBooleanFlag(true, 'staging'), true);
  assert.equal(parseBooleanFlag(false, 'staging'), false);
  assert.throws(() => parseBooleanFlag('false', 'staging'), ValidationError);
  assert.throws(() => parseBooleanFlag(1, 'staging'), ValidationError);
});

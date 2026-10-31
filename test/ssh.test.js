'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const settings = {
  sshHost: 'server.example.com',
  sshPort: 22,
  sshUser: 'deploy',
  sshKeyPath: 'C:\\keys\\deploy.pem'
};

const originalSpawn = childProcess.spawn;
let currentChild = null;

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  currentChild = child;
  return child;
}

childProcess.spawn = () => fakeChild();
delete require.cache[require.resolve('../src/infra/ssh')];
const ssh = require('../src/infra/ssh');

test.after(() => {
  childProcess.spawn = originalSpawn;
  delete require.cache[require.resolve('../src/infra/ssh')];
});

test('远端脚本正常结束返回输出与耗时', async () => {
  const promise = ssh.runScript(settings, 'echo ok', { command: 'sh -s', timeout: 1000 });
  currentChild.stdout.emit('data', Buffer.from('ok\n'));
  currentChild.emit('close', 0);

  const result = await promise;
  assert.equal(result.stdout, 'ok\n');
  assert.equal(result.code, 0);
  assert.ok(result.durationMs >= 0);
});

test('远端脚本超时会终止进程', async () => {
  const promise = ssh.runScript(settings, 'sleep', { command: 'sh -s', timeout: 30 });
  await assert.rejects(promise, /超时/);
  assert.equal(currentChild.killed, true);
});

test('远端输出超过上限时拒绝并终止进程', async () => {
  const promise = ssh.runScript(settings, 'cat huge', { command: 'sh -s', timeout: 1000 });
  currentChild.stdout.emit('data', Buffer.alloc(9 * 1024 * 1024));
  await assert.rejects(promise, /输出超过上限/);
  assert.equal(currentChild.killed, true);
});

test('无法启动 ssh 时返回明确错误', async () => {
  const promise = ssh.runScript(settings, 'echo ok', { command: 'sh -s', timeout: 1000 });
  currentChild.emit('error', new Error('spawn ENOENT'));
  await assert.rejects(promise, /无法启动 ssh/);
});

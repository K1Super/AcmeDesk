'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { JobService, JobConflictError } = require('../src/services/jobService');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function createHistory() {
  const records = [];
  return {
    records,
    append: (entry) => records.push(entry)
  };
}

function createSsh(child, { terminationOutput = 'stopped', terminationError = null, terminationDelayMs = 0 } = {}) {
  const streamCalls = [];
  const terminationCalls = [];
  return {
    streamCalls,
    terminationCalls,
    stream: (settings, command) => {
      streamCalls.push({ settings, command });
      return child;
    },
    runScript: async (settings, script, options) => {
      terminationCalls.push({ settings, script, options });
      if (terminationDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, terminationDelayMs));
      }
      if (terminationError) {
        throw terminationError;
      }
      return { stdout: `${terminationOutput}\n`, stderr: '', code: 0 };
    }
  };
}

async function waitFor(predicate, { timeout = 1000, interval = 10 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('等待任务状态超时');
}

const settings = {
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

test('任务正常结束会清理 activeId 并写入历史', async () => {
  const child = fakeChild();
  const history = createHistory();
  const ssh = createSsh(child);
  const service = new JobService({ history, sshImpl: ssh, timeoutMs: 5000 });

  const job = service.start({
    type: 'renew',
    label: '续期测试',
    target: 'update.example.com',
    settings,
    command: 'true'
  });
  assert.equal(service.isBusy(), true);
  assert.match(ssh.streamCalls[0].command, /setsid -w sh -c/);

  child.emit('close', 0);
  await waitFor(() => service.get(job.id).status === 'success');

  const finished = service.get(job.id);
  assert.equal(finished.status, 'success');
  assert.equal(service.isBusy(), false);
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].target, 'update.example.com');
});

test('任务超时会终止本地进程并回收远端进程组', async () => {
  const child = fakeChild();
  const history = createHistory();
  const ssh = createSsh(child);
  const service = new JobService({
    history,
    sshImpl: ssh,
    timeoutMs: 40,
    terminationTimeoutMs: 200
  });

  const job = service.start({
    type: 'issue',
    label: '签发测试',
    target: 'update.example.com',
    settings,
    command: 'sleep'
  });

  await waitFor(() => service.get(job.id).status === 'failed');

  const finished = service.get(job.id);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.remoteTermination, 'stopped');
  assert.equal(child.killed, true);
  assert.equal(service.isBusy(), false);
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].status, 'failed');
  assert.match(finished.log.map((item) => item.text).join('\n'), /超时/);
  assert.match(finished.log.map((item) => item.text).join('\n'), /远端进程已停止/);
});

test('超时终止过程中取消不会改写终止原因', async () => {
  const child = fakeChild();
  const history = createHistory();
  const ssh = createSsh(child, { terminationDelayMs: 100 });
  const service = new JobService({
    history,
    sshImpl: ssh,
    timeoutMs: 20,
    terminationTimeoutMs: 500
  });

  const job = service.start({
    type: 'renew',
    label: '续期测试',
    target: 'update.example.com',
    settings,
    command: 'sleep'
  });

  await waitFor(() => service.get(job.id).status === 'cancelling');
  assert.equal(await service.cancel(job.id), false);
  await waitFor(() => service.get(job.id).status === 'failed');
  assert.equal(history.records[0].status, 'failed');
});

test('取消运行中的任务会等待远端回收并释放通道', async () => {
  const child = fakeChild();
  const history = createHistory();
  const ssh = createSsh(child);
  const service = new JobService({
    history,
    sshImpl: ssh,
    timeoutMs: 5000,
    terminationTimeoutMs: 200
  });

  const job = service.start({
    type: 'issue',
    label: '签发测试',
    target: 'update.example.com',
    settings,
    command: 'sleep'
  });

  const cancelled = await service.cancel(job.id);
  assert.equal(cancelled, true);
  const finished = service.get(job.id);
  assert.equal(finished.status, 'cancelled');
  assert.equal(finished.remoteTermination, 'stopped');
  assert.equal(child.killed, true);
  assert.equal(service.isBusy(), false);
  assert.equal(history.records[0].status, 'cancelled');
  assert.equal(ssh.terminationCalls.length, 1);
  assert.match(ssh.terminationCalls[0].options.command, /acmedesk-/);
  assert.match(finished.log.map((item) => item.text).join('\n'), /任务已取消/);
});

test('远端终止失败时如实标记未确认', async () => {
  const child = fakeChild();
  const history = createHistory();
  const ssh = createSsh(child, { terminationError: new Error('ssh unavailable') });
  const service = new JobService({
    history,
    sshImpl: ssh,
    timeoutMs: 5000,
    terminationTimeoutMs: 200
  });

  const job = service.start({
    type: 'renew',
    label: '续期测试',
    target: 'update.example.com',
    settings,
    command: 'sleep'
  });

  await service.cancel(job.id);
  const finished = service.get(job.id);
  assert.equal(finished.status, 'cancelled');
  assert.equal(finished.remoteTermination, 'unconfirmed');
  assert.equal(history.records[0].remoteTermination, 'unconfirmed');
  assert.match(finished.log.map((item) => item.text).join('\n'), /远端终止失败/);
});

test('服务退出会中断任务并写入中断记录', async () => {
  const child = fakeChild();
  const history = createHistory();
  const ssh = createSsh(child);
  const service = new JobService({
    history,
    sshImpl: ssh,
    timeoutMs: 5000,
    terminationTimeoutMs: 200
  });

  const job = service.start({
    type: 'issue',
    label: '签发测试',
    target: 'update.example.com',
    settings,
    command: 'sleep'
  });

  await service.shutdown();
  const finished = service.get(job.id);
  assert.equal(finished.status, 'interrupted');
  assert.equal(finished.remoteTermination, 'stopped');
  assert.equal(child.killed, true);
  assert.equal(service.isBusy(), false);
  assert.equal(history.records[0].status, 'interrupted');
});

test('任务结束后取消返回 false', async () => {
  const child = fakeChild();
  const service = new JobService({
    history: createHistory(),
    sshImpl: createSsh(child),
    timeoutMs: 5000
  });

  const job = service.start({
    type: 'renew',
    label: '续期测试',
    target: 'update.example.com',
    settings,
    command: 'true'
  });

  child.emit('close', 0);
  await waitFor(() => service.get(job.id).status === 'success');
  assert.equal(await service.cancel(job.id), false);
});

test('同一时刻只允许一个任务', () => {
  const child = fakeChild();
  const service = new JobService({
    history: createHistory(),
    sshImpl: createSsh(child),
    timeoutMs: 5000
  });

  service.start({
    type: 'renew',
    label: '第一个任务',
    target: 'a.example.com',
    settings,
    command: 'true'
  });

  assert.throws(() => service.start({
    type: 'renew',
    label: '第二个任务',
    target: 'b.example.com',
    settings,
    command: 'true'
  }), JobConflictError);

  child.emit('close', 0);
});

test('远端进程启动同步失败不会占用执行通道', () => {
  const service = new JobService({
    history: createHistory(),
    sshImpl: {
      stream: () => {
        throw new Error('spawn failed');
      }
    },
    timeoutMs: 5000
  });

  assert.throws(() => service.start({
    type: 'renew',
    label: '续期测试',
    target: 'update.example.com',
    settings,
    command: 'true'
  }), /spawn failed/);
  assert.equal(service.isBusy(), false);
});

test('超长单行日志被截断且不无限占用内存', async () => {
  const child = fakeChild();
  const service = new JobService({
    history: createHistory(),
    sshImpl: createSsh(child),
    timeoutMs: 5000
  });

  const job = service.start({
    type: 'renew',
    label: '续期测试',
    target: 'update.example.com',
    settings,
    command: 'true'
  });

  child.stdout.emit('data', Buffer.from('x'.repeat(100000)));
  const log = service.get(job.id).log;
  const last = log[log.length - 1];
  assert.ok(last.text.length < 5000, `日志长度 ${last.text.length} 未被截断`);
  assert.match(last.text, /已截断/);

  child.emit('close', 0);
  await waitFor(() => service.get(job.id).status === 'success');
});

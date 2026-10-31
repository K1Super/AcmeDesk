'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { createRequestHandler } = require('../src/http/router');
const { createOriginPolicy } = require('../src/http/originPolicy');

const publicDir = path.join(__dirname, '..', 'public');

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

let server;
let port;
let assertOrigin = () => null;
let settingsStore;
let jobCounter = 0;

const jobs = {
  'job-1': { status: 'running' },
  'job-done': { status: 'success' },
  'job-cancelling': { status: 'cancelling' }
};
const started = [];
let lastSubscription = null;

const jobServiceStub = {
  get: (id) => (jobs[id] ? { id, status: jobs[id].status, log: [] } : null),
  cancel: async (id) => {
    if (!jobs[id] || jobs[id].status !== 'running') {
      return false;
    }
    jobs[id].status = 'cancelled';
    return true;
  },
  start: (input) => {
    jobCounter += 1;
    const job = {
      id: `job-new-${jobCounter}`,
      type: input.type,
      label: input.label,
      status: 'running'
    };
    jobs[job.id] = job;
    started.push(input);
    return job;
  },
  subscribe: (id, handlers) => {
    lastSubscription = { id, handlers };
    return () => {
      lastSubscription = null;
    };
  }
};

const certServiceStub = {
  precheck: async (settings, domain) => ({
    domain,
    ip: '192.0.2.1',
    httpCode: '404',
    level: 'ok',
    message: '校验路径可访问'
  }),
  download: async (settings, { domain, kind }) => ({
    content: 'PEM',
    fileName: `${domain}-${kind}.crt`,
    contentType: 'application/x-pem-file'
  })
};

const historyServiceStub = {
  read: () => [
    { at: '2026-10-31T09:36:01.322Z', type: 'issue', target: 'a.example.com', status: 'success', durationMs: 1, exitCode: 0 }
  ]
};

function request({ method = 'GET', target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: target,
      method,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function openStream({ target }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: target,
      method: 'GET'
    }, (res) => {
      const chunks = [];
      const state = { status: res.statusCode, chunks, ended: false, res };
      res.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
      state.done = new Promise((done) => {
        res.on('end', () => {
          state.ended = true;
          done();
        });
      });
      resolve(state);
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(predicate, { timeout = 1000, interval = 10 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('等待条件超时');
}

function withTimeout(promise, timeout, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

test.before(async () => {
  settingsStore = {
    get: () => settings,
    set: (input) => {
      Object.assign(settings, input);
      return settings;
    }
  };

  const handler = createRequestHandler({
    settingsStore,
    certService: certServiceStub,
    jobService: jobServiceStub,
    historyService: historyServiceStub,
    publicDir,
    assertOrigin: (headers) => assertOrigin(headers)
  });

  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  assertOrigin = createOriginPolicy({ port });
});

test.after(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  started.length = 0;
  lastSubscription = null;
});

test('允许本机请求读取配置', async () => {
  const response = await request({ target: '/api/settings' });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.settings.sshHost, 'server.example.com');
});

test('拒绝非同源 Host', async () => {
  const response = await request({
    target: '/api/settings',
    headers: { Host: 'evil.example.com' }
  });
  assert.equal(response.status, 403);
});

test('拒绝跨站 Origin 与 Sec-Fetch-Site', async () => {
  const origin = await request({
    target: '/api/settings',
    headers: { Origin: 'http://evil.example.com' }
  });
  assert.equal(origin.status, 403);

  const site = await request({
    target: '/api/settings',
    headers: { 'Sec-Fetch-Site': 'cross-site' }
  });
  assert.equal(site.status, 403);
});

test('静态首页可正常返回', async () => {
  const response = await request({ target: '/' });
  assert.equal(response.status, 200);
  assert.match(response.body, /AcmeDesk/);
});

test('超限请求体返回 413 JSON 而不是连接重置', async () => {
  const body = 'x'.repeat(70 * 1024);
  const response = await request({
    method: 'PUT',
    target: '/api/settings',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  assert.equal(response.status, 413);
  assert.match(response.body, /请求体过大/);
});

test('取消运行中的任务返回 200，未知任务 404，已结束任务 409', async () => {
  const cancelled = await request({ method: 'POST', target: '/api/jobs/job-1/cancel' });
  assert.equal(cancelled.status, 200);
  assert.match(cancelled.body, /cancelled/);

  const missing = await request({ method: 'POST', target: '/api/jobs/job-x/cancel' });
  assert.equal(missing.status, 404);

  const finished = await request({ method: 'POST', target: '/api/jobs/job-done/cancel' });
  assert.equal(finished.status, 409);
});

test('终止中的任务再次取消返回明确的 409 提示', async () => {
  const response = await request({ method: 'POST', target: '/api/jobs/job-cancelling/cancel' });
  assert.equal(response.status, 409);
  assert.match(response.body, /正在终止/);
});

test('SSE 在终止中保持连接并在 done 后关闭', async (t) => {
  const stream = await openStream({ target: '/api/jobs/job-cancelling/events' });
  t.after(() => {
    if (!stream.ended) {
      stream.res.destroy();
    }
  });
  assert.equal(stream.status, 200);
  await waitFor(() => lastSubscription !== null);
  assert.equal(stream.ended, false);

  lastSubscription.handlers.done({ id: 'job-cancelling', status: 'cancelled', label: '任务', log: [] });
  await withTimeout(stream.done, 1000, 'SSE 未在预期时间内结束');
  assert.equal(stream.ended, true);
  const body = stream.chunks.join('');
  assert.match(body, /event: done/);
  assert.match(body, /cancelled/);
  await waitFor(() => lastSubscription === null);
});

test('JSON null、数组与非法 payload 返回 400', async () => {
  const nullBody = await request({
    method: 'POST',
    target: '/api/jobs',
    headers: { 'Content-Type': 'application/json' },
    body: 'null'
  });
  assert.equal(nullBody.status, 400);
  assert.match(nullBody.body, /JSON 对象/);

  const arrayBody = await request({
    method: 'PUT',
    target: '/api/settings',
    headers: { 'Content-Type': 'application/json' },
    body: '[]'
  });
  assert.equal(arrayBody.status, 400);

  const badPayload = await request({
    method: 'POST',
    target: '/api/jobs',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'issue', payload: 'not-an-object' })
  });
  assert.equal(badPayload.status, 400);
  assert.match(badPayload.body, /payload 必须是 JSON 对象/);
});

test('签发任务拒绝字符串布尔值并接受严格布尔值', async () => {
  const rejected = await request({
    method: 'POST',
    target: '/api/jobs',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'issue',
      payload: { domains: 'a.example.com', staging: 'false' }
    })
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /staging 必须是布尔值/);
  assert.equal(started.length, 0);

  const accepted = await request({
    method: 'POST',
    target: '/api/jobs',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'issue',
      payload: {
        domains: 'a.example.com,www.a.example.com',
        webroot: '/srv/acme',
        email: 'ops@example.com',
        keyType: '2048',
        staging: true,
        force: false
      }
    })
  });
  assert.equal(accepted.status, 202);
  assert.equal(started.length, 1);
  assert.equal(started[0].type, 'issue');
  assert.match(started[0].command, /--staging/);
  assert.doesNotMatch(started[0].command, /--force/);
  assert.equal(started[0].target, 'a.example.com');
});

test('吊销确认不一致时拒绝启动任务', async () => {
  const response = await request({
    method: 'POST',
    target: '/api/jobs',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'revoke',
      payload: { domain: 'a.example.com', keyType: '2048', confirm: 'b.example.com' }
    })
  });
  assert.equal(response.status, 400);
  assert.match(response.body, /吊销确认与域名不一致/);
  assert.equal(started.length, 0);
});

test('下载接口校验类型并返回文件响应头', async () => {
  const invalid = await request({ target: '/api/download/a.example.com/private' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body, /不支持的下载类型/);

  const valid = await request({ target: '/api/download/a.example.com/fullchain?keyType=2048' });
  assert.equal(valid.status, 200);
  assert.equal(valid.body, 'PEM');
  assert.match(valid.headers['content-disposition'], /a\.example\.com-fullchain\.crt/);
});

test('预检接口返回服务层结果', async () => {
  const response = await request({
    method: 'POST',
    target: '/api/precheck',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: 'a.example.com' })
  });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.precheck.level, 'ok');
});

test('历史接口返回记录列表', async () => {
  const response = await request({ target: '/api/history' });
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].target, 'a.example.com');
});

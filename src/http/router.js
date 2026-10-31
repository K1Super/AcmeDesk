'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { ValidationError, validateDomain, validateKeyType, validateDownloadKind, parseDomains, parseBooleanFlag } = require('../domain/validation');
const { buildIssueCommand, buildRenewCommand, buildRevokeCommand } = require('../domain/commands');
const { validateSettings, isConfigured, CONFIG_FILE } = require('../config');
const { RemoteError } = require('../infra/ssh');
const { JobConflictError } = require('../services/jobService');

/**
 * HTTP 接口层。
 *
 * 只负责协议解析、参数整形与错误映射；业务判断全部下沉到服务层，
 * 保证接口层可被替换而不影响证书逻辑。
 */

const MAX_BODY_BYTES = 64 * 1024;
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js']
]);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.includes('application/json')) {
      reject(new HttpError(415, '请求必须使用 application/json'));
      return;
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        req.pause();
        reject(new HttpError(413, '请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, '请求体必须是 JSON 对象'));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', () => reject(new HttpError(400, '请求读取失败')));
  });
}

function serveStatic(req, res, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, '不支持的请求方法');
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const relative = STATIC_FILES.get(url.pathname);
  if (!relative) {
    throw new HttpError(404, '资源不存在');
  }
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(path.resolve(publicDir) + path.sep)) {
    throw new HttpError(404, '资源不存在');
  }
  if (!fs.existsSync(filePath)) {
    throw new HttpError(404, '资源不存在');
  }
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Length': content.length
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

function streamJob(req, res, jobService, jobId) {
  const job = jobService.get(jobId);
  if (!job) {
    throw new HttpError(404, '任务不存在');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  });
  res.write('retry: 3000\n\n');

  const canWrite = () => !res.writableEnded && !res.destroyed;
  const send = (entry) => {
    if (!canWrite()) {
      return;
    }
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };
  let heartbeat = null;
  let unsubscribe = null;
  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
  const sendDone = (state) => {
    cleanup();
    if (!canWrite()) {
      return;
    }
    res.write(`event: done\ndata: ${JSON.stringify(state)}\n\n`);
    res.end();
  };

  for (const entry of job.log) {
    send(entry);
  }

  if (job.status !== 'running' && job.status !== 'cancelling') {
    sendDone(job);
    return;
  }

  unsubscribe = jobService.subscribe(jobId, {
    line: send,
    done: sendDone
  });

  heartbeat = setInterval(() => {
    if (!canWrite()) {
      cleanup();
      return;
    }
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', cleanup);
}

function readJobPayload(body) {
  const payload = body.payload;
  if (payload === undefined) {
    return {};
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'payload 必须是 JSON 对象');
  }
  return payload;
}

async function handleApi(req, res, context, url) {
  const { settingsStore, certService, jobService, historyService } = context;
  const settings = settingsStore.get();
  const segments = url.pathname.split('/').filter(Boolean);
  const ensureConfigured = () => {
    if (!isConfigured(settings)) {
      throw new HttpError(400, '请先在设置页完成连接配置');
    }
  };

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/settings/status') {
    // 只暴露是否存在完整配置与保存时间，不回显任何配置值
    const updatedAt = fs.existsSync(CONFIG_FILE) ? fs.statSync(CONFIG_FILE).mtime.toISOString() : null;
    sendJson(res, 200, { configured: isConfigured(settings), updatedAt });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    sendJson(res, 200, { settings });
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    const body = await readJsonBody(req);
    const next = settingsStore.set(body);
    sendJson(res, 200, { settings: next });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/settings/test') {
    const body = await readJsonBody(req);
    const hasValues = Object.values(body || {}).some((value) => (
      value !== null && value !== undefined && String(value).trim() !== ''
    ));
    const candidate = hasValues
      ? validateSettings(body, { requireComplete: true, checkKeyExists: true })
      : settings;
    if (!isConfigured(candidate)) {
      throw new HttpError(400, '请先在设置页完成连接配置');
    }
    const connection = await certService.testConnection(candidate);
    sendJson(res, 200, { connection });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/certificates') {
    ensureConfigured();
    const data = await certService.list(settings);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/precheck') {
    ensureConfigured();
    const body = await readJsonBody(req);
    const result = await certService.precheck(settings, body.domain);
    sendJson(res, 200, { precheck: result });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    ensureConfigured();
    const body = await readJsonBody(req);
    if (body.type === 'issue') {
      const payload = readJobPayload(body);
      const domains = parseDomains(payload.domains);
      const staging = parseBooleanFlag(payload.staging, 'staging');
      const force = parseBooleanFlag(payload.force, 'force');
      const command = buildIssueCommand({
        issueScript: settings.issueScript,
        domains,
        webroot: payload.webroot || settings.defaultWebroot,
        email: payload.email || settings.defaultEmail,
        keyType: payload.keyType || settings.defaultKeyType || '2048',
        staging,
        force
      });
      const job = jobService.start({
        type: 'issue',
        label: `签发 ${domains.join('、')}${staging ? '（测试环境）' : ''}`,
        target: domains[0],
        settings,
        command
      });
      sendJson(res, 202, { job });
      return;
    }

    if (body.type === 'renew') {
      const payload = readJobPayload(body);
      const domain = validateDomain(payload.domain);
      const keyType = validateKeyType(payload.keyType);
      const command = buildRenewCommand({
        acmeHome: settings.acmeHome,
        domain,
        keyType
      });
      const job = jobService.start({
        type: 'renew',
        label: `续期 ${domain}`,
        target: domain,
        settings,
        command
      });
      sendJson(res, 202, { job });
      return;
    }

    if (body.type === 'revoke') {
      const payload = readJobPayload(body);
      const domain = validateDomain(payload.domain);
      const keyType = validateKeyType(payload.keyType);
      const staging = parseBooleanFlag(payload.staging, 'staging');
      // 吊销不可逆：要求调用方回填完整域名，避免误触或脚本误调
      if (String(payload.confirm || '').trim().toLowerCase() !== domain) {
        throw new HttpError(400, '吊销确认与域名不一致');
      }
      const command = buildRevokeCommand({
        acmeHome: settings.acmeHome,
        domain,
        keyType,
        staging
      });
      const job = jobService.start({
        type: 'revoke',
        label: `吊销 ${domain}`,
        target: domain,
        settings,
        command
      });
      sendJson(res, 202, { job });
      return;
    }

    throw new HttpError(400, '不支持的任务类型');
  }

  if (req.method === 'POST' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'jobs' && segments[3] === 'cancel') {
    const id = segments[2];
    if (!jobService.get(id)) {
      throw new HttpError(404, '任务不存在');
    }
    const cancelled = await jobService.cancel(id);
    if (!cancelled) {
      const latest = jobService.get(id);
      throw new HttpError(
        409,
        latest && latest.status === 'cancelling'
          ? '任务正在终止，请等待完成'
          : '任务已结束，无法取消'
      );
    }
    sendJson(res, 200, { cancelled: true });
    return;
  }

  if (req.method === 'GET' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'jobs') {
    const job = jobService.get(segments[2]);
    if (!job) {
      throw new HttpError(404, '任务不存在');
    }
    sendJson(res, 200, { job });
    return;
  }

  if (req.method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'jobs' && segments[3] === 'events') {
    streamJob(req, res, jobService, segments[2]);
    return;
  }

  if (req.method === 'GET' && segments.length === 4 && segments[0] === 'api' && segments[1] === 'download') {
    ensureConfigured();
    const domain = segments[2];
    const kind = validateDownloadKind(segments[3]);
    const keyType = validateKeyType(url.searchParams.get('keyType') || settings.defaultKeyType || '2048');
    const file = await certService.download(settings, { domain, keyType, kind });
    res.writeHead(200, {
      'Content-Type': file.contentType,
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${file.fileName}"`,
      'Content-Length': Buffer.byteLength(file.content)
    });
    res.end(file.content);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history') {
    sendJson(res, 200, { items: historyService.read(100) });
    return;
  }

  throw new HttpError(404, '接口不存在');
}

function redactLogText(value) {
  return String(value || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .slice(0, 500);
}

function mapError(error) {
  if (error instanceof HttpError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof ValidationError) {
    return { status: 400, message: error.message };
  }
  if (error instanceof JobConflictError) {
    return { status: 409, message: error.message };
  }
  if (error instanceof RemoteError) {
    console.error('远端执行失败:', redactLogText(error.stderr || error.message));
    return { status: 502, message: '远端操作失败，请检查服务器连接或任务日志' };
  }
  console.error('未处理的服务端错误:', error);
  return { status: 500, message: '服务内部错误' };
}

function createRequestHandler(context) {
  return async function requestHandler(req, res) {
    applySecurityHeaders(res);
    try {
      const rejection = context.assertOrigin ? context.assertOrigin(req.headers) : null;
      if (rejection) {
        throw new HttpError(403, '拒绝非本机来源的请求');
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, context, url);
        return;
      }
      serveStatic(req, res, context.publicDir);
    } catch (error) {
      const mapped = mapError(error);
      if (!res.headersSent) {
        if (mapped.status === 413) {
          res.setHeader('Connection', 'close');
        }
        sendJson(res, mapped.status, { error: mapped.message });
      } else {
        res.end();
      }
    }
  };
}

module.exports = {
  createRequestHandler,
  redactLogText,
  HttpError
};

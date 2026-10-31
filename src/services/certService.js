'use strict';

const ssh = require('../infra/ssh');
const {
  buildListScript,
  buildPrecheckScript,
  buildPrecheckCommand,
  buildDownloadCommand,
  buildTestCommand
} = require('../domain/commands');
const { parseCertificates, summarize } = require('../domain/certificates');
const { validateDomain, validateKeyType, validateDownloadKind } = require('../domain/validation');

/**
 * 证书业务服务。
 *
 * 所有方法都显式接收连接配置，便于设置页在保存前先做连通性测试，
 * 同时避免把当前配置藏在模块级单例里。
 */

const PRECHECK_TIMEOUT_MS = 20000;
const LIST_TIMEOUT_MS = 30000;
const TEST_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 600;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 只读远端操作允许一次重试：跨公网的 SSH 握手偶发断连会造成误报失败，
 * 而重试读操作不会改变服务器状态。签发与续期属于写操作，不得重试。
 */
async function withSingleRetry(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error && error.name === 'RemoteError') {
      await delay(RETRY_DELAY_MS);
      return operation();
    }
    throw error;
  }
}

function precheckVerdict(httpCode) {
  switch (httpCode) {
    case '404':
      return { level: 'ok', message: '校验路径可访问，文件按预期不存在，适合签发' };
    case '200':
      return { level: 'warn', message: '校验路径已由其他内容响应，请确认 webroot 是否指向正确目录' };
    case '301':
    case '302':
    case '307':
    case '308':
      return { level: 'error', message: '校验路径被重定向，HTTP-01 会失败，需要放行 .well-known 路径' };
    case '403':
      return { level: 'error', message: '校验路径返回 403，检查目录权限或安全规则' };
    case '000':
      return { level: 'error', message: 'HTTP 无法连接，检查 80 端口、安全组与域名解析' };
    default:
      return { level: 'warn', message: `校验路径返回 ${httpCode}，请人工确认` };
  }
}

class CertificateService {
  async list(settings) {
    const script = buildListScript(settings.acmeHome);
    const result = await withSingleRetry(async () => {
      const attempt = await ssh.runScript(settings, script, { timeout: LIST_TIMEOUT_MS });
      if (attempt.code !== 0) {
        throw new ssh.RemoteError('读取证书清单失败', {
          code: attempt.code,
          stdout: attempt.stdout,
          stderr: attempt.stderr
        });
      }
      return attempt;
    });
    const items = parseCertificates(result.stdout);
    return { items, summary: summarize(items), fetchedAt: new Date().toISOString() };
  }

  async precheck(settings, domain) {
    const name = validateDomain(domain);
    const outcome = await withSingleRetry(async () => {
      const attempt = await ssh.runScript(settings, buildPrecheckScript(), {
        command: buildPrecheckCommand(name),
        timeout: PRECHECK_TIMEOUT_MS
      });
      const line = String(attempt.stdout || '').trim().split('\n').pop() || '';
      const [ip, httpCode] = line.split('\t');
      if (!ip || !httpCode) {
        throw new ssh.RemoteError('预检未返回有效结果', {
          code: attempt.code,
          stdout: attempt.stdout,
          stderr: attempt.stderr
        });
      }
      return { ip, httpCode };
    });
    const verdict = precheckVerdict(outcome.httpCode.trim());
    return {
      domain: name,
      ip: outcome.ip === 'none' ? null : outcome.ip,
      httpCode: outcome.httpCode.trim(),
      ...verdict
    };
  }

  async testConnection(settings) {
    const result = await withSingleRetry(() => ssh.run(settings, buildTestCommand(), { timeout: TEST_TIMEOUT_MS }));
    const stdout = String(result.stdout || '');
    const nginx = (stdout.match(/^nginx version: (.+)$/m) || [])[1] || null;
    return {
      nginx,
      latencyMs: result.durationMs,
      checkedAt: new Date().toISOString()
    };
  }

  async download(settings, { domain, keyType, kind }) {
    const name = validateDomain(domain);
    const key = validateKeyType(keyType);
    const type = validateDownloadKind(kind);
    const result = await withSingleRetry(() => ssh.run(settings, buildDownloadCommand({
      acmeHome: settings.acmeHome,
      domain: name,
      keyType: key,
      kind: type
    }), { timeout: 20000 }));

    if (!result.stdout || result.stdout.trim() === '') {
      throw new ssh.RemoteError('远端文件为空或不存在', { stdout: result.stdout, stderr: result.stderr });
    }

    const fileNames = {
      fullchain: `${name}.crt`,
      key: `${name}.key`,
      chain: `${name}-chain.crt`
    };
    const contentTypes = {
      fullchain: 'application/x-pem-file',
      key: 'application/x-pem-file',
      chain: 'application/x-pem-file'
    };
    return {
      content: result.stdout,
      fileName: fileNames[type],
      contentType: contentTypes[type]
    };
  }
}

module.exports = {
  CertificateService,
  precheckVerdict
};

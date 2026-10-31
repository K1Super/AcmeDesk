'use strict';

/**
 * 外部输入的统一校验入口。
 *
 * 所有进入远端命令或文件路径的值都必须先经过本模块；校验以白名单为核心，
 * 因为命令最终会交给远端 shell 执行，仅靠转义不足以覆盖所有shell语义。
 */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const EMAIL_RE = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const POSIX_PATH_RE = /^\/[A-Za-z0-9._/-]*$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const SSH_USER_RE = /^[a-z_][a-z0-9_-]*$/;
const KEY_TYPES = ['2048', '4096', 'ec-256', 'ec-384'];
const DOWNLOAD_KINDS = ['fullchain', 'key', 'chain'];
const MAX_DOMAINS = 10;

function validateDomain(value) {
  const domain = String(value ?? '').trim().toLowerCase();
  if (!domain) {
    throw new ValidationError('域名不能为空');
  }
  if (domain.length > 253) {
    throw new ValidationError(`域名过长: ${domain}`);
  }
  if (/^[0-9.]+$/.test(domain)) {
    throw new ValidationError('不支持 IP 地址，请填写完整域名');
  }
  if (!DOMAIN_RE.test(domain)) {
    throw new ValidationError(`域名格式不合法: ${domain}`);
  }
  for (const label of domain.split('.')) {
    if (label.length > 63) {
      throw new ValidationError(`域名标签超过 63 字符: ${label}`);
    }
  }
  return domain;
}

function parseDomains(input) {
  const parts = String(input ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new ValidationError('至少填写一个域名');
  }
  if (parts.length > MAX_DOMAINS) {
    throw new ValidationError(`单次最多支持 ${MAX_DOMAINS} 个域名`);
  }

  const unique = [];
  const seen = new Set();
  for (const part of parts) {
    const domain = validateDomain(part);
    if (!seen.has(domain)) {
      seen.add(domain);
      unique.push(domain);
    }
  }
  return unique;
}

function validateEmail(value, { required = true } = {}) {
  const email = String(value ?? '').trim();
  if (!email) {
    if (required) {
      throw new ValidationError('邮箱不能为空');
    }
    return '';
  }
  const at = email.lastIndexOf('@');
  if (
    at <= 0 ||
    email.length > 254 ||
    at > 64 ||
    email.length - at - 1 > 253 ||
    !EMAIL_RE.test(email)
  ) {
    throw new ValidationError(`邮箱格式不合法: ${email}`);
  }
  return email;
}

/**
 * 布尔开关只接受 JSON 布尔值。
 *
 * 字符串 "false" 在布尔转换后为真，会让调用方在未明确同意时启用测试
 * 环境或强制签发，因此这里不做宽松转换。
 */
function parseBooleanFlag(value, fieldName) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  throw new ValidationError(`${fieldName} 必须是布尔值`);
}

function normalizeAbsolutePosixPath(value, fieldName) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    throw new ValidationError(`${fieldName}不能为空`);
  }
  if (raw.length > 260) {
    throw new ValidationError(`${fieldName}过长`);
  }
  if (!POSIX_PATH_RE.test(raw)) {
    throw new ValidationError(`${fieldName}必须是绝对路径，且只能包含字母、数字、点、下划线、连字符与斜杠`);
  }
  if (raw.includes('..')) {
    throw new ValidationError(`${fieldName}不能包含上级目录引用`);
  }
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
}

function validateWebroot(value) {
  return normalizeAbsolutePosixPath(value, '校验目录');
}

function validateAcmeHome(value) {
  return normalizeAbsolutePosixPath(value, 'acme.sh 目录');
}

function validateScriptPath(value) {
  return normalizeAbsolutePosixPath(value, '签发脚本路径');
}

function validateKeyType(value) {
  const keyType = String(value ?? '').trim().toLowerCase();
  if (!KEY_TYPES.includes(keyType)) {
    throw new ValidationError(`不支持的密钥类型: ${keyType}`);
  }
  return keyType;
}

function isEcKeyType(keyType) {
  return String(keyType).startsWith('ec-');
}

function validateDownloadKind(value) {
  const kind = String(value ?? '').trim().toLowerCase();
  if (!DOWNLOAD_KINDS.includes(kind)) {
    throw new ValidationError(`不支持的下载类型: ${kind}`);
  }
  return kind;
}

function validateSshHost(value) {
  const host = String(value ?? '').trim().toLowerCase();
  if (!host || host.length > 253 || !HOST_RE.test(host)) {
    throw new ValidationError('SSH 主机必须是域名或 IP，且不能包含空格与特殊字符');
  }
  return host;
}

function validateSshPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('SSH 端口必须是 1-65535 的整数');
  }
  return port;
}

function validateSshUser(value) {
  const user = String(value ?? '').trim();
  if (!SSH_USER_RE.test(user)) {
    throw new ValidationError('SSH 用户名只能包含小写字母、数字、下划线与连字符');
  }
  return user;
}

function validateKeyPath(value) {
  const keyPath = String(value ?? '').trim();
  if (!keyPath || keyPath.length > 500) {
    throw new ValidationError('私钥路径不能为空且不能过长');
  }
  if (/[\0\r\n]/.test(keyPath)) {
    throw new ValidationError('私钥路径不能包含换行或控制字符');
  }
  return keyPath;
}

module.exports = {
  ValidationError,
  validateDomain,
  parseDomains,
  validateEmail,
  parseBooleanFlag,
  validateWebroot,
  validateAcmeHome,
  validateScriptPath,
  validateKeyType,
  validateDownloadKind,
  validateSshHost,
  validateSshPort,
  validateSshUser,
  validateKeyPath,
  isEcKeyType,
  KEY_TYPES,
  MAX_DOMAINS
};

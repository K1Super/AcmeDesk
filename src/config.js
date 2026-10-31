'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ValidationError,
  validateSshHost,
  validateSshPort,
  validateSshUser,
  validateKeyPath,
  validateScriptPath,
  validateAcmeHome,
  validateEmail,
  validateWebroot,
  validateKeyType
} = require('./domain/validation');

/**
 * 本地配置存储。
 *
 * 源码不包含任何真实连接信息；实际配置只存在 data/config.json。
 * 保存时必须完整填写连接字段，避免空值静默覆盖已有配置。
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

const DEFAULTS = {
  sshHost: '',
  sshPort: 22,
  sshUser: '',
  sshKeyPath: '',
  issueScript: '',
  acmeHome: '',
  defaultEmail: '',
  defaultWebroot: '',
  defaultKeyType: ''
};

const REQUIRED_FIELDS = [
  ['sshHost', 'SSH 主机'],
  ['sshUser', 'SSH 用户'],
  ['sshKeyPath', '私钥路径'],
  ['issueScript', '签发脚本路径'],
  ['acmeHome', 'acme.sh 目录']
];

function text(value) {
  return String(value ?? '').trim();
}

function validateSettings(input, { requireComplete = false, checkKeyExists = false } = {}) {
  const source = { ...DEFAULTS, ...(input || {}) };
  const settings = {
    sshHost: text(source.sshHost),
    sshPort: text(source.sshPort) === '' ? 22 : Number(source.sshPort),
    sshUser: text(source.sshUser),
    sshKeyPath: text(source.sshKeyPath),
    issueScript: text(source.issueScript),
    acmeHome: text(source.acmeHome),
    defaultEmail: text(source.defaultEmail),
    defaultWebroot: text(source.defaultWebroot),
    defaultKeyType: text(source.defaultKeyType)
  };

  if (settings.sshHost) {
    validateSshHost(settings.sshHost);
  }
  settings.sshPort = validateSshPort(settings.sshPort);
  if (settings.sshUser) {
    validateSshUser(settings.sshUser);
  }
  if (settings.sshKeyPath) {
    validateKeyPath(settings.sshKeyPath);
  }
  if (settings.issueScript) {
    validateScriptPath(settings.issueScript);
  }
  if (settings.acmeHome) {
    validateAcmeHome(settings.acmeHome);
  }
  settings.defaultEmail = validateEmail(settings.defaultEmail, { required: false });
  if (settings.defaultWebroot) {
    validateWebroot(settings.defaultWebroot);
  }
  if (settings.defaultKeyType) {
    validateKeyType(settings.defaultKeyType);
  }

  if (requireComplete) {
    for (const [field, label] of REQUIRED_FIELDS) {
      if (!settings[field]) {
        throw new ValidationError(`${label}不能为空`);
      }
    }
  }

  if (checkKeyExists && settings.sshKeyPath && !fs.existsSync(settings.sshKeyPath)) {
    throw new ValidationError(`私钥文件不存在: ${settings.sshKeyPath}`);
  }
  return settings;
}

function loadSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    return validateSettings({});
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件无法解析: ${CONFIG_FILE}`);
  }
  return validateSettings(parsed);
}

function saveSettings(settings) {
  const normalized = validateSettings(settings, { requireComplete: true, checkKeyExists: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, CONFIG_FILE);
  return normalized;
}

function isConfigured(settings) {
  return Boolean(
    settings &&
    settings.sshHost &&
    settings.sshUser &&
    settings.sshKeyPath &&
    settings.issueScript &&
    settings.acmeHome
  );
}

/**
 * 监听端口来自环境变量，非法值必须在启动前显式失败。
 *
 * Node 对 NaN 端口会同步抛错，而端口 0 会让来源校验里的端口与实际
 * 监听端口不一致，两种情况都不能进入正常运行阶段。
 */
function resolveServerPort(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return 8787;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError('ACMEDESK_PORT 必须是 1-65535 的整数');
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('ACMEDESK_PORT 必须是 1-65535 的整数');
  }
  return port;
}

module.exports = {
  DEFAULTS,
  CONFIG_FILE,
  HISTORY_FILE,
  validateSettings,
  loadSettings,
  saveSettings,
  isConfigured,
  resolveServerPort
};

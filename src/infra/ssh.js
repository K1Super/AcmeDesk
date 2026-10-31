'use strict';

const { execFile, spawn } = require('node:child_process');

/**
 * SSH 执行层。
 *
 * 只接受已经构建好的远端命令字符串，不在本层拼接业务参数；
 * 统一关闭交互式登录与密码提示，保证失败能快速暴露而不是挂起等待。
 *
 * 主机密钥首次连接自动记录、后续变更拒绝；当前界面没有交互终端可供
 * 人工核对指纹，需要更强保证时由使用者在 known_hosts 中预置。
 */

const CONNECT_TIMEOUT_SECONDS = 10;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_SCRIPT_OUTPUT_BYTES = 8 * 1024 * 1024;

function buildSshArgs(settings, remoteCommand) {
  return [
    '-i', settings.sshKeyPath,
    '-p', String(settings.sshPort),
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    `${settings.sshUser}@${settings.sshHost}`,
    remoteCommand
  ];
}

class RemoteError extends Error {
  constructor(message, { code = null, stdout = '', stderr = '' } = {}) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function run(settings, remoteCommand, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    execFile(
      'ssh',
      buildSshArgs(settings, remoteCommand),
      { timeout, windowsHide: true, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        if (error) {
          reject(new RemoteError(`远端命令执行失败: ${error.message}`, {
            code: error.code ?? null,
            stdout,
            stderr
          }));
          return;
        }
        resolve({ stdout, stderr, durationMs });
      }
    );
  });
}

/**
 * 通过 stdin 下发脚本执行，避免多层 shell 引号拼接；
 * command 仅包含 sh 调用与已转义的参数。
 */
function runScript(settings, script, { command = 'sh -s', timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn('ssh', buildSshArgs(settings, command), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill();
      settled = true;
      reject(new RemoteError(`远端脚本执行超时（${timeout}ms）`, { stdout, stderr }));
    }, timeout);

    const handleData = (stream, chunk) => {
      if (settled) {
        return;
      }
      outputBytes += chunk.length;
      if (outputBytes > MAX_SCRIPT_OUTPUT_BYTES) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new RemoteError(`远端输出超过上限（${MAX_SCRIPT_OUTPUT_BYTES} 字节）`, { stdout, stderr }));
        return;
      }
      if (stream === 'stdout') {
        stdout += chunk.toString('utf8');
      } else {
        stderr += chunk.toString('utf8');
      }
    };

    child.stdout.on('data', (chunk) => handleData('stdout', chunk));
    child.stderr.on('data', (chunk) => handleData('stderr', chunk));

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      reject(new RemoteError(`无法启动 ssh: ${error.message}`));
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      resolve({ stdout, stderr, code, durationMs: Date.now() - startedAt });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

function stream(settings, remoteCommand) {
  return spawn('ssh', buildSshArgs(settings, remoteCommand), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

module.exports = {
  RemoteError,
  buildSshArgs,
  run,
  runScript,
  stream
};

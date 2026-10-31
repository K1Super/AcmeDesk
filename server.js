'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { loadSettings, saveSettings, HISTORY_FILE, resolveServerPort } = require('./src/config');
const { HistoryService } = require('./src/services/historyService');
const { JobService } = require('./src/services/jobService');
const { CertificateService } = require('./src/services/certService');
const { createRequestHandler } = require('./src/http/router');
const { createOriginPolicy } = require('./src/http/originPolicy');

/**
 * 本地服务入口。
 *
 * 只监听回环地址：该界面能直接操作服务器证书与私钥，不应暴露到局域网。
 */

const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHUTDOWN_TIMEOUT_MS = 6000;

let PORT;
try {
  PORT = resolveServerPort(process.env.ACMEDESK_PORT);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

let settings = loadSettings();
const settingsStore = {
  get: () => settings,
  set: (input) => {
    settings = saveSettings(input);
    return settings;
  }
};

const historyService = new HistoryService(HISTORY_FILE);
const jobService = new JobService({ history: historyService });
const certService = new CertificateService();

const handler = createRequestHandler({
  settingsStore,
  certService,
  jobService,
  historyService,
  publicDir: PUBLIC_DIR,
  assertOrigin: createOriginPolicy({ port: PORT })
});

const server = http.createServer(handler);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，可通过环境变量 ACMEDESK_PORT 指定其他端口`);
  } else {
    console.error('服务启动失败:', error.message);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`AcmeDesk 已启动: ${url}`);
  if (process.argv.includes('--open')) {
    openBrowser(url);
  }
});

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

let shuttingDown = false;

/**
 * 退出前先中断活动任务并写入历史，再关闭连接。
 *
 * 直接退出会留下远端进程与缺失的操作记录；SSE 与 keep-alive 连接
 * 还会让 server.close() 长时间等待，因此关闭监听后主动断开剩余连接。
 */
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const force = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  force.unref();
  try {
    await jobService.shutdown();
  } catch (error) {
    console.error('停止任务失败:', error.message);
  }
  server.close(() => {
    clearTimeout(force);
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('SIGBREAK', shutdown);

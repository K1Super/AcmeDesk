'use strict';

const ROUTES = {
  overview: { eyebrow: 'OVERVIEW', title: '运行概览', render: renderOverview },
  certificates: { eyebrow: 'CERTIFICATES', title: '证书清单', render: renderCertificates },
  issue: { eyebrow: 'ISSUE', title: '签发新证书', render: renderIssue },
  history: { eyebrow: 'HISTORY', title: '操作记录', render: renderHistory },
  settings: { eyebrow: 'SETTINGS', title: '连接与默认值', render: renderSettings }
};

const state = {
  settings: null,
  certificates: [],
  summary: null,
  history: [],
  historyError: null,
  connectionStatus: 'checking',
  job: null,
  source: null,
  dataLoading: true,
  route: 'overview',
  modalAction: null,
  modalPhrase: null
};

const els = {
  view: document.getElementById('view'),
  nav: document.getElementById('nav'),
  thumb: document.getElementById('segmented-thumb'),
  pageTitle: document.getElementById('page-title'),
  pageEyebrow: document.getElementById('page-eyebrow'),
  dot: document.getElementById('connection-dot'),
  status: document.getElementById('connection-status'),
  refresh: document.getElementById('refresh-btn'),
  appNotice: document.getElementById('app-notice'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modal-title'),
  modalBody: document.getElementById('modal-body'),
  modalField: document.getElementById('modal-field'),
  modalInput: document.getElementById('modal-input'),
  modalConfirm: document.getElementById('modal-confirm'),
  modalCancel: document.getElementById('modal-cancel')
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

async function api(path, { method = 'GET', body } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }
  if (!response.ok) {
    throw new Error((payload && payload.error) || `请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDate(iso) {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTime(iso) {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) {
    return '—';
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

function statusMeta(status) {
  switch (status) {
    case 'active':
      return { label: '正常', tone: 'ok' };
    case 'expiring':
      return { label: '即将到期', tone: 'warn' };
    case 'expired':
      return { label: '已过期', tone: 'danger' };
    case 'staging':
      return { label: '测试证书', tone: '' };
    default:
      return { label: '未知', tone: '' };
  }
}

function daysLabel(days) {
  if (days === null || days === undefined) {
    return '—';
  }
  if (days < 0) {
    return `过期 ${Math.abs(days)} 天`;
  }
  return `${days} 天`;
}

function actionLabel(type) {
  switch (type) {
    case 'issue':
      return '签发';
    case 'renew':
      return '续期';
    case 'revoke':
      return '吊销';
    default:
      return type;
  }
}

function jobTone(status) {
  if (status === 'success') {
    return 'ok';
  }
  if (status === 'running') {
    return '';
  }
  if (status === 'cancelled' || status === 'cancelling' || status === 'interrupted') {
    return 'warn';
  }
  return 'danger';
}

function jobLabel(status) {
  switch (status) {
    case 'running':
      return '执行中';
    case 'success':
      return '已完成';
    case 'cancelled':
      return '已取消';
    case 'cancelling':
      return '正在终止';
    case 'interrupted':
      return '已中断';
    default:
      return '失败';
  }
}

function jobResult(status) {
  switch (status) {
    case 'running':
      return '执行中';
    case 'success':
      return '成功';
    case 'cancelled':
      return '已取消';
    case 'cancelling':
      return '正在终止';
    case 'interrupted':
      return '已中断';
    default:
      return '失败';
  }
}

function historyResult(item) {
  const base = jobResult(item.status);
  if (item.remoteTermination === 'unconfirmed') {
    return `${base}（远端未确认）`;
  }
  if (item.remoteTermination === 'requested') {
    return `${base}（远端已发信号）`;
  }
  return base;
}

function historyTone(item) {
  if (item.remoteTermination === 'unconfirmed') {
    return 'danger';
  }
  if (item.remoteTermination === 'requested') {
    return 'warn';
  }
  return jobTone(item.status);
}

function terminationNotice(job) {
  if (!job || !job.remoteTermination) {
    return '';
  }
  if (job.remoteTermination === 'requested') {
    return '；远端终止信号已发送，请确认服务器状态';
  }
  if (job.remoteTermination === 'unconfirmed') {
    return '；远端终止结果未确认，任务可能仍在运行';
  }
  return '';
}

function keyLabel(item) {
  const algorithm = item.keyAlgorithm === 'ECDSA' ? 'ECDSA' : 'RSA';
  const size = String(item.keyLength || '').replace('ec-', '');
  return `${algorithm} ${size}`;
}

function skeletonRows(count, columns) {
  return Array.from({ length: count }, () => `<tr class="skeleton-row" aria-hidden="true">${
    Array.from({ length: columns }, () => '<td><span class="skeleton-bar"></span></td>').join('')
  }</tr>`).join('');
}

function historyErrorRow(colspan) {
  return `<tr><td colspan="${colspan}"><span class="status-text" data-tone="danger">操作记录读取失败：${esc(state.historyError)}</span></td></tr>`;
}

function certificateRows(items, { actions = true } = {}) {
  return items.map((item) => {
    const meta = statusMeta(item.status);
    const stagingTag = item.staging ? '<span class="sub-value">测试环境</span>' : '';
    const alt = item.altNames && item.altNames.length
      ? `<span class="sub-value">${esc(item.altNames.join('、'))}</span>`
      : '';
    const downloadMenu = actions
      ? `<div class="download-menu" data-download-menu>
          <button class="btn-link download-trigger" type="button" aria-haspopup="menu" aria-expanded="false">下载</button>
          <div class="download-options" role="menu">
            <a class="download-item" role="menuitem" href="/api/download/${encodeURIComponent(item.domain)}/fullchain?keyType=${encodeURIComponent(item.keyLength)}" download>下载证书</a>
            <a class="download-item" role="menuitem" href="/api/download/${encodeURIComponent(item.domain)}/key?keyType=${encodeURIComponent(item.keyLength)}" download>下载私钥</a>
          </div>
        </div>`
      : '';
    const downloadLinks = actions
      ? `<div class="row-actions">
          ${downloadMenu}
          <button class="btn-link" type="button" data-renew="${esc(item.domain)}" data-key="${esc(item.keyLength)}">续期</button>
          <button class="btn-link" type="button" data-revoke="${esc(item.domain)}" data-key="${esc(item.keyLength)}" data-staging="${item.staging ? 'true' : 'false'}" data-tone="danger">吊销</button>
        </div>`
      : '';
    return `<tr>
      <td><span class="domain">${esc(item.domain)}</span>${stagingTag}${alt}</td>
      <td>${esc(keyLabel(item))}</td>
      <td>${esc(formatDate(item.notAfter))}</td>
      <td class="numeric">${esc(daysLabel(item.daysLeft))}</td>
      <td>${esc(formatDate(item.nextRenewAt))}</td>
      <td><span class="status-text" data-tone="${meta.tone}">${meta.label}</span></td>
      ${actions ? `<td class="col-actions">${downloadLinks}</td>` : ''}
    </tr>`;
  }).join('');
}

function certificateTable(items, options = {}) {
  const loading = state.dataLoading;
  if (!items.length && !loading) {
    return '<div class="empty">暂无证书记录</div>';
  }
  const actionHead = options.actions === false ? '' : '<th class="col-actions">操作</th>';
  const columns = options.actions === false
    ? '<colgroup class="certificates-col"><col><col><col><col><col><col></colgroup>'
    : '<colgroup class="certificates-col certificates-col--actions"><col><col><col><col><col><col><col></colgroup>';
  const actionsClass = options.actions === false ? '' : ' certificates-table--actions';
  const body = loading
    ? skeletonRows(6, options.actions === false ? 6 : 7)
    : certificateRows(items, options);
  return `<table class="table certificates-table${actionsClass}">
    ${columns}
    <thead>
      <tr>
        <th>域名</th>
        <th>密钥</th>
        <th>到期</th>
        <th class="numeric">剩余</th>
        <th>自动续期</th>
        <th>状态</th>
        ${actionHead}
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderOverview() {
  const summary = state.summary || { total: 0, production: 0, staging: 0, expiring: 0, nearest: null };
  const nearest = summary.nearest;
  const upcoming = state.certificates.filter((item) => !item.staging).slice(0, 6);
  const recent = state.history.slice(0, 5);
  const connectionLabel = state.connectionStatus === 'online'
    ? '在线'
    : state.connectionStatus === 'offline'
      ? '未连接'
      : '检测中';
  const connectionTone = state.connectionStatus === 'online'
    ? 'ok'
    : state.connectionStatus === 'offline'
      ? 'danger'
      : 'warn';
  const connectionValue = state.connectionStatus === 'checking'
    ? '<div class="metric-value" data-loading="true"><span class="loading-ring" role="status" aria-label="正在检测服务器连接"></span></div>'
    : `<div class="metric-value" data-tone="${connectionTone}">${connectionLabel}</div>`;
  const expiringTone = summary.expiring > 0 ? 'warn' : 'muted';
  const nearestTone = nearest
    ? nearest.daysLeft < 0
      ? 'danger'
      : nearest.daysLeft <= 30
        ? 'warn'
        : 'ok'
    : 'muted';
  const metricLoader = '<div class="metric-value" data-loading="true"><span class="loading-ring" role="status" aria-label="正在加载"></span></div>';
  const totalValue = state.dataLoading
    ? metricLoader
    : `<div class="metric-value">${summary.total}</div>`;
  const expiringValue = state.dataLoading
    ? metricLoader
    : `<div class="metric-value" data-tone="${expiringTone}">${summary.expiring}</div>`;
  const nearestValue = state.dataLoading
    ? metricLoader
    : `<div class="metric-value" data-tone="${nearestTone}">${nearest ? daysLabel(nearest.daysLeft) : '—'}</div>`;

  const historyRows = state.dataLoading
    ? skeletonRows(5, 5)
    : state.historyError
      ? historyErrorRow(5)
      : recent.length
        ? recent.map((item) => `<tr>
          <td>${esc(formatDateTime(item.at))}</td>
          <td>${esc(actionLabel(item.type))}</td>
          <td><span class="domain">${esc(item.target || '—')}</span></td>
          <td><span class="status-text" data-tone="${historyTone(item)}">${esc(historyResult(item))}</span></td>
          <td class="numeric">${esc(formatDuration(item.durationMs))}</td>
        </tr>`).join('')
        : '<tr><td colspan="5" class="muted">暂无操作记录</td></tr>';

  return `
    <div class="metrics">
      <div class="metric">
        <div class="metric-label">证书总数</div>
        ${totalValue}
        <div class="metric-note">${state.dataLoading ? '—' : `正式 ${summary.production} 张 · 测试 ${summary.staging} 张`}</div>
      </div>
      <div class="metric">
        <div class="metric-label">需要关注</div>
        ${expiringValue}
        <div class="metric-note">30 天内到期或已过期</div>
      </div>
      <div class="metric">
        <div class="metric-label">最近到期</div>
        ${nearestValue}
        <div class="metric-note">${state.dataLoading ? '—' : (nearest ? esc(nearest.domain) : '暂无正式证书')}</div>
      </div>
      <div class="metric">
        <div class="metric-label">服务器</div>
        ${connectionValue}
        <div class="metric-note">SSH 远程管理</div>
      </div>
    </div>

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">按到期时间</h2>
        <span class="section-note">仅显示前 6 张</span>
      </div>
      ${certificateTable(upcoming, { actions: false })}
    </section>

    <section class="section">
      <div class="section-head">
        <h2 class="section-title">最近操作</h2>
        <span class="section-note">最近 5 条</span>
      </div>
      <table class="table history-table">
        <colgroup class="history-col history-col--recent"><col><col><col><col><col></colgroup>
        <thead>
          <tr><th>时间</th><th>操作</th><th>域名</th><th>结果</th><th class="numeric">耗时</th></tr>
        </thead>
        <tbody>${historyRows}</tbody>
      </table>
    </section>
  `;
}

function renderCertificates() {
  const production = state.certificates.filter((item) => !item.staging).length;
  return `
    <div class="section-head">
      <h2 class="section-title">全部证书</h2>
      <span class="section-note">${state.dataLoading ? '—' : `正式 ${production} 张 · 测试 ${state.certificates.length - production} 张`}</span>
    </div>
    ${certificateTable(state.certificates)}
  `;
}

function renderIssue() {
  const keyOptions = (item) => {
    const label = item === 'ec-256' ? 'ECDSA P-256' : item === 'ec-384' ? 'ECDSA P-384' : `RSA ${item}`;
    return `<option value="${esc(item)}">${esc(label)}</option>`;
  };

  return `
    <div class="split">
      <form id="issue-form" novalidate>
        <div class="field">
          <label for="issue-domains">域名</label>
          <textarea id="issue-domains" name="domains" placeholder="shop.example.com&#10;api.example.com"></textarea>
          <div class="help">第一个域名作为证书主名，其余作为 SAN。支持换行或逗号分隔，单次最多 10 个。</div>
        </div>

        <div class="field">
          <label for="issue-webroot">HTTP-01 校验目录</label>
          <input type="text" id="issue-webroot" name="webroot" placeholder="/var/www/shop.example.com" spellcheck="false">
          <div class="help">必须是服务器上的绝对路径，且 80 端口能直接访问该目录下的 .well-known/acme-challenge。</div>
        </div>

        <div class="field">
          <label for="issue-email">ACME 账户邮箱</label>
          <input type="text" id="issue-email" name="email" placeholder="admin@example.com" spellcheck="false">
          <div class="help">用于账户注册与到期提醒，不写入操作历史。</div>
        </div>

        <div class="field">
          <label for="issue-key">密钥类型</label>
          <select id="issue-key" name="keyType">
            <option value="">请选择</option>
            ${['2048', '4096', 'ec-256', 'ec-384'].map(keyOptions).join('')}
          </select>
          <div class="help">上传工具或旧设备只支持 RSA 时请选择 RSA；ECDSA 性能更好但兼容性较弱。</div>
        </div>

        <div class="field">
          <div class="checkline"><input type="checkbox" id="issue-staging" name="staging"><label for="issue-staging">使用测试环境（证书不被浏览器信任）</label></div>
          <div class="checkline"><input type="checkbox" id="issue-force" name="force"><label for="issue-force">已存在有效证书时强制重新签发</label></div>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" type="submit" id="issue-submit">签发证书</button>
          <button class="btn" type="button" id="issue-precheck">先做预检</button>
        </div>

        <div id="issue-notice"></div>
        <div class="console" id="job-console" hidden>
          <div class="console-head">
            <span id="job-label">任务</span>
            <span class="console-head-side">
              <span id="job-state">等待中</span>
              <button class="btn-link" type="button" id="job-cancel" hidden>取消任务</button>
            </span>
          </div>
          <div class="console-body" id="job-log"></div>
        </div>
      </form>

      <aside>
        <div class="side-note">
          <h3 class="side-note-title">执行前确认</h3>
          <p>签发会调用服务器上的 acme.sh，通过 HTTP-01 校验域名控制权。80 端口必须能从公网访问。</p>
          <p>预检会检查 DNS 解析与校验路径的响应码。返回 404 表示路径正常；返回 301 或 403 需要先修正 Nginx。</p>
          <p>正式证书受 Let's Encrypt 重复签发限制，调试阶段请先使用测试环境。</p>
          <p>脚本路径与默认值可在设置页调整。</p>
        </div>
      </aside>
    </div>
  `;
}

function renderHistory() {
  const rows = state.dataLoading
    ? skeletonRows(8, 6)
    : state.historyError
      ? historyErrorRow(6)
      : state.history.length
        ? state.history.map((item) => `<tr>
          <td>${esc(formatDateTime(item.at))}</td>
          <td>${esc(actionLabel(item.type))}</td>
          <td><span class="domain">${esc(item.target || '—')}</span></td>
          <td><span class="status-text" data-tone="${historyTone(item)}">${esc(historyResult(item))}</span></td>
          <td class="numeric">${esc(formatDuration(item.durationMs))}</td>
          <td class="numeric">${item.exitCode === null || item.exitCode === undefined ? '—' : esc(item.exitCode)}</td>
        </tr>`).join('')
        : '<tr><td colspan="6" class="muted">暂无操作记录</td></tr>';

  return `
    <div class="section-head">
      <h2 class="section-title">全部记录</h2>
      <span class="section-note">最多显示最近 100 条</span>
    </div>
    <table class="table history-table">
      <colgroup class="history-col"><col><col><col><col><col><col></colgroup>
      <thead>
        <tr><th>时间</th><th>操作</th><th>域名</th><th>结果</th><th class="numeric">耗时</th><th class="numeric">退出码</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderSettings() {
  const settings = state.settings || {};
  return `
    <div class="split">
      <form id="settings-form" novalidate>
        <div class="settings-status" id="settings-status"></div>
        <div class="field">
          <label for="ssh-host">SSH 主机</label>
          <input type="text" id="ssh-host" name="sshHost" value="${esc(settings.sshHost || '')}" placeholder="srv01.example.com" spellcheck="false">
        </div>
        <div class="field">
          <label for="ssh-port">SSH 端口</label>
          <input type="text" id="ssh-port" name="sshPort" value="${esc(settings.sshPort ?? '')}" placeholder="22" spellcheck="false">
        </div>
        <div class="field">
          <label for="ssh-user">SSH 用户</label>
          <input type="text" id="ssh-user" name="sshUser" value="${esc(settings.sshUser || '')}" placeholder="deploy" spellcheck="false">
        </div>
        <div class="field">
          <label for="ssh-key">私钥路径</label>
          <input type="text" id="ssh-key" name="sshKeyPath" value="${esc(settings.sshKeyPath || '')}" placeholder="/home/deploy/.ssh/id_ed25519" spellcheck="false">
          <div class="help">只保存路径，不复制私钥内容。建议使用仅能登录该服务器的专用密钥。</div>
        </div>
        <div class="field">
          <label for="issue-script">签发脚本路径</label>
          <input type="text" id="issue-script" name="issueScript" value="${esc(settings.issueScript || '')}" placeholder="/opt/acmedesk/issue-letsencrypt-cert.sh" spellcheck="false">
        </div>
        <div class="field">
          <label for="acme-home">acme.sh 目录</label>
          <input type="text" id="acme-home" name="acmeHome" value="${esc(settings.acmeHome || '')}" placeholder="/root/.acme.sh" spellcheck="false">
          <div class="help">用于读取证书清单、执行续期与导出文件。</div>
        </div>
        <div class="field">
          <label for="default-email">默认邮箱</label>
          <input type="text" id="default-email" name="defaultEmail" value="${esc(settings.defaultEmail || '')}" placeholder="admin@example.com" spellcheck="false">
        </div>
        <div class="field">
          <label for="default-webroot">默认校验目录</label>
          <input type="text" id="default-webroot" name="defaultWebroot" value="${esc(settings.defaultWebroot || '')}" placeholder="/var/www/shop.example.com" spellcheck="false">
        </div>
        <div class="field">
          <label for="default-key">默认密钥类型</label>
          <select id="default-key" name="defaultKeyType">
            <option value="">未设置</option>
            ${['2048', '4096', 'ec-256', 'ec-384'].map((item) => `<option value="${esc(item)}"${item === settings.defaultKeyType ? ' selected' : ''}>${esc(item === 'ec-256' ? 'ECDSA P-256' : item === 'ec-384' ? 'ECDSA P-384' : `RSA ${item}`)}</option>`).join('')}
          </select>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" id="settings-save">保存设置</button>
          <button class="btn" type="button" id="settings-test">测试连接</button>
        </div>
        <div id="settings-notice"></div>
      </form>

      <aside>
        <div class="side-note">
          <h3 class="side-note-title">连接说明</h3>
          <p>管理台只监听 127.0.0.1，所有操作通过 SSH 在此机上发起。</p>
          <p>服务器需要允许公钥登录，且该用户能执行 acme.sh 与 nginx 重载命令。</p>
          <p>保存前会校验私钥文件是否存在；测试连接不会写入配置。</p>
          <p>配置保存后会立即生效，并在下方回填显示。</p>
        </div>
      </aside>
    </div>
  `;
}

function currentRoute() {
  const hash = location.hash.replace(/^#\//, '');
  return ROUTES[hash] ? hash : 'overview';
}

function setPageMeta(routeKey) {
  const route = ROUTES[routeKey];
  els.pageEyebrow.textContent = route.eyebrow;
  els.pageTitle.textContent = route.title;
}

function render() {
  const routeKey = state.route;
  setPageMeta(routeKey);
  els.view.innerHTML = ROUTES[routeKey].render();
  bindCommon();
  if (routeKey === 'issue') {
    bindIssue();
  }
  if (routeKey === 'settings') {
    bindSettings();
  }
}

function closeDownloadMenus() {
  for (const menu of document.querySelectorAll('[data-download-menu]')) {
    menu.dataset.open = 'false';
    const trigger = menu.querySelector('.download-trigger');
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
    }
  }
}

function bindDownloadMenus() {
  for (const menu of els.view.querySelectorAll('[data-download-menu]')) {
    if (menu.dataset.bound === 'true') {
      continue;
    }
    menu.dataset.bound = 'true';
    const trigger = menu.querySelector('.download-trigger');
    if (!trigger) {
      continue;
    }
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const pinned = menu.dataset.open === 'true';
      closeDownloadMenus();
      if (!pinned) {
        menu.dataset.open = 'true';
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
    for (const item of menu.querySelectorAll('.download-item')) {
      item.addEventListener('click', closeDownloadMenus);
    }
  }
}

function bindCommon() {
  for (const button of els.view.querySelectorAll('[data-renew]')) {
    button.addEventListener('click', () => {
      const domain = button.dataset.renew;
      const keyType = button.dataset.key;
      openModal({
        title: `续期 ${domain}`,
        body: '将强制重新签发并覆盖服务器上的现有证书。正式证书受重复签发限制，确认继续？',
        confirmText: '开始续期',
        onConfirm: () => startJob({
          type: 'renew',
          payload: { domain, keyType }
        })
      });
    });
  }

  for (const button of els.view.querySelectorAll('[data-revoke]')) {
    button.addEventListener('click', () => {
      const domain = button.dataset.revoke;
      const keyType = button.dataset.key;
      const staging = button.dataset.staging === 'true';
      openModal({
        title: `吊销 ${domain}`,
        body: '吊销不可撤销：证书会立即失效，并从 acme.sh 续期列表移除。Nginx 仍会继续下发这张已吊销证书，需要你同步替换或移除对应证书配置。请输入完整域名以确认。',
        confirmText: '确认吊销',
        tone: 'danger',
        requirePhrase: domain,
        onConfirm: () => startJob({
          type: 'revoke',
          payload: { domain, keyType, staging, confirm: domain }
        })
      });
    });
  }

  bindDownloadMenus();
}

function formValues(form) {
  const data = new FormData(form);
  return {
    sshHost: String(data.get('sshHost') || '').trim(),
    sshPort: String(data.get('sshPort') || '').trim(),
    sshUser: String(data.get('sshUser') || '').trim(),
    sshKeyPath: String(data.get('sshKeyPath') || '').trim(),
    issueScript: String(data.get('issueScript') || '').trim(),
    acmeHome: String(data.get('acmeHome') || '').trim(),
    defaultEmail: String(data.get('defaultEmail') || '').trim(),
    defaultWebroot: String(data.get('defaultWebroot') || '').trim(),
    defaultKeyType: String(data.get('defaultKeyType') || '').trim()
  };
}

function bindIssue() {
  const form = document.getElementById('issue-form');
  const precheckButton = document.getElementById('issue-precheck');
  const submitButton = document.getElementById('issue-submit');
  const notice = document.getElementById('issue-notice');
  const cancelButton = document.getElementById('job-cancel');

  if (cancelButton) {
    cancelButton.addEventListener('click', async () => {
      if (!state.job || state.job.status !== 'running') {
        return;
      }
      cancelButton.disabled = true;
      cancelButton.textContent = '正在终止';
      try {
        await api(`/api/jobs/${encodeURIComponent(state.job.id)}/cancel`, { method: 'POST' });
        if (state.job && state.job.status === 'running') {
          state.job.status = 'cancelling';
          renderJobState(state.job);
        }
      } catch (error) {
        cancelButton.disabled = false;
        cancelButton.textContent = '取消任务';
        showNotice(notice, 'danger', error.message);
      }
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    notice.innerHTML = '';
    const data = new FormData(form);
    const domains = String(data.get('domains') || '').trim();
    if (!domains) {
      showNotice(notice, 'danger', '请至少填写一个域名');
      return;
    }
    setBusy(true, submitButton, precheckButton);
    try {
      await startJob({
        type: 'issue',
        payload: {
          domains,
          webroot: String(data.get('webroot') || '').trim(),
          email: String(data.get('email') || '').trim(),
          keyType: String(data.get('keyType') || '').trim(),
          staging: data.get('staging') === 'on',
          force: data.get('force') === 'on'
        }
      });
    } catch (error) {
      showNotice(notice, 'danger', error.message);
      setBusy(false, submitButton, precheckButton);
    }
  });

  precheckButton.addEventListener('click', async () => {
    notice.innerHTML = '';
    const domain = String(new FormData(form).get('domains') || '').split(/[\s,]+/)[0];
    if (!domain) {
      showNotice(notice, 'danger', '请先填写域名');
      return;
    }
    precheckButton.disabled = true;
    try {
      const { precheck } = await api('/api/precheck', {
        method: 'POST',
        body: { domain }
      });
      const tone = precheck.level === 'ok' ? 'ok' : precheck.level === 'warn' ? 'warn' : 'danger';
      showNotice(notice, tone, `${precheck.domain} · 解析 ${precheck.ip || '无'} · HTTP ${precheck.httpCode} · ${precheck.message}`);
    } catch (error) {
      showNotice(notice, 'danger', error.message);
    } finally {
      precheckButton.disabled = false;
    }
  });

  if (state.job) {
    const consoleBlock = document.getElementById('job-console');
    if (consoleBlock) {
      consoleBlock.hidden = false;
      renderJobState(state.job);
      if (state.job.log) {
        const log = document.getElementById('job-log');
        log.innerHTML = '';
        for (const entry of state.job.log) {
          appendLogLine(log, entry);
        }
      }
      if (state.job.status === 'running' || state.job.status === 'cancelling') {
        setBusy(true, submitButton, precheckButton);
      }
    }
  }
}

async function refreshSettingsStatus() {
  const el = document.getElementById('settings-status');
  if (!el) {
    return;
  }
  try {
    const { configured, updatedAt } = await api('/api/settings/status');
    el.textContent = configured
      ? `配置已保存 · 最近更新 ${formatDateTime(updatedAt)}`
      : '尚未保存配置';
  } catch (error) {
    el.textContent = '配置状态读取失败';
  }
}

function bindSettings() {
  const form = document.getElementById('settings-form');
  const saveButton = document.getElementById('settings-save');
  const testButton = document.getElementById('settings-test');
  const notice = document.getElementById('settings-notice');
  refreshSettingsStatus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    notice.innerHTML = '';
    saveButton.disabled = true;
    try {
      const { settings } = await api('/api/settings', {
        method: 'PUT',
        body: formValues(form)
      });
      state.settings = settings;
      showNotice(notice, 'ok', '设置已保存');
      await refreshSettingsStatus();
    } catch (error) {
      showNotice(notice, 'danger', error.message);
      return;
    } finally {
      saveButton.disabled = false;
    }
    try {
      await loadCertificates();
      await checkConnection();
    } catch (error) {
      showAppNotice('danger', error.message);
    }
  });

  testButton.addEventListener('click', async () => {
    notice.innerHTML = '';
    testButton.disabled = true;
    try {
      const { connection } = await api('/api/settings/test', {
        method: 'POST',
        body: formValues(form)
      });
      setConnection('online', '连接正常');
      showNotice(notice, 'ok', `连接成功 · ${connection.latencyMs} ms${connection.nginx ? ` · ${connection.nginx}` : ''}`);
    } catch (error) {
      setConnection('offline', '连接失败');
      showNotice(notice, 'danger', error.message);
    } finally {
      testButton.disabled = false;
    }
  });
}

function showNotice(container, tone, message) {
  container.innerHTML = `<div class="notice" data-tone="${tone}">${esc(message)}</div>`;
}

function showAppNotice(tone, message) {
  if (!message) {
    els.appNotice.hidden = true;
    els.appNotice.innerHTML = '';
    return;
  }
  els.appNotice.hidden = false;
  showNotice(els.appNotice, tone, message);
}

function setConnection(stateName, label) {
  state.connectionStatus = stateName;
  els.dot.dataset.state = stateName;
  els.status.textContent = label;
}

function setBusy(busy, ...buttons) {
  for (const button of buttons) {
    if (button) {
      button.disabled = busy;
    }
  }
}

async function startJob(payload) {
  const { job } = await api('/api/jobs', { method: 'POST', body: payload });
  state.job = job;
  state.job.log = [];
  if (state.route !== 'issue') {
    location.hash = '#/issue';
    state.route = 'issue';
    navigate();
  } else {
    render();
  }
  streamJob(job.id);
}

function renderJobState(job) {
  const label = document.getElementById('job-label');
  const badge = document.getElementById('job-state');
  if (!label || !badge) {
    return;
  }
  label.textContent = job.label || job.type;
  badge.textContent = jobLabel(job.status);
  badge.dataset.tone = jobTone(job.status);

  const cancel = document.getElementById('job-cancel');
  if (cancel) {
    cancel.hidden = job.status !== 'running';
    if (cancel.hidden) {
      cancel.disabled = false;
      cancel.textContent = '取消任务';
    }
  }
}

function appendLogLine(container, entry) {
  const line = document.createElement('div');
  line.className = entry.stream === 'stderr' ? 'log-line err' : entry.stream === 'meta' ? 'log-line meta' : 'log-line';
  line.textContent = entry.text;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function streamJob(jobId) {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
  const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  state.source = source;

  let opened = 0;
  source.onopen = () => {
    opened += 1;
    if (opened > 1) {
      if (state.job) {
        state.job.log = [];
      }
      const container = document.getElementById('job-log');
      if (container) {
        container.innerHTML = '';
      }
    }
  };

  source.onmessage = (event) => {
    let entry;
    try {
      entry = JSON.parse(event.data);
    } catch (error) {
      entry = { stream: 'meta', text: event.data };
    }
    if (state.job) {
      state.job.log.push(entry);
    }
    const container = document.getElementById('job-log');
    if (container) {
      appendLogLine(container, entry);
    }
  };

  source.addEventListener('done', async (event) => {
    source.close();
    state.source = null;
    let job = state.job;
    try {
      job = JSON.parse(event.data);
    } catch (error) {
      job = state.job;
    }
    state.job = job;
    renderJobState(job);
    const submit = document.getElementById('issue-submit');
    const precheck = document.getElementById('issue-precheck');
    setBusy(false, submit, precheck);
    try {
      await loadData();
      if (['overview', 'certificates', 'history'].includes(state.route)) {
        render();
      }
      const terminationText = terminationNotice(job);
      const resultMessage = `${
        job.status === 'success'
          ? `任务完成：${job.label}`
          : job.status === 'cancelled'
            ? `任务已取消：${job.label}`
            : job.status === 'interrupted'
              ? `任务已中断：${job.label}`
              : `任务失败：${job.label}，请查看执行日志`
      }${terminationText}`;
      const historyMessage = state.historyError ? `；操作记录读取失败：${state.historyError}` : '';
      const noticeTone = state.historyError || job.remoteTermination === 'unconfirmed'
        ? 'danger'
        : job.remoteTermination === 'requested'
          ? 'warn'
          : jobTone(job.status);
      showAppNotice(noticeTone, `${resultMessage}${historyMessage}`);
    } catch (error) {
      showAppNotice('danger', `证书列表刷新失败：${error.message}`);
    }
    const notice = document.getElementById('issue-notice');
    if (notice) {
      showNotice(
        notice,
        job.remoteTermination === 'unconfirmed'
          ? 'danger'
          : job.remoteTermination === 'requested'
            ? 'warn'
            : jobTone(job.status),
        `${
          job.status === 'success'
            ? '任务执行完成'
            : job.status === 'cancelled'
              ? '任务已取消'
              : job.status === 'interrupted'
                ? '任务已中断，请查看上方日志'
                : '任务执行失败，请查看上方日志'
        }${terminationText}`
      );
    }
  });

  source.onerror = () => {
    const badge = document.getElementById('job-state');
    if (badge && state.job && state.job.status === 'running') {
      badge.dataset.tone = 'warn';
      badge.textContent = '连接中断，正在重连';
    }
  };
}

async function loadCertificates() {
  try {
    const data = await api('/api/certificates');
    state.certificates = data.items || [];
    state.summary = data.summary || null;
  } catch (error) {
    state.certificates = [];
    state.summary = null;
    setConnection('offline', '读取失败');
    throw error;
  }
}

async function loadHistory() {
  try {
    const data = await api('/api/history');
    state.history = data.items || [];
  } catch (error) {
    state.history = [];
    throw error;
  }
}

async function loadData() {
  state.historyError = null;
  const [certResult, historyResult] = await Promise.allSettled([
    loadCertificates(),
    loadHistory()
  ]);
  state.dataLoading = false;
  if (historyResult.status === 'rejected') {
    state.historyError = (historyResult.reason && historyResult.reason.message) || '操作记录读取失败';
  }
  if (certResult.status === 'rejected') {
    throw certResult.reason;
  }
}

async function checkConnection() {
  setConnection('checking', '检测连接中');
  try {
    await api('/api/settings/test', {
      method: 'POST',
      body: {}
    });
    setConnection('online', '连接正常');
  } catch (error) {
    setConnection('offline', '连接失败');
  }
  if (state.route === 'overview') {
    render();
  }
}

let modalReturnFocus = null;

function openModal({ title, body, confirmText, tone = 'primary', requirePhrase = null, onConfirm }) {
  modalReturnFocus = document.activeElement;
  els.modalTitle.textContent = title;
  els.modalBody.textContent = body;
  els.modalConfirm.textContent = confirmText || '确认';
  els.modalConfirm.className = tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
  state.modalPhrase = requirePhrase;
  state.modalAction = onConfirm;
  els.modalField.hidden = !requirePhrase;
  els.modalInput.value = '';
  els.modalConfirm.disabled = Boolean(requirePhrase);
  els.modal.hidden = false;
  if (requirePhrase) {
    els.modalInput.focus();
  } else {
    els.modalConfirm.focus();
  }
}

function closeModal() {
  const returnFocus = modalReturnFocus;
  modalReturnFocus = null;
  els.modal.hidden = true;
  state.modalAction = null;
  state.modalPhrase = null;
  els.modalField.hidden = true;
  els.modalInput.value = '';
  els.modalConfirm.disabled = false;
  if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
    returnFocus.focus();
  }
}

function modalFocusables() {
  const items = [];
  if (!els.modalField.hidden) {
    items.push(els.modalInput);
  }
  items.push(els.modalCancel);
  if (!els.modalConfirm.disabled) {
    items.push(els.modalConfirm);
  }
  return items;
}

async function refreshAll() {
  els.refresh.disabled = true;
  state.dataLoading = true;
  if (state.route === 'overview') {
    render();
  }
  try {
    await loadData();
    const tableRoute = ['overview', 'certificates', 'history'].includes(state.route);
    if (tableRoute) {
      render();
    }
    if (state.historyError) {
      if (!['overview', 'history'].includes(state.route)) {
        showAppNotice('danger', `操作记录读取失败：${state.historyError}`);
      }
    } else if (!tableRoute) {
      showAppNotice('ok', '数据已刷新，当前表单内容未改动');
    }
  } catch (error) {
    showAppNotice('danger', error.message);
    if (state.route === 'overview') {
      render();
    }
  } finally {
    els.refresh.disabled = false;
  }
}

function navigate() {
  state.route = currentRoute();
  showAppNotice(null);
  for (const link of els.nav.querySelectorAll('a')) {
    if (link.dataset.route === state.route) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
  render();
  updateSegmentedThumb();
}

let thumbInitialized = false;
let resizeFrame = null;

/**
 * 胶囊滑块的位置取自当前段落的实际布局，而不是硬编码序号宽度；
 * 这样在字体、窗口宽度变化后仍能精确贴合，首帧关闭过渡以避免从零位滑入。
 */
function updateSegmentedThumb() {
  const active = els.nav.querySelector('a[aria-current="page"]');
  if (!active || !els.thumb) {
    return;
  }

  const navRect = els.nav.getBoundingClientRect();
  const linkRect = active.getBoundingClientRect();
  const navStyle = window.getComputedStyle(els.nav);
  const borderLeft = parseFloat(navStyle.borderLeftWidth) || 0;
  const borderTop = parseFloat(navStyle.borderTopWidth) || 0;
  const x = linkRect.left - navRect.left - borderLeft;
  const y = linkRect.top - navRect.top - borderTop;

  if (!thumbInitialized) {
    els.thumb.style.transition = 'none';
  }

  els.thumb.style.width = `${linkRect.width}px`;
  els.thumb.style.height = `${linkRect.height}px`;
  els.thumb.style.transform = `translate(${x}px, ${y}px)`;

  if (!thumbInitialized) {
    void els.thumb.offsetWidth;
    thumbInitialized = true;
    requestAnimationFrame(() => {
      els.thumb.style.transition = '';
      els.thumb.dataset.ready = 'true';
    });
  }
}

async function init() {
  navigate();

  try {
    const { settings } = await api('/api/settings');
    state.settings = settings;
    if (state.route === 'settings') {
      render();
    }
  } catch (error) {
    showAppNotice('danger', `配置读取失败：${error.message}`);
  }

  try {
    await loadData();
    if (state.historyError && !['overview', 'history'].includes(state.route)) {
      showAppNotice('danger', `操作记录读取失败：${state.historyError}`);
    }
  } catch (error) {
    showAppNotice('danger', error.message);
  }
  render();
  checkConnection();
}

els.refresh.addEventListener('click', refreshAll);
window.addEventListener('hashchange', navigate);
window.addEventListener('resize', () => {
  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
  }
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    updateSegmentedThumb();
  });
});

els.modalCancel.addEventListener('click', closeModal);
els.modalInput.addEventListener('input', () => {
  if (!state.modalPhrase) {
    els.modalConfirm.disabled = false;
    return;
  }
  els.modalConfirm.disabled = els.modalInput.value.trim().toLowerCase() !== state.modalPhrase.toLowerCase();
});
els.modal.addEventListener('click', (event) => {
  if (event.target === els.modal) {
    closeModal();
  }
});
els.modalConfirm.addEventListener('click', async () => {
  const action = state.modalAction;
  closeModal();
  if (action) {
    try {
      await action();
    } catch (error) {
      showAppNotice('danger', error.message);
      const notice = document.getElementById('issue-notice');
      if (notice) {
        showNotice(notice, 'danger', error.message);
      }
      setBusy(false, document.getElementById('issue-submit'), document.getElementById('issue-precheck'));
    }
  }
});

document.addEventListener('click', closeDownloadMenus);
document.addEventListener('keydown', (event) => {
  if (!els.modal.hidden) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key === 'Tab') {
      const items = modalFocusables();
      if (!items.length) {
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!els.modal.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }
    return;
  }

  if (event.key !== 'Escape') {
    return;
  }
  closeDownloadMenus();
  if (document.activeElement && document.activeElement.closest('[data-download-menu]')) {
    document.activeElement.blur();
  }
});

init();

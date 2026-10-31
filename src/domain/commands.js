'use strict';

const {
  ValidationError,
  parseDomains,
  validateEmail,
  validateWebroot,
  validateKeyType,
  validateAcmeHome,
  validateScriptPath,
  validateDomain,
  validateDownloadKind,
  isEcKeyType
} = require('./validation');

/**
 * 远端命令构建。
 *
 * 所有拼入命令的值都经过白名单校验后再做单引号转义，形成双层防护：
 * 校验负责拒绝危险字符，转义负责消化剩余可接受字符的 shell 语义。
 */
function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function joinPath(base, ...parts) {
  return [base, ...parts].join('/').replace(/\/+/g, '/');
}

/**
 * 证书清点脚本。以制表符分隔输出，时间统一转成 UTC 秒，
 * 避免不同发行版对日期字符串的解析差异影响前端展示。
 */
function buildListScript(acmeHome) {
  const home = validateAcmeHome(acmeHome);
  return `set -u
for dir in ${quote(home)}/*/; do
  [ -d "$dir" ] || continue
  conf=""
  for candidate in "$dir"*.conf; do
    if [ -f "$candidate" ]; then conf="$candidate"; break; fi
  done
  [ -n "$conf" ] || continue
  main=$(basename "$conf" .conf)
  alt=$(sed -n "s/^Le_Alt='\\(.*\\)'$/\\1/p" "$conf" | head -n 1)
  keylen=$(sed -n "s/^Le_Keylength='\\(.*\\)'$/\\1/p" "$conf" | head -n 1)
  webroot=$(sed -n "s/^Le_Webroot='\\(.*\\)'$/\\1/p" "$conf" | head -n 1)
  api=$(sed -n "s/^Le_API='\\(.*\\)'$/\\1/p" "$conf" | head -n 1)
  next=$(sed -n "s/^Le_NextRenewTime='\\(.*\\)'$/\\1/p" "$conf" | head -n 1)
  cer="$dir$main.cer"
  start_epoch=""
  end_epoch=""
  if [ -f "$cer" ]; then
    start_raw=$(openssl x509 -in "$cer" -noout -startdate 2>/dev/null | cut -d= -f2)
    end_raw=$(openssl x509 -in "$cer" -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -n "$start_raw" ]; then start_epoch=$(date -u -d "$start_raw" +%s 2>/dev/null || true); fi
    if [ -n "$end_raw" ]; then end_epoch=$(date -u -d "$end_raw" +%s 2>/dev/null || true); fi
  fi
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$main" "$alt" "$keylen" "$webroot" "$api" "$next" "$start_epoch" "$end_epoch" "$(basename "$dir")"
done`;
}

function buildPrecheckScript() {
  return `set -u
domain="$1"
ip=$(getent hosts "$domain" 2>/dev/null | awk '{print $1}' | head -n 1)
code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://$domain/.well-known/acme-challenge/acmedesk-probe" 2>/dev/null || echo 000)
printf '%s\\t%s\\n' "\${ip:-none}" "$code"`;
}

function buildPrecheckCommand(domain) {
  return `sh -s -- ${quote(validateDomain(domain))}`;
}

function buildIssueCommand({ issueScript, domains, webroot, email, keyType, staging, force }) {
  const script = validateScriptPath(issueScript);
  const domainList = parseDomains(domains);
  const target = validateWebroot(webroot);
  const mailbox = validateEmail(email);
  const key = validateKeyType(keyType);

  const parts = [quote(script)];
  for (const domain of domainList) {
    parts.push('-d', quote(domain));
  }
  parts.push('-w', quote(target), '-e', quote(mailbox), '-k', quote(key));
  if (staging) {
    parts.push('--staging');
  }
  if (force) {
    parts.push('--force');
  }
  return parts.join(' ');
}

function buildRenewCommand({ acmeHome, domain, keyType }) {
  const home = validateAcmeHome(acmeHome);
  const name = validateDomain(domain);
  const key = validateKeyType(keyType);
  const script = quote(joinPath(home, 'acme.sh'));
  const ecc = isEcKeyType(key) ? ' --ecc' : '';
  return `${script} --renew -d ${quote(name)}${ecc} --force`;
}

/**
 * 吊销后必须同时移出续期列表，否则定时任务会重新签发，
 * 使吊销在下一个续期窗口失效。
 */
function buildRevokeCommand({ acmeHome, domain, keyType, staging }) {
  const home = validateAcmeHome(acmeHome);
  const name = validateDomain(domain);
  const key = validateKeyType(keyType);
  const script = quote(joinPath(home, 'acme.sh'));
  const ecc = isEcKeyType(key) ? ' --ecc' : '';
  const stage = staging ? ' --staging' : '';
  return `${script} --revoke -d ${quote(name)}${ecc}${stage} && ${script} --remove -d ${quote(name)}${ecc}`;
}

function buildTestCommand() {
  return 'printf "host=%s\\n" "$(hostname)"; printf "user=%s\\n" "$(id -un)"; command -v nginx >/dev/null 2>&1 && nginx -v 2>&1 || true';
}

function buildDownloadPath({ acmeHome, domain, keyType, kind }) {
  const home = validateAcmeHome(acmeHome);
  const name = validateDomain(domain);
  const key = validateKeyType(keyType);
  const type = validateDownloadKind(kind);
  const dirName = isEcKeyType(key) ? `${name}_ecc` : name;
  const fileMap = {
    fullchain: 'fullchain.cer',
    key: `${name}.key`,
    chain: 'ca.cer'
  };
  return joinPath(home, dirName, fileMap[type]);
}

function buildDownloadCommand(options) {
  return `cat ${quote(buildDownloadPath(options))}`;
}

/**
 * 任务进程标识。
 *
 * 任务结束后远端 PID 文件会被清理；取消与超时依赖该文件定位进程组，
 * 因此标识只允许内部生成的任务号，不能接受外部输入。
 */
function validatePidFile(pidFile) {
  const value = String(pidFile ?? '').trim();
  if (!/^\/tmp\/acmedesk-[a-z0-9-]+\.pid$/i.test(value)) {
    throw new ValidationError('远端任务标识不合法');
  }
  return value;
}

function buildRemotePidFile(jobId) {
  const id = String(jobId ?? '').trim();
  if (!/^[a-z0-9-]{8,64}$/i.test(id)) {
    throw new ValidationError('任务号不合法');
  }
  return validatePidFile(`/tmp/acmedesk-${id.toLowerCase()}.pid`);
}

/**
 * 任务命令必须由 shell 会话组承载。
 *
 * 直接结束本地 ssh 只能关闭连接，远端进程可能继续运行；包装层把 PID/PGID
 * 写入文件，优先建立独立会话；没有 setsid 时复用当前进程组，两者都不可用
 * 则拒绝启动，避免留下无法定位的远端进程。
 */
function buildWrappedJobCommand(command, pidFile) {
  const body = String(command ?? '');
  if (!body.trim()) {
    throw new ValidationError('远端命令不能为空');
  }
  if (/[\r\n]/.test(body)) {
    throw new ValidationError('远端命令不能包含换行');
  }
  const pid = validatePidFile(pidFile);
  const script = `umask 077
mode="$2"
if [ "$mode" = "setsid" ]; then
  pgid=$$
else
  pgid="$mode"
fi
case "$pgid" in
  ''|*[!0-9]*|0*)
    printf 'AcmeDesk: 无法确定远端进程组\\n' >&2
    exit 2
    ;;
esac
printf '%s %s\\n' "$$" "$pgid" > "$1.tmp"
if ! mv -f "$1.tmp" "$1"; then
  rm -f "$1.tmp"
  printf 'AcmeDesk: 无法写入远端任务标识\\n' >&2
  exit 3
fi
${body}
status=$?
rm -f "$1" "$1.tmp"
exit $status`;
  const quoted = quote(script);
  const target = quote(pid);
  return `if command -v setsid >/dev/null 2>&1 && setsid -w true >/dev/null 2>&1; then setsid -w sh -c ${quoted} sh ${target} setsid; else pgid=$(ps -o pgid= -p $$ 2>/dev/null | awk '{print $1}'); if [ -z "$pgid" ]; then printf 'AcmeDesk: 远端缺少可用的 setsid/ps/awk，无法保证任务可终止\\n' >&2; exit 127; fi; sh -c ${quoted} sh ${target} "$pgid"; fi`;
}

/**
 * 终止脚本只接受正整数 PID/PGID，避免误把 0 或带前导零的参数当成信号或进程组。
 * 优先回收进程组，可在 setsid 不可用时仍覆盖命令派生的子进程。
 */
function buildTerminationScript() {
  return `set -u
pidfile="$1"
i=0
while [ ! -s "$pidfile" ] && [ "$i" -lt 3 ]; do
  sleep 0.2 2>/dev/null || true
  i=$((i+1))
done
pid=""
pgid=""
if [ -s "$pidfile" ]; then
  read -r pid pgid < "$pidfile" || true
fi
case "$pid" in
  ''|*[!0-9]*|0*)
    rm -f "$pidfile" "$pidfile.tmp"
    printf 'none\\n'
    exit 0
    ;;
esac
case "$pgid" in
  ''|*[!0-9]*|0*) pgid="$pid" ;;
esac
alive() {
  kill -0 -"$pgid" 2>/dev/null || kill -0 "$pid" 2>/dev/null
}
if ! alive; then
  rm -f "$pidfile" "$pidfile.tmp"
  printf 'none\\n'
  exit 0
fi
if ! kill -TERM -"$pgid" 2>/dev/null; then
  kill -TERM "$pid" 2>/dev/null || true
fi
i=0
while [ "$i" -lt 5 ]; do
  if ! alive; then
    rm -f "$pidfile" "$pidfile.tmp"
    printf 'stopped\\n'
    exit 0
  fi
  sleep 0.2 2>/dev/null || true
  i=$((i+1))
done
kill -KILL -"$pgid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
rm -f "$pidfile" "$pidfile.tmp"
printf 'requested\\n'`;
}

function buildTerminationCommand(pidFile) {
  return `sh -s -- ${quote(validatePidFile(pidFile))}`;
}

module.exports = {
  quote,
  buildListScript,
  buildPrecheckScript,
  buildPrecheckCommand,
  buildIssueCommand,
  buildRenewCommand,
  buildRevokeCommand,
  buildTestCommand,
  buildDownloadPath,
  buildDownloadCommand,
  buildRemotePidFile,
  buildWrappedJobCommand,
  buildTerminationScript,
  buildTerminationCommand
};

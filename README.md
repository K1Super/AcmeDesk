# AcmeDesk

AcmeDesk 是运行在本机的证书管理台，通过 SSH 调用远端服务器上的 acme.sh，完成证书清点、HTTP-01 预检、签发、续期、吊销与文件下载。服务只监听 `127.0.0.1`，不面向局域网或公网。

## 功能

- 证书清单：解析 acme.sh 目录下的证书、SAN、密钥类型、到期时间与自动续期时间，区分正式证书与测试证书。
- 签发：调用配置的签发脚本，支持多个域名、校验目录、ACME 账户邮箱、RSA/ECDSA 与测试环境。
- 预检：检查域名解析与 `.well-known/acme-challenge` 的 HTTP 响应，提前发现重定向、403 与连接失败。
- 续期：调用 acme.sh 强制续期；吊销会同时移出续期列表，避免定时任务重新签发。
- 下载：导出 PEM 证书链、私钥与中间链。
- 任务：同一时刻只执行一个远端任务，实时输出日志，支持取消；取消、超时与服务退出会尝试按远端进程组终止并写入历史。
- 历史：记录操作类型、目标、结果、耗时、退出码与远端终止确认状态。

## 运行前提

- Node.js >= 20。
- 本机可执行的 OpenSSH 客户端 `ssh`。
- 远端 Linux 服务器已安装 acme.sh、openssl、curl、getent 与 GNU date。
- 远端任务包装优先使用 `setsid -w`；没有 setsid 时使用 `ps`/`awk` 获取进程组；两者都不可用时任务会拒绝启动，避免留下无法定位的远端进程。
- 一个可执行的签发脚本，参数约定：
  - `-d <domain>`：可重复，第一个域名作为证书主名
  - `-w <webroot>`：HTTP-01 校验目录
  - `-e <email>`：ACME 账户邮箱
  - `-k <2048|4096|ec-256|ec-384>`：密钥类型
  - `--staging`：使用测试环境
  - `--force`：强制重新签发
- 配置的 SSH 用户需能执行签发脚本、调用 acme.sh，并读取配置的 acme.sh 目录。

## 启动

```bash
npm start
```

Windows 可直接双击 `start.cmd`。默认地址为 `http://127.0.0.1:8787`，可通过环境变量修改端口：

```bash
ACMEDESK_PORT=9000 npm start
```

端口必须是 1–65535 的十进制整数。非法端口会在启动前失败并输出明确错误。

## 配置

打开“设置”页填写连接信息，保存后写入本机 `data/config.json`。源码不包含任何真实连接信息。

- SSH 主机、端口与用户
- 本地私钥路径：只保存路径，不读取或上传私钥内容
- 签发脚本路径与 acme.sh 目录
- 默认邮箱、默认校验目录与默认密钥类型

配置格式（以下值均为占位符）：

```json
{
  "sshHost": "server.example.com",
  "sshPort": 22,
  "sshUser": "deploy",
  "sshKeyPath": "/home/deploy/.ssh/id_ed25519",
  "issueScript": "/opt/acmedesk/issue-letsencrypt-cert.sh",
  "acmeHome": "/root/.acme.sh",
  "defaultEmail": "admin@example.com",
  "defaultWebroot": "/var/www/acme",
  "defaultKeyType": "2048"
}
```

`data/config.json` 与 `data/history.jsonl` 是本机运行数据，已在 `.gitignore` 中排除，不应提交或共享。

## 安全边界

- 服务只监听回环地址，并校验 `Host`、`Origin` 与 `Sec-Fetch-Site`，阻断 DNS rebinding 与跨站请求。
- 请求体限制 64 KB；进入远端命令与文件路径的值经过白名单校验和单引号转义；静态文件只允许固定白名单。
- 服务端错误响应不返回堆栈或内部路径；远端失败日志会遮蔽邮箱。
- 私钥只引用路径，不读取、不复制、不上传内容。
- 本工具没有登录认证，安全性依赖“只在本机运行”。不要把端口映射到公网或共享给其他设备。
- SSH 主机密钥首次连接自动记录，后续变更会被拒绝。需要更强保证时，请提前在 `known_hosts` 中预置服务器指纹。

## 任务终止语义

取消、超时与服务退出会先断开本地 SSH，再通过远端 PID/PGID 回收进程组。任务状态与历史记录会区分终止结果：

- `stopped`：远端进程已停止。
- `none`：任务在终止请求前已自行结束。
- `requested`：终止信号已发送，但无法逐一确认进程已退出。
- `unconfirmed`：远端终止结果未确认，任务可能仍在运行。

看到 `requested` 或 `unconfirmed` 时，应登录服务器确认没有残留的 acme.sh 或签发脚本进程。Windows 控制台被强制关闭时可能无法执行退出处理，请优先使用 Ctrl+C。

## 测试

```bash
npm test
```

CI 使用 Node.js 20 与 22 执行同一测试，并检查 `data/` 未被 Git 跟踪、拒绝私钥文件与常见令牌特征。

## 目录结构

```text
server.js           服务入口与优雅退出
public/             前端页面、样式与交互
src/config.js       本机配置存储与端口校验
src/domain/         输入校验、命令构建与证书解析
src/http/           HTTP 路由、SSE 与来源校验
src/infra/ssh.js    SSH 执行与输出上限
src/services/       配置、证书、任务与历史服务
test/               回归测试
```

## 已知限制

- 仅适配 acme.sh 的目录结构与配置键，不支持 certbot、Nginx 自带证书或其他商业 CA 客户端。
- 签发行为依赖外部签发脚本的参数约定；脚本本身不在本仓库内。
- SSH 主机支持域名与 IPv4，不支持 IPv6。
- 远端依赖 GNU date、openssl、curl、getent 与可用的进程组工具；极简发行版可能缺少。
- 前端界面未提供多用户、登录或远程访问能力。

## 许可证

MIT，详见 [LICENSE](LICENSE)。

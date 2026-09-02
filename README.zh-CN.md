<p align="center">
  <img src="./src/app/icon.svg" alt="Sandpi logo" width="88" height="88">
</p>

<h1 align="center">Sandpi</h1>

<p align="center">
  <strong>把原生 coding-agent TUI 运行在持久化云端 Sandbox 中，通过 Web、桌面或移动设备无缝继续。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://sandpi.ai">打开 Sandpi</a> · <a href="https://sandbox0.ai">Sandbox0</a>
</p>

Sandpi v2 是基于 [Sandbox0](https://github.com/sandbox0-ai/sandbox0) 的开源
coding-agent 客户端。浏览器直接渲染真实 PTY，不把 Agent 转换成自定义聊天协议。
刷新页面或切换设备时，客户端会重新连接同一个 Environment 级进程和终端 journal。

v2 原生支持 Codex、Claude Code 和 Pi。`coding-agent` template 还包含 OpenCode、
Playwright CLI，以及用于诊断和兼容的固定版本 `ttyd`。正式的 Sandpi 终端 authority
仍是 Sandbox0 procd 加 Sandpi 自己的 xterm 客户端；ttyd 不构成第二套会话状态。

## 产品模型

```text
User
└── Environment
    ├── 一个 Sandbox0 Sandbox
    ├── 一个持久化可写 RootFS
    ├── 一个原生 coding-agent TUI
    ├── 一个受监督的 PTY session 和 replay journal
    ├── network policy 与加密的 Agent credential
    └── named snapshot、restore 与 fork
```

Environment 是用户打开、暂停、snapshot、fork 和跨设备切换的单位。v2 没有浏览器
自建的对话副本，也没有产品层多 Session 层级；Agent 自己的历史和项目状态保存在
Environment RootFS 中。

同一时间只有一个浏览器 tab 持有可写 controller lease。其他设备可以实时观看，
并显式接管输入权。Lease 在 PostgreSQL 中进行 fence、heartbeat 和 revoke，避免两个
设备在用户不知情时同时向一个 TUI 输入。

## v2 当前能力

- 不 patch 上游 Agent，直接运行 Codex、Claude Code 和 Pi 的原生终端体验。
- 全页 terminal UI；桌面端支持键盘，移动端提供 Escape、Tab、Ctrl-C、Ctrl-D、方向键、
  粘贴、清屏、文件、snapshot、fork、pause 和 settings 等触控操作。
- 多设备终端 replay，以及单一、可显式接管的输入 controller。
- 每个 Environment 一个持久化 Sandbox0 Sandbox，由 Sandpi 管理 idle pause、手动
  pause/restart、内存配置和 runtime 恢复。
- Named RootFS snapshot、restore、从当前状态 fork，以及从指定 snapshot fork。
  Fork 在 Sandpi 和 Sandbox0 两端都支持幂等和崩溃恢复。
- 每个 Environment 独立的原生 Agent credential：在 PostgreSQL 中加密，仅在 Agent
  运行期间暴露为内存文件；snapshot 和 fork 不继承 credential。
- Environment 级 network policy 与 Sandbox0 egress credential injection。
- Workspace 文件访问、Git-aware 编辑、runtime metrics，以及 template 中与版本匹配的
  Playwright Agent Skill。
- 内置单用户认证或 OIDC，以及可选的 Stripe 产品 quota。

v1 的结构化 Codex app-server 执行接口、Schedules 和 Webhook execution 已在 v2
退役。迁移期仍保留只读和 cleanup API，任何会产生执行的 mutation 都返回 HTTP 410。
未来的自动化必须使用独立 headless adapter，而不能把需要人操作的 TUI 伪装成持久化
job protocol。

## 为什么以 Terminal 作为产品表面

Coding agent 的新能力往往首先出现在其原生 TUI。直接渲染 PTY 可以保留 slash
commands、审批、tool output、鼠标、颜色、布局和 Agent 专属交互，不需要等待一套最低
公共能力协议。

Sandpi 页面采用 terminal 风格，但不要求必须有物理键盘。移动端使用足够大的触控
target，专用键和 Environment action bar 可横向滚动；文件、snapshot、fork、生命周期、
credential 和网络设置仍通过围绕终端的可访问对话框完成。

## Authority 边界

```text
Browser / native shell
    │ HTTPS + WebSocket
    ▼
Sandpi server ───────── PostgreSQL
    │                   ownership、controller lease、fork saga、
    │                   encrypted credential 与 product policy
    │ Sandbox0 SDK
    ▼
Sandbox0 regional API
    ├── Sandbox lifecycle 与 resource lease
    ├── 持久化加密 block-COW RootFS
    ├── snapshot、restore、fork 与 network policy
    └── procd supervised PTY session + replay journal
            └── 官方 coding-agent TUI
```

- 浏览器永远拿不到 Sandbox0 deployment API key，也不直接访问 procd。
- PostgreSQL 保存产品 metadata 和终端 controller lease，但不复制终端输出或 Agent
  conversation history。
- Sandbox0 负责 Sandbox lifecycle truth、可写 RootFS、snapshot/fork、网络 enforcement、
  process supervision 和 usage truth。
- Pause 或 runtime replacement 保存已提交的 RootFS，不保存 process memory、socket 或
  正在运行的 PTY process。procd 会为同一个 logical supervised session 创建新 attempt，
  Sandpi 再连接它。
- `ttyd` 可用于直接诊断，并已验证可渲染三种 Agent TUI；但 ttyd 本身不负责跨 runtime
  replay、controller fencing 或 Sandbox lifecycle，因此不是正式 authority。

参见 [v2 architecture](./docs/architecture/native-agent-terminal-authority.md) 和
[详细设计记录](./sandpi-v2.md)。

## 快速开始

### 环境要求

- Node.js 24 和 npm 11
- PostgreSQL 15 或更新版本
- 一个 Sandbox0 deployment
- 具有 Sandbox 访问权限，以及 `credentialsource:read`、
  `credentialsource:write`、`credentialsource:delete` 的 Sandbox0 API key
- 包含原生 Agent 的最新 Sandbox0 `coding-agent` template
- 容器方式还需要 Docker Engine 和 Compose v2

可选 subscription quota 模式还需要 `usage:read`。

### 本地开发

```bash
cp .env.example .env
chmod 600 .env
printf '\nSANDPI_SECRET_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
```

在 `.env` 中配置 `SANDBOX0_API_HOST` 和 `SANDBOX0_API_KEY`，然后启动：

```bash
docker compose up -d postgres

set -a
source .env
set +a

npm ci
npm run dev
```

当前 workspace 的开发 server 监听 <http://172.16.100.2:3000>，供鸿蒙融合网络访问。
Sandpi 启动时会自动执行 PostgreSQL migration；内置管理员模式会创建一个默认
Environment。

### 容器部署

```bash
cp .env.example .env
chmod 600 .env
# 继续之前编辑 .env。
docker compose up -d --build
docker compose ps
```

应用监听 `3000`；PostgreSQL 只发布到宿主 loopback 的 `55432`。生产 Kubernetes
control-plane 部署参见 [`deploy/kubernetes`](./deploy/kubernetes/README.md)。

## 原生 Credential

每个 Environment 都可以在 Agent 的原生 TUI 中完成正常登录。Sandpi 捕获凭证时会
确认托管路径不是 symlink，把它加密保存到 PostgreSQL，然后把持久化路径替换为指向
Environment 专属 `/dev/shm` 文件的链接。每次启动受监督的 Agent 前，Sandpi 都会把
解密后的凭证写入该内存路径；退出或凭证刷新时再安全地捕获新值。

本地 Codex 凭证也可以不经过浏览器直接导入：

```bash
npm run codex:import-auth -- \
  --environment env-default \
  --file ~/.codex/auth.json
```

## OpenAPI Contract

[OpenAPI 3.0.3 contract](./openapi.yaml) 由真实 HTTP/WebSocket route 生成：

```bash
npm run openapi:generate
npm run openapi:check
```

不要直接编辑 `openapi.yaml`。更多说明见
[OpenAPI contract](./docs/architecture/openapi-contract.md)。

## 当前限制

- Sandbox runtime replacement 可能中断正在执行的 Agent operation；持久化 RootFS 和
  原生历史仍在，但 process memory 不会保留。
- 外部删除整个 Sandbox 时，Sandpi 会报告缺失，不会静默创建一个 policy 可能不同的
  replacement。
- 目前没有托管 Browser 或 Preview surface。Playwright 仍要求 Environment 中另行提供
  兼容 browser executable。
- 内置管理员模式只适合可信单用户部署。公开或多用户部署应使用 OIDC 和 HTTPS。
- `/api/v1` 已版本化，但项目仍处于 pre-1.0。

## 文档

- [Coding-agent Environment guide (`/llms.txt`)](./public/llms.txt)
- [Sandpi v2 设计记录](./sandpi-v2.md)
- [Native agent terminal authority](./docs/architecture/native-agent-terminal-authority.md)
- [Environment egress credentials](./docs/architecture/environment-egress-credentials.md)
- [本地 coding-agent environment 迁移](./docs/local-environment-migration.md)
- [CLI architecture](./docs/architecture/cli.md)
- [Billing 与 usage 边界](./docs/architecture/billing-and-usage.md)
- [Kubernetes 部署](./deploy/kubernetes/README.md)
- [完整配置模板](./.env.example)

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run test:cli
npm run build
npm run test:e2e
```

## License

Sandpi 使用 [Apache-2.0](./LICENSE) 许可证。

<p align="center">
  <img src="./src/app/icon.svg" alt="Sandpi Logo" width="88" height="88">
</p>

<h1 align="center">Sandpi</h1>

<p align="center">
  <strong>让你的 coding agent 运行在持久化云端 Sandbox 中——通过 Web、桌面端或移动端继续同一个 Session。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://sandpi.ai">打开 Sandpi</a> · <a href="https://sandbox0.ai">Sandbox0</a>
</p>

Sandpi 是 [Sandbox0](https://github.com/sandbox0-ai/sandbox0) 的开源 side
project，用于让原生 coding agent 运行在持久化云端 Sandbox 中，并让你通过任意
Sandpi 客户端继续同一个 coding session。

Web 应用与 iOS、iPadOS、Android、OpenHarmony、Windows 和 macOS 第一方原生客户端
共用同一套 Sandpi 产品 UI 和 API。所有客户端都保持轻量：coding-agent harness、
终端、文件和共享 Playwright 浏览器都在云端运行，并挂载持久化 Workspace Volume。
你可以关闭电脑、切换设备或断开客户端，而不会结束 coding session。

目前第一个支持的 coding agent 是 Codex。

![Sandpi 中的 Codex Session 和 Workspace 文件浏览器](./docs/images/sandpi-session-files.png)

<p align="center"><sub>Codex Session 与持久化 Workspace 文件并排显示。</sub></p>

![Sandpi 中的 Codex Session 和共享 Browser](./docs/images/sandpi-session-browser.png)

<p align="center"><sub>Human 与 coding agent 使用同一个云端 Browser。</sub></p>

![Sandpi Environment Settings](./docs/images/sandpi-environment-settings.png)

<p align="center"><sub>Environment 级 runtime、Workspace、agent 和安全设置。</sub></p>

<p align="center"><sub>画面由当前 Web 应用和公开测试数据生成。</sub></p>

## 为什么要在云端 Sandbox 中运行 coding agent？

| 需求 | Sandpi 带来的能力 |
| --- | --- |
| 随时随地继续工作 | 从另一个客户端或设备打开同一个云端 Session。Agent 工作时不需要让 PC 一直开机。 |
| 持久化 Session | 原生 Session 状态和 Workspace 不在浏览器里。页面刷新、客户端断线和 runtime 恢复都不会让 Session 消失。 |
| 更专注的隔离 | 可以按项目、任务或关注点创建独立 Environment。每个 Environment 都有自己的 Sandbox、Workspace、coding-agent 账号、网络策略和凭证。 |
| 多个 coding plan | 不同 Environment 可以连接不同的 Codex/ChatGPT 订阅账号；即使使用同一个账号，也可以把不同工作彼此隔离。 |
| 人与 Agent 共享浏览器 | Human 和 coding agent 使用同一个官方 Playwright browser session，共享 tab 和登录 profile。 |
| 可控的出站访问 | 按目标限制 Sandbox 出站流量，并只向匹配的请求注入受支持的凭证，避免把服务密钥放进仓库或浏览器。 |
| Workspace 防丢失 | 通过 Sandbox0 Volume snapshot 手动或定时备份 Workspace，设置保留数量并按需恢复。 |
| 持久化数据加密 | Sandbox0 在写入对象存储前，对 Environment rootfs checkpoint 对象和默认 S0FS Workspace Volume 对象做应用层加密。 |
| 持久化自动化 | 使用一次性或易读的周期规则定时执行长 Codex prompt，需要时仍可使用高级 Cron。Sandpi 在 Sandbox 外持久化运行意图，并在 server 或 runtime 恢复后对账原生 Turn。 |

Environment 刻意设计得比一个聊天会话更完整：

```text
Environment
├── Sandbox 和持久化 Workspace Volume
├── 一个原生 coding-agent harness 和 provider 账号
├── 网络策略和出站凭证
├── runtime 资源、终端、共享 Browser 和指标
├── 持久化 Automation Schedules
└── 多个原生 coding-agent Session
```

需要隔离、希望每件事更专注，或需要切换 provider 账号时，请创建不同
Environment。如果多个 Session 本来就应该共享文件、工具和执行上下文，则把它们放在
同一个 Environment 中。

## 设计原则

1. **不侵入 coding-agent harness。** Sandpi 的设计目标是不 fork、不 patch、
   不替换官方 harness 实现，而是通过 harness 原生的外部接口完成集成。Codex
   adapter 使用原生 app-server 协议。
2. **保留原生 agent 体验。** Session、model 列表、reasoning 选项、历史记录、
   tools、Skills 和 MCP 配置仍由 harness 负责。Sandpi 不会把所有 coding agent
   压平成能力最小公分母式的聊天协议。
3. **以 Environment 作为隔离边界。** Workspace、provider 身份、网络和凭证作为
   一个整体存在。因此 Environment 既能隔离账号，也能让一件具体工作保持专注。
4. **客户端保持轻量且可以自由切换。** Web 应用与 iOS、iPadOS、Android、
   OpenHarmony、Windows 和 macOS 原生客户端共用同一个 Sandpi server 和产品实现。
   客户端断线不等于要求 coding agent 停止工作。
5. **恢复原生状态，不猜测或重放写操作。** Sandpi 会重新连接持久化的原生 Session
   和 Workspace，而不是维护第二份聊天记录，或在中断后静默重复提交请求。对于
   Sandbox 导致的中断，Sandpi 最多发起一次可见、保守的恢复 Turn，先检查持久化
   状态再决定是否继续；原始请求永远不会被重放。

## 当前已经支持

- 原生 Codex device login 和 Environment 级账号连接
- 原生 model/reasoning 能力发现、Session/Turn 历史和分支
- 支持在工具运行期间向同一个 Codex Turn 追加消息，并保留原生消息顺序
- Sandbox/Codex 进程自恢复，以及有上限的可见 continuation
- 在输入框实时显示原生上下文窗口和 Sandbox CPU/内存使用率
- Codex tools、Skills、MCP 配置、审批和已支持的 slash-command 界面
- 持久化多 Environment、多 Session Web UI；Session 列表保持紧凑并支持渐进分页，
  默认显示所有运行中的 Session，同时提供独立于归档语义、并会在新 Turn 开始时
  自动恢复为未完成的完成状态
- 以预览为主的实时 Workspace 文件浏览器，支持可调整宽度、可折叠的文件树，
  快速源码、Markdown、CSV 视图，图片、音频、视频、PDF、PPTX 预览，按需加载的
  Monaco 编辑器，以及 Git 变更
- Human 与 coding agent 共用的官方 Playwright Browser，支持多 Tab、加载反馈以及
  本地持久化的桌面自适应、响应式和移动端 viewport 模式
- Environment 终端、runtime 指标、可配置 idle pause，以及用于故障恢复的
  Sandbox 手动 pause/restart 控制
- Environment Schedules，支持一次性或易读的周期设置、高级 Cron、IANA
  时区、后续运行预览、持久化运行历史和重叠跳过
- 每个 Environment 独立的网络策略和 Sandbox0 出站凭证注入
- Workspace 手动/定时备份、保留和恢复
- 内置单用户身份模式或 OIDC
- 可选 Stripe 订阅和产品 quota enforcement

Sandpi 仍处于 pre-1.0 阶段，目前只实现了 Codex harness。Web 应用与第一方原生封装
共用一套产品实现；其他 harness 和客户端也可以作为独立集成逐步加入。

## 快速开始

### 环境要求

- Node.js 24 和 npm 11
- PostgreSQL 15 或更高版本
- 一个 Sandbox0 deployment
- 具备 Sandbox、Volume 访问权限以及 `credentialsource:read`、
  `credentialsource:write`、`credentialsource:delete` 权限的 Sandbox0
  deployment API key
- 一个包含官方 Playwright CLI 和 Chromium 的当前 Sandbox0
  `coding-agent` template
- 使用容器流程时需要 Docker Engine 和 Compose v2

可选的订阅 quota 模式还需要 `usage:read`。

### 本地开发

先创建本地配置：

```bash
cp .env.example .env
chmod 600 .env
```

在 `.env` 中设置 `SANDBOX0_API_HOST` 和 `SANDBOX0_API_KEY`，然后生成一份独立
密钥，用于加密 coding-agent 凭证：

```bash
printf '\nSANDPI_SECRET_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
```

启动 PostgreSQL，安装依赖，然后运行 Web 和 API 开发服务器：

```bash
docker compose up -d postgres

set -a
source .env
set +a

npm ci
npm run dev
```

当前工作区中的开发服务器会按约定监听
<http://172.16.100.2:3000>，以便鸿蒙融合网络中的设备访问。在其他主机上请调整开发
脚本，或使用下面的容器流程。

Sandpi 启动时会自动应用尚未执行的 PostgreSQL migration。默认的
`SANDPI_AUTH_MODE=admin` 会创建一个受信任的本地管理员和初始 Environment。

### 容器部署

仓库内的 Compose 文件会运行 PostgreSQL 和同一套 Sandpi server：

```bash
cp .env.example .env
chmod 600 .env
# Edit .env before continuing.
docker compose up -d --build
docker compose ps
```

容器监听 `3000` 端口；PostgreSQL 只发布到宿主机 loopback 的 `55432`
端口。启用 OIDC 前，请把 `SANDPI_PUBLIC_URL` 设置成外部可以访问的 HTTPS origin。

Kubernetes 部署请参阅
[`deploy/kubernetes`](./deploy/kubernetes/README.md)。

## OpenAPI 契约

生成的 [OpenAPI 3.0.3 契约](./openapi.yaml) 覆盖 Sandpi 的 HTTP、SSE、
WebSocket 和内置 Browser 接口。使用以下命令生成并校验：

```bash
npm run openapi:generate
npm run openapi:check
```

不要直接修改 `openapi.yaml`。生成流程复用 server 的真实路由注册，无需启动
PostgreSQL 或 Sandbox0，并会在路由与契约发生漂移时失败。契约的单一来源和特殊
transport 规则请参阅
[`docs/architecture/openapi-contract.md`](./docs/architecture/openapi-contract.md)。

## 连接 Codex

创建或打开一个 Environment，然后在 New Session 页面选择 **Connect Codex**，或者
打开 **Environment Settings → Agent harness**。Sandpi 会启动 Codex 原生
device-login 流程，并对得到的 Environment 级凭证进行加密存储。

本地开发时，也可以直接导入已有登录，而无需让凭证文件经过浏览器：

```bash
npm run codex:import-auth -- \
  --environment env-default \
  --file ~/.codex/auth.json
```

持久化 Workspace 不保存 Codex 明文凭证。Sandpi 启动原生 harness 时，只会把凭证
materialize 到当前 Environment runtime 的内存文件系统中。

## 架构与信任边界

```text
Sandpi clients
（Web 与第一方原生封装）
    │ HTTPS / SSE / WebSocket
    ▼
Sandpi server ───────── PostgreSQL
    │                   用户、ownership 和控制状态
    │ official JavaScript SDK
    ▼
Sandbox0
    ├── Sandbox + 原生 Codex app-server
    ├── 持久化 Workspace Volume
    ├── 官方 Playwright CLI、Dashboard 和共享 profile
    ├── 终端和 runtime 指标
    ├── 网络策略和凭证注入
    └── Workspace snapshot
```

- Sandpi 客户端只与 Sandpi 通信，不会收到 Sandbox0 deployment API key，也不会直接
  访问 Sandbox0 endpoint。对于 Web 应用，Sandpi 会对官方 Playwright Dashboard 的
  HTTP 和 WebSocket 流量进行鉴权与代理。内置 tab 与 agent 共享同一个 Playwright
  profile：human 可以在其中完成交互式登录，然后把同一份已登录 Browser 交还给
  agent 继续操作。Browser 中的 loopback URL 解析到 Environment sandbox 内部。
- Sandpi 只通过官方 JavaScript SDK 使用 Sandbox0，不读取 Sandbox0 数据库、内部
  metering endpoint 或 ClickHouse 凭证。
- Sandbox0 负责 Sandbox 生命周期、Volume、网络执行、凭证注入和 usage truth。
  Sandpi 负责用户、Environment 归属、原生 Session 引用和可选产品 entitlement。
- 使用 Sandbox0 默认存储 runtime 时，Environment rootfs checkpoint 对象和默认 S0FS
  Workspace Volume 对象会在写入对象存储前进行应用层加密。Sandbox0 manager 和 active
  ctld 持有 installation key，因此这是服务端加密而不是端到端加密；self-hosted
  operator 可通过 `spec.storage.runtime.objectEncryptionEnabled` 控制该能力。
- 原生 Codex Session 历史保存在 Environment Workspace 中。PostgreSQL 只保存不透明
  的原生引用和产品控制状态，不维护第二份 conversation transcript。
- 出站凭证注入能够减少 secret 暴露，但 coding agent 仍然可以使用明确授予该
  Environment 的目标和凭证。允许的 tools 与 destinations 本身就是安全边界的一部分。

## 当前限制

- Sandbox runtime 或 Codex 进程重启不会删除持久化 Session 和 Workspace。对于旧
  runtime 中断的 Turn，Sandpi 会恢复 harness，并且最多运行一次可见、先检查状态的
  恢复 Turn；用户明确中断或恢复 Turn 再次失败时立即停止。原始用户请求不会被重放。
- 外部直接删除整个 Sandbox resource 不等同于 runtime 重启。Sandpi 会报告资源缺失，
  不会在可能改变网络策略或凭证边界的情况下静默新建替代 Sandbox。
- 同一个 Environment 中的 Session 共享可变 Workspace 和 harness 账号，它们不是互相
  隔离的 checkout。工作之间不能互相影响时，请创建不同 Environment。
- Browser 依赖当前 Sandbox0 `coding-agent` image。旧 Environment 需要重新创建，
  才能获得 Playwright CLI 和 Chromium 依赖。
- 内置管理员模式只适用于受信任的单用户部署。公开或多用户部署应使用 OIDC，并配置
  正确的网络与 TLS 边界。
- `/api/v1` 已经版本化，但 pre-1.0 版本之间仍可能调整契约。

## 文档

- [Coding agent Environment 指南（`/llms.txt`）](./public/llms.txt)
- [OpenAPI 契约](./docs/architecture/openapi-contract.md)
- [原生 Session authority 与恢复](./docs/architecture/native-session-authority.md)
- [Environment 出站凭证](./docs/architecture/environment-egress-credentials.md)
- [Billing 与 usage 边界](./docs/architecture/billing-and-usage.md)
- [Kubernetes 部署](./deploy/kubernetes/README.md)
- [完整配置模板](./.env.example)

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

## License

Sandpi 使用 [Apache-2.0](./LICENSE) 许可证。

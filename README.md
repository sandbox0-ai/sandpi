<p align="center">
  <img src="./src/app/icon.svg" alt="Sandpi logo" width="88" height="88">
</p>

<h1 align="center">Sandpi</h1>

<p align="center">
  <strong>Native coding-agent TUIs in persistent cloud sandboxes—continue from web, desktop, or mobile.</strong>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://sandpi.ai">Open Sandpi</a> · <a href="https://sandbox0.ai">Sandbox0</a>
</p>

Sandpi v2 is an open-source [Sandbox0](https://github.com/sandbox0-ai/sandbox0)
client for running official coding-agent TUIs in persistent cloud Sandboxes.
The browser renders the real PTY instead of translating an agent into a custom
chat protocol. Refreshing the page or changing devices reconnects to the same
Environment-scoped process and terminal journal.

Codex, Claude Code, and Pi are first-class v2 agents. The `coding-agent`
template also contains OpenCode, Playwright CLI, and a pinned `ttyd` binary for
diagnostics and compatibility. Production Sandpi terminal authority remains
Sandbox0 procd plus Sandpi's xterm client; ttyd is not a second session store.

## Product model

```text
User
└── Environment
    ├── one Sandbox0 Sandbox
    ├── one persistent writable RootFS
    ├── one native coding-agent TUI
    ├── one supervised PTY session and replay journal
    ├── network policy and encrypted agent credential
    └── named snapshots, restore, and fork
```

An Environment is the unit users open, pause, snapshot, fork, and move between
devices. There is no browser-owned conversation transcript and no v2 product
Session hierarchy. The native agent owns its own history and project state in
the Environment RootFS.

One browser tab holds the writable controller lease at a time. Other devices
can watch the live terminal and explicitly take over. The lease is fenced in
PostgreSQL, heartbeated, and revoked on takeover, so two tabs cannot silently
type into the same TUI.

## What v2 supports

- Native Codex, Claude Code, and Pi terminal experiences without patching the
  upstream agents.
- Full-page terminal UI with desktop keyboard input and touch controls for
  Escape, Tab, Ctrl-C, Ctrl-D, arrows, paste, clear, files, snapshots, fork,
  pause, and settings.
- Multi-device terminal replay and a single explicit writable controller.
- One persistent Sandbox0 Sandbox per Environment, with Sandpi-owned idle
  pause, manual pause/restart, memory selection, and runtime recovery.
- Named RootFS snapshots, restore, current-state fork, and fork from a named
  snapshot. Forks are crash-recoverable and idempotent across Sandpi and
  Sandbox0.
- Per-Environment native agent credentials encrypted in PostgreSQL and exposed
  only through a memory-backed file while the agent runs. Credentials are not
  inherited by snapshots or forks.
- Per-Environment network policy and Sandbox0-backed egress credential
  injection.
- Workspace file access, Git-aware editing, runtime metrics, and the
  version-matched Playwright Agent Skill supplied by the template.
- Built-in single-user authentication or OIDC, with optional Stripe-backed
  product quotas.

The v1 structured Codex app-server execution surface, Schedules, and Webhook
execution are retired in v2. Their read/cleanup endpoints remain temporarily
available for migration; execution-producing mutations return HTTP 410. A
future automation feature must use a separate headless adapter rather than
pretending a human-operated TUI is a durable job protocol.

## Why the terminal is the product surface

Coding agents increasingly expose their newest capabilities through their
native TUIs. Rendering the PTY preserves slash commands, approvals, tool output,
mouse support, color, layout, and agent-specific interaction without waiting
for a lowest-common-denominator schema.

Sandpi's page is terminal-styled but does not require a physical keyboard.
Mobile users get large touch targets and horizontally scrollable special-key
and Environment action bars. Files, snapshots, fork, lifecycle, credentials,
and network controls remain ordinary accessible dialogs around the terminal.

## Authority boundaries

```text
Browser / native shell
    │ HTTPS + WebSocket
    ▼
Sandpi server ───────── PostgreSQL
    │                   ownership, controller lease, fork saga,
    │                   encrypted credentials and product policy
    │ Sandbox0 SDK
    ▼
Sandbox0 regional API
    ├── Sandbox lifecycle and resource lease
    ├── persistent encrypted block-COW RootFS
    ├── snapshots, restore, fork, and network policy
    └── procd supervised PTY session + replay journal
            └── official coding-agent TUI
```

- Browsers never receive the Sandbox0 deployment API key or a direct procd
  endpoint.
- PostgreSQL owns product metadata and terminal control leases, but not a copy
  of terminal output or agent conversation history.
- Sandbox0 owns Sandbox lifecycle truth, writable RootFS persistence,
  snapshots/forks, network enforcement, process supervision, and usage truth.
- A pause or runtime replacement preserves committed RootFS state, not process
  memory, sockets, or a live PTY process. procd restarts the logical supervised
  session and Sandpi reconnects to its new attempt.
- `ttyd` is available for direct diagnostics. It can render all three supported
  TUIs, but Sandpi does not use it as durable authority because ttyd alone does
  not own cross-runtime replay, controller fencing, or Sandbox lifecycle.

See [the v2 architecture](./docs/architecture/native-agent-terminal-authority.md)
and the detailed [design record](./sandpi-v2.md).

## Quick start

### Requirements

- Node.js 24 and npm 11
- PostgreSQL 15 or newer
- A Sandbox0 deployment
- A Sandbox0 API key with Sandbox access plus `credentialsource:read`,
  `credentialsource:write`, and `credentialsource:delete`
- A current Sandbox0 `coding-agent` template containing the native agents
- Docker Engine with Compose v2 for the container workflow

Optional subscription quota mode also requires `usage:read`.

### Local development

Create a local configuration and an independent encryption key:

```bash
cp .env.example .env
chmod 600 .env
printf '\nSANDPI_SECRET_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
```

Set `SANDBOX0_API_HOST` and `SANDBOX0_API_KEY`, then start the services:

```bash
docker compose up -d postgres

set -a
source .env
set +a

npm ci
npm run dev
```

In this workspace the development servers listen on
<http://172.16.100.2:3000> so the app is reachable from the HarmonyOS fusion
network. Sandpi applies PostgreSQL migrations at startup; built-in administrator
mode seeds one default Environment.

### Container deployment

```bash
cp .env.example .env
chmod 600 .env
# Edit .env before continuing.
docker compose up -d --build
docker compose ps
```

The application listens on port `3000`; PostgreSQL is published only on host
loopback port `55432`. For the production Kubernetes control-plane deployment,
see [`deploy/kubernetes`](./deploy/kubernetes/README.md).

## Native credentials

Each Environment can complete the agent's normal login flow in its TUI.
Sandpi captures the resulting credential, validates that the managed path is
not a symlink, encrypts it in PostgreSQL, and replaces the persistent path with
a link to an Environment-specific `/dev/shm` file. Before every supervised
agent start, Sandpi writes the decrypted credential into that memory-backed
path. On exit or rotation, a valid refreshed credential is captured again.

For local Codex migration without sending the file through a browser:

```bash
npm run codex:import-auth -- \
  --environment env-default \
  --file ~/.codex/auth.json
```

## OpenAPI contract

The generated [OpenAPI 3.0.3 contract](./openapi.yaml) covers Sandpi's HTTP and
WebSocket surfaces:

```bash
npm run openapi:generate
npm run openapi:check
```

Do not edit `openapi.yaml` directly. Generation uses the server's real route
registrations and fails on route/contract drift. See
[OpenAPI contract](./docs/architecture/openapi-contract.md).

## Current limits

- An in-flight agent operation can be interrupted when the Sandbox runtime is
  replaced; the durable RootFS and native history remain, but process memory
  does not.
- An externally deleted Sandbox is reported as missing instead of silently
  creating a replacement with potentially different policy.
- The application has no managed browser or Preview surface. Playwright still
  requires a compatible browser executable in the Environment.
- Built-in administrator mode is for trusted single-user deployments. Use OIDC
  and HTTPS for public or multi-user deployments.
- `/api/v1` is versioned but remains pre-1.0.

## Documentation

- [Coding-agent Environment guide (`/llms.txt`)](./public/llms.txt)
- [Sandpi v2 design record](./sandpi-v2.md)
- [Native agent terminal authority](./docs/architecture/native-agent-terminal-authority.md)
- [Environment egress credentials](./docs/architecture/environment-egress-credentials.md)
- [Local coding-agent environment migration](./docs/local-environment-migration.md)
- [CLI architecture](./docs/architecture/cli.md)
- [Billing and usage boundaries](./docs/architecture/billing-and-usage.md)
- [Kubernetes deployment](./deploy/kubernetes/README.md)
- [Complete configuration template](./.env.example)

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run test:cli
npm run build
npm run test:e2e
```

## License

Sandpi is licensed under [Apache-2.0](./LICENSE).

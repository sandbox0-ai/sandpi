# Sandpi

Sandpi is an open-source, client/server coding-agent application built on
[Sandbox0](https://github.com/sandbox0-ai/sandbox0). Its Web client follows a
Codex-like interaction model, while the native coding-agent harness runs in a
remote Sandbox0 Sandbox and survives browser disconnects.

The root route is the application itself; Sandpi has no marketing landing page.
Codex is the first supported harness. Claude Code, OpenCode and Pi can be added
later as independent harness integrations.

Sandpi is licensed under Apache-2.0. Sandpi Cloud composes this public server
with hosted identity, quota and commercial services instead of maintaining a
separate product implementation.

## Status

This repository contains the runnable open-source Web application and Sandpi
server. The current implementation includes PostgreSQL persistence,
deployment-level identity configuration, Environment and Session APIs,
Sandbox0 runtime wiring, Codex app-server event transport, native model
discovery, image input, Session and Turn forks, snapshot-backed Turn edit and
delete, a live Web IDE, terminal, signed audit and runtime metrics.

Webhooks, cron jobs, mobile clients, explicit Environment sharing and additional
native harness integrations remain future work. Sandpi's `/api/v1` contract is
versioned, but the project is still pre-1.0 and may evolve it between releases.

## Architecture

```text
Web today; iOS / Android / HarmonyOS later
                    |
             HTTPS / SSE / WebSocket
                    |
        +---------------------------+
        | one Sandpi server         |
        | Fastify API + static Web  |
        +-------------+-------------+
                      |
             +--------+--------+
             |                 |
        PostgreSQL        Sandbox0 SDK
      product state,       deployment API
      cursors, events            |
                                Sandbox
                      native Codex app-server,
                      /workspace Volume, PTY
```

- **One backend:** every client uses the same versioned REST, SSE and WebSocket
  service. Platform-specific clients must not reimplement orchestration rules.
- **Client/server execution:** the browser is only an interaction client. A
  coding agent runs through its native harness in a Sandbox0 Supervisor Session.
- **Recoverable sessions:** Supervisor output is persisted with replay cursors,
  so closing the browser or losing the client network does not terminate the
  coding-agent session.
- **Native harness boundary:** shared code owns Sandbox lifecycle, durable
  transport, files, terminal, audit and metrics. Each harness owns its native
  message/tool rendering, approvals, slash commands and model list. Sandpi does
  not normalize different coding agents into a lowest-common-denominator chat
  protocol. The Codex adapter reads `model/list` from the authenticated native
  app-server and passes the selected model back through `turn/start`; Sandpi
  does not publish or maintain a separate Codex model catalog.
- **Time contract:** public API timestamps use Unix seconds, with fractional
  seconds when the source has millisecond precision. Clients render all times
  through the user's global time-zone preference; its default `auto` value uses
  the current client/browser time zone.
- **Live workspace contract:** the embedded file view and dedicated `/ide/`
  workbench consume the same Sandpi API. Sandpi proxies Sandbox0's recursive
  `/workspace` file stream, parses Git porcelain v2 server-side, and projects
  zero-context staged and working-tree diffs onto current line numbers. The
  browser never receives the deployment API key or a direct Sandbox0 endpoint.
- **Environment grouping:** an Environment fixes the harness, official harness
  authentication, Sandbox template, network policy and workspace baseline.
  Sessions cannot switch harnesses dynamically.
- **Private execution by default:** in the OSS MVP an Environment and its
  Sessions are accessible only to their creator. Team membership supplies the
  tenant and billing boundary, not implicit access to another member's Codex
  credential, workspace or terminal. Explicit Environment sharing requires a
  future ACL and remains disabled.
- **Session isolation:** each Session receives its own Sandbox and a private
  fork of the Environment workspace Volume. Session Sandboxes have a fixed
  30-day hard TTL; the server reaper deletes the associated Volume and clears
  runtime coordinates when that TTL expires.
- **Credential boundary:** provider authentication belongs to an Environment
  and is encrypted in PostgreSQL. A Session materializes plaintext only in
  `/dev/shm`; its persistent Codex home contains a link, so rootfs and workspace
  snapshots cannot copy the credential while native thread/rollout state can
  still survive runtime recovery.
- **Snapshot-backed history:** Session fork copies Sandbox rootfs and the
  Session's private Workspace Volume. Sandpi captures a Workspace Volume
  snapshot before the first Turn and after every completed Turn. Turn fork,
  edit and delete use those checkpoints and never restore or fork rootfs.
- **Native Codex history:** a Turn fork imports Codex's native rollout into a
  fresh `coding-agent` Sandbox, then calls native `thread/fork` at the selected
  Turn. Sandpi transports the native artifact; it does not synthesize a second
  conversation format.

The Sandpi database is authoritative for Team ownership of every Environment,
Session, Sandbox and Volume. The deployment Sandbox0 key does not identify a
Sandpi Team, so every SDK operation must be authorized against Sandpi metadata
first.

### Environment, Session and Turn boundaries

```text
Environment
  coding-agent template + network policy + encrypted Codex Credential Source
  + baseline Workspace Volume
       |
       +-- Session A: Sandbox A + private Workspace Volume A + native thread A
       |
       +-- Session B: Sandbox B + private Workspace Volume B + native thread B
```

Creating a Session forks the Environment baseline Volume and claims a new
Sandbox. Therefore concurrent Sessions never write the same mounted Workspace
Volume. A Session fork pauses its source only for the consistent rootfs and
Workspace copy, then resumes it. A Turn fork leaves the source untouched and
creates a fresh Sandbox from the selected immutable Workspace checkpoint.

Inherited Turns in either child are readable native history. They intentionally
do not become child-owned rollback points: the child's fork baseline is its
first mutable checkpoint. This prevents one Session from deleting or restoring
snapshots owned by another Session.

History mutation is a server-side transaction across Sandbox0 and PostgreSQL:
Sandpi reserves the Session, restores the pre-Turn Workspace checkpoint,
branches the native Codex thread, commits the visible-history revision, and
then removes superseded checkpoints. If finalization fails, it restores the
original Workspace head and native thread. Connected clients receive an SSE
`reset` event whenever that visible-history revision changes.

## Requirements

- Node.js 24 and npm 11
- PostgreSQL 15 or newer
- A Sandbox0 deployment and deployment API key
- A Sandbox0 `coding-agent` template with `/workspace` mounted as the workspace
  Volume for real Session provisioning
- Docker Engine with Compose v2 for the container workflow

Signed Sandbox audit additionally requires the Sandbox0 `sandbox_audit` feature
and `sandboxaudit:read` permission. Sandpi distinguishes unavailable or
unlicensed audit from an available feed with no events.

## Local development

Create the local configuration first. The example listens on `172.16.100.2`,
which makes the app reachable from devices on this workspace's HarmonyOS fusion
network.

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` and replace `SANDBOX0_API_HOST` and `SANDBOX0_API_KEY`. They select
one Sandbox0 deployment for the entire Sandpi installation. Generate the
independent data-encryption key before connecting Codex:

```bash
printf '\nSANDPI_SECRET_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
```

Start only PostgreSQL with Compose:

```bash
docker compose up -d postgres
```

Then load the server variables and start the Web and API development servers:

```bash
set -a
source .env
set +a
npm ci
npm run dev
```

Open <http://172.16.100.2:3000>. The Next.js development server listens on
port 3000 and same-origin proxies API, health, SSE and WebSocket traffic to
Fastify on port 3001. On startup, the API applies pending database migrations
transactionally. Admin mode idempotently seeds the default deployment owner,
Team and Environment; OIDC creates those resources for each user after their
first successful login.

### Connect Codex

Open the Environment menu, choose **Coding agent**, and select **Connect Codex**.
Sandpi starts the official Codex device-login protocol in a short-lived
`coding-agent` Sandbox and displays the native verification URL and user code.
The resulting `auth.json` becomes an encrypted Environment-scoped Credential
Source; every Session records its own Sandbox-scoped materialization binding.

For local development only, an existing native Codex login can be imported
without copying it through the browser:

```bash
npm run codex:import-auth -- \
  --environment env-default \
  --file ~/.codex/auth.json
```

The command reads the native file locally, validates it, encrypts it with
`SANDPI_SECRET_KEY`, and writes a new Environment Credential Source revision.
It does not place the credential in the Environment Workspace Volume.

If PostgreSQL already runs locally, set `DATABASE_URL` to that instance and
skip the Compose command. The database user must be allowed to create and alter
tables in the selected database.

## Container deployment

The included Compose file runs PostgreSQL and the same open-source Sandpi server
used by local development:

```bash
cp .env.example .env
chmod 600 .env
# Edit .env before continuing.
docker compose up -d --build
docker compose ps
```

Compose publishes Sandpi on port 3000 and PostgreSQL only on host loopback port
55432. Set `SANDPI_PUBLIC_URL` to the externally reachable HTTPS origin before
configuring OIDC. In production, terminate TLS at a trusted reverse proxy, keep
PostgreSQL private, use a managed secret store, and replace the example database
password.

Health endpoints:

- `GET /health/live` reports process liveness.
- `GET /health/ready` verifies PostgreSQL connectivity and reports whether the
  Sandbox0 runtime is configured.

The image runs the same bundled `sandpi/server` entrypoint that the package
exports and includes the SQL migrations plus statically exported Web build.

## Identity modes

### Built-in administrator (default)

`SANDPI_AUTH_MODE=admin` is intended for a trusted, self-hosted single-user
deployment. It skips the login flow and seeds one owner:

- user: `admin@sandpi.local`
- Team: `Sandpi`
- Environment: `Development`

The seed is idempotent and does not overwrite later edits. This mode is not a
substitute for authentication on a public or multi-user deployment; protect it
at the network or reverse-proxy boundary.

### OIDC

Set `SANDPI_AUTH_MODE=oidc` for multi-user or private enterprise deployments.
The following server-side settings are required:

```dotenv
SANDPI_AUTH_MODE=oidc
SANDPI_COOKIE_SECRET=replace-with-at-least-32-random-characters
SANDPI_SECRET_KEY=<at-least-32-random-characters>
SANDPI_OIDC_ISSUER=https://identity.example.com/
SANDPI_OIDC_CLIENT_ID=sandpi
SANDPI_OIDC_CLIENT_SECRET=replace-if-the-client-is-confidential
SANDPI_OIDC_SCOPES=openid profile email
```

Register this redirect URI with the provider:

```text
${SANDPI_PUBLIC_URL}/api/v1/auth/callback
```

OIDC identifies a Sandpi user; it never authenticates Sandpi to Sandbox0. A
private deployment may use any conforming OIDC provider. Sandpi Cloud supplies
its hosted identity configuration through the same contract.

## Deployment configuration

Configuration is server-owned. It must not appear in personal Preferences,
Team settings or Environment settings.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | local PostgreSQL on `55432` | Sandpi application database |
| `SANDPI_HOST` | `172.16.100.2` | HTTP bind address |
| `SANDPI_PORT` | `3000` | HTTP port |
| `SANDPI_PUBLIC_URL` | derived from host and port | External origin and OIDC callback base |
| `SANDPI_WEB_DIR` | `./out` | Static exported Web assets |
| `SANDPI_AUTH_MODE` | `admin` | `admin` or `oidc` |
| `SANDPI_COOKIE_SECRET` | none | Signed session cookie secret; required by OIDC |
| `SANDPI_SECRET_KEY` | none | Server-side encryption key; required by OIDC and coding-agent credential storage |
| `SANDPI_OIDC_*` | none | OIDC provider/client configuration |
| `SANDBOX0_API_HOST` | none | Operator-selected Sandbox0 API endpoint |
| `SANDBOX0_API_KEY` | none | Operator-selected Sandbox0 deployment key |
| `SANDPI_LOG_LEVEL` | `info` | Fastify/Pino log level |

Keep `.env` out of version control and readable only by the service account.
Prefer a platform secret mechanism in Kubernetes or another orchestrator. Never
place a Sandbox0 API key in `NEXT_PUBLIC_*`, browser storage, an Environment
record or a Team/user preference.

The server can boot without Sandbox0 configuration for UI and database
inspection, but runtime operations return a clear
`sandbox0_not_configured` error until both Sandbox0 variables are present.
An admin-mode deployment may also boot without `SANDPI_SECRET_KEY`, but it must
set one before connecting an Environment to Codex. Changing the key makes
previously stored Environment credentials unreadable.

The Environment creator is the credential owner. A native coding agent and Web
Terminal execute inside that creator's Session Sandbox, so the creator must be
treated as capable of exporting their own provider credential, just as with a
local native harness. Sandpi does not grant this access to other Team members;
future sharing must introduce an explicit ACL and credential policy first.

### Credential materialization and refresh

Codex receives the official native file at
`/dev/shm/sandpi-codex-auth.json`. Its persistent `CODEX_HOME/auth.json` is a
symlink to that memory-backed file, so neither a rootfs snapshot nor a Workspace
Volume snapshot contains provider tokens. Before a Turn, Sandpi materializes
the current Environment revision. After a completed Turn and after runtime
recovery, it reads native refreshes back, encrypts a new Environment revision,
and advances stale Session bindings. The Session owner still has terminal and
agent execution inside their own Sandbox and must be treated as able to export
their own provider credential, just as with a local Codex installation.

Sandpi never sends this credential to Sandbox0's deployment API as an API key;
the Sandbox0 host and key remain independent deployment-level server secrets.

## Product ownership model

- A Team is the tenant, resource-ownership and billing-attribution boundary.
  Every user belongs to at least one Team.
- Plans attach to individual Team Memberships and are paid by that Team. A Team
  can sponsor different Free, Pro or Max plans for different members; the Team
  itself has no plan.
- Sandpi plans account for Sandpi-managed runtime, storage, networking and
  product services only. Sandpi never includes or resells model usage.
- Provider accounts use the official authentication supported by the native
  harness, allowing users to retain their own coding plan and provider limits.
- Sandbox0 and Sandpi remain separate products with separate identity,
  authorization, quota and commercial boundaries.

## Repository layout

```text
db/migrations/       PostgreSQL schema migrations
src/app/             Next.js Web routes and global styles
src/components/      shared Web application UI
src/harnesses/       harness-owned interaction implementations
src/lib/             shared contracts and browser API client
src/server/          Fastify API, identity, persistence and runtime adapters
```

The backend API is versioned under `/api/v1`. Web, future iOS, Android and
HarmonyOS clients should depend on that service contract rather than database or
Sandbox0 implementation details.

## Runtime guarantees and current limits

- One product Session always owns one Sandbox and one private Workspace Volume.
- Every Environment is provisioned from the fixed Sandbox0 `coding-agent`
  template; neither users nor Sessions can override it.
- A Session has a Sandbox0-enforced 30-day hard TTL. The resource reaper also
  journals and retries cleanup for partially provisioned or failed Sessions.
- Supervisor output is the durable native transport. PostgreSQL stores replay
  identity, cursors and immutable native records; the browser may disconnect at
  any time without stopping Codex.
- The Web terminal is resumable through a Supervisor Session. Web IDE file
  reads are confined to `/workspace`, regular files, and a 5 MiB limit. Its
  source-control view includes staged, unstaged, untracked, renamed, deleted and
  conflicted files; Workspace and Git metadata events refresh it without polling.
- The OSS server currently expects one active server replica. PostgreSQL and
  Supervisor replay make process restart recoverable, but multi-replica worker
  leadership is not yet part of the supported deployment contract.
- Team and membership billing fields model Sandpi Cloud attribution. The OSS
  edition does not charge for or resell model usage and does not enforce a paid
  subscription.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
docker compose config
```

Copyright 2026 Sandpi contributors. Licensed under the Apache License, Version
2.0; see [LICENSE](./LICENSE).

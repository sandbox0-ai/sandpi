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
discovery, image input, native Session/Turn branching, a live Web IDE,
Environment terminal, signed audit and runtime metrics.

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
       product and         deployment API
       control state              |
                            Environment Sandbox
                      native Codex app-server with
                      many Threads, /workspace, PTY
```

- **One backend:** every client uses the same versioned REST, SSE and WebSocket
  service. Platform-specific clients must not reimplement orchestration rules.
- **Client/server execution:** the browser is only an interaction client. A
  coding agent runs through its native harness in a Sandbox0 Supervisor Session.
- **Recoverable sessions:** every harness-native Session and rollout remains in
  the Environment Workspace Volume, so closing the browser or losing the client
  network does not terminate the coding agent. A reconnect reads a native harness snapshot,
  then resumes from a bounded Supervisor/live notification transport; Sandpi
  does not persist a parallel chat transcript.
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
  `/workspace` file stream, discovers zero or more Git working trees beneath
  that mount, parses porcelain v2 per repository, and projects zero-context
  staged and working-tree diffs onto current line numbers. Sandpi never creates
  or chooses a repository for the user or agent. Text
  saves carry the revision that was opened; stale writes return a conflict
  instead of silently replacing a newer file. The internal
  `/workspace/.sandpi` subtree is excluded and rejected by the server, not just
  hidden by the UI. The browser never receives the deployment API key or a
  direct Sandbox0 endpoint.
- **Environment grouping:** an Environment owns one Sandbox, one mounted
  Workspace Volume, one harness process, official harness authentication,
  template and network policy. Product Sessions are lightweight references to
  native harness Sessions inside that runtime and cannot switch harnesses.
  Network-policy edits are applied to that running Environment Sandbox rather
  than deferred to a future product Session.
- **Private execution by default:** in the OSS MVP an Environment and its
  Sessions are accessible only to their creator. Team membership supplies the
  tenant and billing boundary, not implicit access to another member's Codex
  credential, workspace or terminal. Explicit Environment sharing requires a
  future ACL and remains disabled.
- **Credential boundary:** provider authentication belongs to an Environment
  and is encrypted in PostgreSQL. The Environment runtime materializes
  plaintext only in `/dev/shm`; its persistent Codex home contains a link, so
  the Workspace Volume does not contain the credential while native rollouts in
  `/workspace/.sandpi/harnesses/codex` survives runtime recovery.
- **Native branching:** Session fork, Turn fork, edit and delete use Codex
  `thread/fork` (or `thread/start` at the empty-history boundary). They never
  copy or restore the shared Workspace. Edit/delete switch the product Session
  to the candidate native Thread with a PostgreSQL compare-and-swap, while the
  original native rollout remains harness-owned.

The detailed authority, reconnect and mutation invariants are documented in
[Native coding-agent Session authority](docs/architecture/native-session-authority.md).

The Sandpi database is authoritative for Team ownership of every Environment,
native Session reference, Sandbox and Volume. The deployment Sandbox0 key does not identify a
Sandpi Team, so every SDK operation must be authorized against Sandpi metadata
first.

### Environment, Session and Turn boundaries

```text
Environment
  coding-agent template + network policy + encrypted Codex Credential Source
  + Sandbox + mounted Workspace Volume + native harness process
       |
       +-- Session A: native thread A
       |
       +-- Session B: native thread B
```

Creating or forking a product Session does not allocate Sandbox0 resources.
Sandpi asks the Environment's native harness to start or fork a Session and
stores only its opaque id. File APIs, Web IDE, Terminal, audit and metrics are
Environment resources, so switching between Sessions in one Environment does
not switch shells or workspaces. Native agent Turns may therefore observe the
same mutable files; clients must not present a Session as an isolated checkout.
The Web IDE can also be addressed by Environment without an active Session.

For edit/delete Sandpi creates a candidate native branch immediately before the
selected Turn, optionally starts the replacement Turn, then atomically switches
the product Session's opaque native id and history revision. A failed compare
and-swap leaves only an unreferenced native branch; it never rolls back files
belonging to other Sessions. Connected clients receive an SSE invalidation and
reload the harness-native snapshot.

## Requirements

- Node.js 24 and npm 11
- PostgreSQL 15 or newer
- A Sandbox0 deployment and deployment API key
- A Sandbox0 `coding-agent` template; Sandpi mounts each Environment's
  Workspace Volume at `/workspace`
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
Source; the Environment records one Sandbox-scoped materialization binding.

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

The Environment creator is the credential owner. Native coding-agent Sessions
and the Web Terminal execute inside that creator's Environment Sandbox, so the creator must be
treated as capable of exporting their own provider credential, just as with a
local native harness. Sandpi does not grant this access to other Team members;
future sharing must introduce an explicit ACL and credential policy first.

### Credential materialization and refresh

Codex receives the official native file at
`/dev/shm/sandpi-codex-auth.json`. Its persistent `CODEX_HOME/auth.json` is a
symlink from `/workspace/.sandpi/harnesses/codex` to that memory-backed file, so
the Workspace Volume contains no provider tokens. Sandpi materializes the
current Environment credential when starting or recovering the shared harness
runtime and reconciles a native refresh during runtime recovery. The
Environment owner still has terminal and agent execution in that Sandbox and
must be treated as able to export their own provider credential, just as with a
local Codex installation.

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

- One Environment owns one Sandbox, one mounted Workspace Volume, one Terminal
  and one native harness process; all product Sessions in it share them.
- Every Environment is provisioned from the fixed Sandbox0 `coding-agent`
  template; product Sessions allocate only native harness Sessions.
- Supervisor output is the durable native transport. PostgreSQL stores replay
  identity, cursors and scalar recovery coordinates, never a parallel Codex
  transcript; the browser may disconnect at any time without stopping Codex.
- The Web terminal is resumable through a Supervisor Session. Its client stores
  Supervisor sequence bookmarks for the last three submitted commands, so a
  reopened renderer restores only that recent output. Historical bytes are
  parsed with terminal input disabled until a captured journal head is reached,
  preventing old device queries from writing replies into the live PTY. Live
  input is forwarded in order, including xterm binary mouse reports. Every
  writable frame is reauthorized against the Environment
  fence; resize-only frames do not require write access.
  The shell supplies Vim's native `EXINIT` fallback only when no user vimrc is
  present, keeping arrow-key escape sequences usable in `vi` compatible mode
  without overriding an Environment's editor configuration.
  A bounded 4 MiB retained tail protects recovery when an older bookmark
  expires. Web IDE reads and writes are confined to regular UTF-8 files under
  `/workspace` with a 5 MiB limit; `.git`, symbolic links and binary files are
  read-only. Its single file tree includes staged, unstaged, untracked, renamed,
  deleted and conflicted Git state across optional root or nested repositories.
  Workspace events refresh clean files automatically and turn external changes
  to dirty files into an explicit compare/reload/overwrite decision.
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

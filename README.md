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
Environment terminal and runtime metrics.

Webhooks, cron jobs, mobile clients, fine-grained Environment ACLs and additional
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
  network does not terminate the coding agent. A reconnect reads a native
  harness snapshot, then resumes from a bounded Supervisor/live notification
  transport; Sandpi does not persist a parallel chat transcript. For Codex,
  `thread/read(includeTurns: true)` is the conversation authority, while the
  same native Thread's rollout JSONL supplies a sibling Activity read model
  because historical `ThreadItem`s do not retain every tool execution. The
  conversation snapshot is sent first; persisted Activity arrives in a
  separate, revision-scoped SSE event so a slow Volume read cannot leave the
  conversation loading. Environment recovery initializes only the shared
  harness transport and never bulk-reads or attaches product Threads. A
  reconnect reads only its selected persisted Thread; Codex attaches that
  Thread lazily only when the Session starts or interrupts a Turn. Delayed
  best-effort repair considers only non-archived Sessions whose scalar control
  state is exceptionally still running, active or stale-pending. That repair
  uses a metadata-only native read, never loads replies, and gives fresh pending
  Turns a distributed grace. Repair is abortable, retries transient failures
  with capped backoff, and slowly rechecks exceptional active state. Request
  submission is serialized with Environment lifecycle transitions, but response
  waiting is non-blocking and cannot wake an Environment that paused afterward.
  A Session can be archived only once its control projection is idle, so hidden
  Sessions neither receive background reads nor pin Environment idle pause.
  Startup recovery is likewise limited to visible active or pending Session
  control state; ordinary waiting and archived Sessions remain lazy.
- **Native harness boundary:** shared code owns Sandbox lifecycle, durable
  transport, files, terminal and metrics. Each harness owns its native Session
  Activity, message/tool rendering, approvals, slash commands and model list;
  Sandpi does not normalize different coding agents into a
  lowest-common-denominator activity or chat protocol. The Codex adapter reads
  `model/list` from the authenticated Environment-native app-server. Opening
  New Session wakes that runtime and waits for the native catalog instead of
  showing a Sandpi-owned default. The picker preserves each model's native
  reasoning-effort options and sends the selected model and effort through
  `thread/start`/`turn/start`; Sandpi does not publish or maintain a separate
  Codex model or reasoning catalog. Future harness adapters must follow the
  same live capability-discovery rule and preserve unknown native option values
  instead of adding shared Sandpi enums.
  Browser-only UI choices use the versioned
  `sandpi.local-ui-preferences.v1` store rather than the server-synchronized
  account preference contract. Model and reasoning choices are scoped to their
  Environment and Session, then reconciled against the next live native model
  catalog so a coding-agent upgrade cannot revive a removed capability. The
  same local store remembers device-specific sidebar and Inspector
  open/collapsed state, Inspector tab, Terminal height, metric range and
  activity filter controls without storing prompts, attachments or Workspace
  content.
  The Codex New Session and conversation composers also share one
  harness-owned attachment toolbar. `@` discovery uses the harness-neutral
  Environment Workspace search backed by Sandbox0. Matching Codex CLI file
  completion, selecting a result replaces the active composer selection with
  the user-visible Workspace-relative path, which remains part of the submitted
  user text. The bounded runtime scan excludes hidden,
  internal and dependency directories and does not maintain a persistent file
  index or require a running coding-agent app-server.
  Browser uploads are written through Sandbox0 into
  `/workspace/.sandpi/uploads/{id}/` and referenced from there. Valid native
  image formats become `localImage` inputs; other files insert their protected
  Workspace-relative path into the visible composer text. Sandpi never appends
  a hidden attachment instruction or other prompt text. The upload root stays
  hidden from Workspace browsing and Workspace search, and arbitrary paths in
  other Sandpi-managed `.sandpi` state cannot be submitted as local images.
- **Runtime authority:** Sandbox0 is authoritative for the live Sandbox,
  Supervisor attempt and runtime generation. PostgreSQL records only the last
  credential-hydrated Codex epoch for recovery/CAS and keeps independent
  decoder coordinates for Supervisor journal replay. Every native input is
  fenced against Sandbox0's current epoch before it can be accepted. Workspace
  and Terminal use a harness-neutral shared lifecycle admission and do not wait
  for Codex initialization; warm access performs no extra recovery probe, while
  a paused or disconnected runtime is repaired only after the native operation
  reports it, with portal repair serialized under the exclusive lifecycle lock.
  A live Terminal extends only an already-running idle deadline through a
  throttled protocol heartbeat. Codex response timeouts begin after input
  submission, and input delivery itself is bounded; an epoch loss after
  delivery starts is reconciled from native state rather than replaying a
  mutation.
- **Time contract:** public API timestamps use Unix seconds, with fractional
  seconds when the source has millisecond precision. Clients render all times
  through the user's global time-zone preference; its default `auto` value uses
  the current client/browser time zone.
- **Live workspace contract:** the embedded file view and dedicated `/ide/`
  workbench consume the same Sandpi API. The initial snapshot contains only the
  direct children of `/workspace`; clients request one shallow directory page
  when the user expands a folder and cache already loaded pages. User-owned
  dot-files and dot-directories are visible, including Sandpi's internal
  `/workspace/.sandpi` subtree; known generated dependency trees are omitted.
  Sandpi-managed files are readable but remain read-only in the Web IDE and are
  excluded from Git projections. The recursive Sandbox0 stream is used
  only for invalidation. Loaded shallow pages
  are reconciled while that native watch is connecting or unavailable, so files
  created by a running agent do not remain hidden until Turn completion. Sandpi discovers
  zero or more Git working trees beneath the visible tree, parses porcelain v2
  per repository, and projects zero-context staged and working-tree diffs onto
  current line numbers. Sandpi never creates or chooses a repository for the
  user or agent. Text
  saves carry the revision that was opened; stale writes return a conflict
  instead of silently replacing a newer file. The browser never receives the
  deployment API key or a direct Sandbox0 endpoint.
- **Environment grouping:** an Environment owns one Sandbox, one mounted
  Workspace Volume, one harness process, official harness authentication,
  template and network policy. Product Sessions are lightweight references to
  native harness Sessions inside that runtime and cannot switch harnesses.
  Network-policy edits are applied to that running Environment Sandbox rather
  than deferred to a future product Session. The settings surface follows
  Sandbox0's two native fallback modes: `block-all` adds domain allow
  exceptions, while `allow-all` adds domain deny exceptions. Sandpi submits
  those exceptions as native `trafficRules`.
- **Native activity boundary:** the current Session's Inspector exposes
  **Activity** as a harness-native execution record; each harness supplies its
  own renderer instead of a normalized shared event model. Codex attributes
  native tool activity by Thread id and reconstructs durable calls and every
  recorded output from that Thread's bounded rollout JSONL (or its compressed
  sibling); it does not use diagnostic logs SQLite. The Activity feed places
  the newest Turn first while retaining native chronological action order
  within each Turn. An unavailable or partially parseable rollout is reported
  in Activity without blocking the app-server conversation.
- **Durable lifecycle:** every Environment Sandbox has a 30-day Sandbox0 hard
  TTL. Each Environment configures its own idle auto-pause timeout, defaulting
  to thirty minutes; zero disables automatic pause. Environment settings also
  persist the shared Sandbox memory limit in MiB, defaulting to 2 GiB and capped
  at 8 GiB; Sandpi applies it both when claiming and when updating the existing
  Sandbox. Runtime access and native
  `turn/completed` events calculate the PostgreSQL deadline from that setting.
  Any Sandpi replica may scan it, but a per-Environment advisory lock elects
  exactly one replica to pause after it rechecks that no Turn is active or
  pending. Browser disconnection is irrelevant. Sandbox0 auto-resume
  handles the next supported runtime access; Sandpi observes and retries the
  native `waking up` transition but owns no parallel resume state machine. It
  explicitly disables Sandbox0 soft TTL. PostgreSQL derives historical idle
  pause intervals from the current runtime projection, and the Metrics API
  returns overlapping intervals so charts shade intentional pause gaps instead
  of presenting them as missing telemetry.
- **Explicit deletion:** Environment settings require the persisted Environment
  name before permanent deletion. Sandpi serializes deletion with Turn admission,
  stops retained harness and login workers, deletes the Sandbox, Workspace Volume
  and owned rootfs snapshot, then transactionally removes every active or archived
  Session, credential and Environment row. Failed external cleanup retains its
  resource coordinates so the operation can be retried safely.
- **Team-visible by default:** every new Environment belongs to one Team and is
  available to all of that Team's active members by default. A creator may
  instead create a private Environment, which only that creator can list or
  use and which the UI marks with a private icon. Existing Environments are
  migrated as private so an upgrade never silently expands access. Switching
  Teams shows that Team's visible Environments plus the viewer's private
  Environments in that Team.
- **Session attribution and personal pins:** a Session has one immutable
  creator. Session lists show an Owner avatar only when that creator is someone
  other than the current viewer. Team-visible Sessions remain collaborative and
  share their Environment runtime; Owner is attribution, not a separate
  Workspace or an exclusive runtime lock. Pinning is stored per user, so one
  Team member's navigation preference never reorders another member's list.
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

The Sandpi database is authoritative for Team ownership and Environment
visibility, Session ownership, every native Session reference, Sandbox and
Volume. The deployment Sandbox0 key does not identify a Sandpi Team, so every
SDK operation must be authorized against Sandpi metadata first.

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
stores only its opaque id. File APIs, Web IDE, Terminal, signed Environment
Audit and metrics are Environment resources, so switching between Sessions in
one Environment does not switch shells or workspaces. Native agent Turns may
therefore observe the same mutable files; clients must not present a Session as
an isolated checkout. The Web IDE can also be addressed by Environment without
an active Session.

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
Team and Team-visible Environment; OIDC creates those resources on a user's
first successful login. The Team starts on the Free Plan with a Team-wide quota
pool.

### Connect Codex

Open the Environment menu, choose **Coding agent**, and select **Connect Codex**.
Sandpi starts the official Codex device-login protocol in a short-lived
`coding-agent` Sandbox and displays the native verification URL and user code.
The resulting `auth.json` becomes an encrypted Environment-scoped Credential
Source; the Environment records one Sandbox-scoped materialization binding.
The page keeps polling the native login flow and refreshes the Environment as
soon as Codex reports completion.

Once connected, the same page shows the stored non-secret ChatGPT account
metadata and reads current usage windows through Codex
`account/rateLimits/read`. Rate-limit percentages and reset times are live
provider state: Sandpi bounds them before returning them to the browser and
does not persist or mix them with the Sandpi Team plan.

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

### Configure MCP servers

Open **Environment Settings → MCP servers** to add a server for every Codex
Session in that Environment. Quick add is organized into aggregator services,
hosted third-party servers and local STDIO servers. The catalog is maintained
in the application rather than duplicated here. Remote shortcuts use the
provider's hosted HTTPS endpoint by default; use **Custom server** for a
self-hosted endpoint.

Remote authentication follows the method declared by the selected server:

- Public endpoints need no credential. An endpoint with optional
  authentication can be tested anonymously before adding a key.
- API keys and personal access tokens are write-only. Sandpi sends a new value
  directly to a new immutable Sandbox0 Credential Source and stores only
  non-secret binding metadata. Rotation switches the complete egress policy
  before retiring the old source. Sandbox0 injects the managed header only for
  that server's exact HTTPS destination; the value is not written to Codex
  `config.toml`, the Workspace Volume or a Sandpi API response.
- OAuth uses Codex's native MCP login, callback validation and token refresh.
  Sandpi exposes the Environment callback through a constrained Sandbox0 app
  service, correlates each attempt with a dedicated native Thread, and encrypts
  the native token file between runtime generations. Cancellation quarantines
  the old attempt until its listener can no longer alter the shared credential
  slot.

Credential authorization does not grant general network access. In a
`block-all` Environment, explicitly add the remote MCP domain to **Environment
Settings → Network**. The credential rule remains fail-closed and cannot
override a user traffic deny.

Local STDIO entries are different: Codex launches their command inside the
Environment Sandbox. They receive no remote credential injection, run with the
Environment's filesystem and process boundary, and may need an explicit network
exception to download a package or contact an external service. Treat every
local MCP package as trusted code: it runs beside Codex and can access the
Environment workspace. Curated commands pin package versions.

The detailed ownership, callback and persistence boundaries are documented in
[MCP integration authority](docs/architecture/native-session-authority.md#mcp-integration-authority).

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

Coding-agent authentication remains Environment-scoped. A Team-visible
Environment is a trusted collaboration boundary: every active Team member who
can use its agent, Workspace or Terminal must be treated as capable of using or
exporting the materialized provider credential, just as with a shared native
harness host. Use a private Environment when a provider credential, Workspace
or Terminal must remain creator-only. Only the creator or a Team owner/admin can
manage a Team-visible Environment's configuration; only its creator can change
its visibility or manage a private Environment.

### Credential materialization and refresh

Codex receives the official native file at
`/dev/shm/sandpi-codex-auth.json`. Its persistent `CODEX_HOME/auth.json` is a
symlink from `/workspace/.sandpi/harnesses/codex` to that memory-backed file, so
the Workspace Volume contains no provider tokens. Sandpi materializes the
current Environment credential when starting or recovering the shared harness
runtime and reconciles a native refresh during runtime recovery. Every user
authorized to execute in a Team-visible Environment has terminal and agent
execution in that Sandbox and must be treated as able to export its provider
credential. A private Environment restricts that authority to its creator.

If Workspace or Supervisor repair pauses the Sandbox after an early credential
write, Sandpi re-materializes the credential in Sandbox0's final runtime
generation before initializing app-server.

Sandpi never sends this credential to Sandbox0's deployment API as an API key;
the Sandbox0 host and key remain independent deployment-level server secrets.

## Product ownership model

- A Team is the tenant, resource-ownership and billing-attribution boundary.
  Every user belongs to at least one Team.
- A Plan belongs to the Team, never to a user or Membership. Free, Pro and Max
  Teams have different weekly execution, concurrent Session and snapshot
  storage limits. Every active member consumes from the Team's shared quota
  projection.
- Memberships grant Team access and roles only. Team owners and admins may
  change the Team Plan; changing it updates Team limits without moving or
  resetting recorded Team usage.
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
- The Environment Sandbox has a 30-day hard TTL. Its configurable idle pause
  defaults to thirty minutes without a running Turn following the latest
  activity; setting it to zero disables automatic pause. Deadlines and retries
  are PostgreSQL state, not process-local timers.
- Supervisor output is the durable native transport. PostgreSQL stores replay
  identity, cursors and scalar recovery coordinates, never a parallel Codex
  transcript. One cursor-resumable Sandbox0 event stream per Environment
  carries retained replay and live tool/file notifications without idle
  polling; the browser may disconnect at any time without stopping Codex.
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
- Team Plan, quota and billing fields model Sandpi Cloud attribution. The OSS
  edition does not charge for or resell model usage and does not enforce a paid
  subscription. Provider usage remains a separate live, Environment-scoped
  projection.

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

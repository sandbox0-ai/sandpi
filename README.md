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
- **Durable lifecycle:** Environment Sandboxes explicitly disable Sandbox0 soft
  and hard TTLs. Each Environment configures its own idle auto-pause timeout,
  defaulting to thirty minutes; zero leaves no time-based expiration.
  **Environment Settings → Sandbox** also persists the shared Sandbox memory
  limit in MiB, defaulting to 2 GiB and offering 512 MiB, 1 GiB, 2 GiB, 4 GiB
  and 8 GiB presets. Sandpi applies it both when claiming and when updating the
  existing Sandbox. Runtime access and native `turn/completed` events calculate
  the PostgreSQL deadline from that setting.
  The same Sandbox settings surface can create native SandboxVolume Workspace
  backups manually or on an hourly, 6-hour, 12-hour, daily or weekly schedule.
  Scheduled backups are opt-in, retention defaults to seven and can keep 1, 3,
  7, 14 or 30 backups. PostgreSQL stores the durable due/retry state plus an
  ownership journal of Sandpi-created snapshot ids; backup bytes and storage
  metering remain native Sandbox0 state, and retention never deletes snapshots
  created outside Sandpi. A listed backup can be restored only after typing the
  current Environment name. Sandpi rejects backup and restore while a Turn,
  Session provisioning, fork or runtime-recovery operation is active; restore
  pauses the shared Sandbox, invokes Sandbox0's native Volume restore and
  returns it to its previous running or paused state. Because Agent Harness
  state is stored on the Workspace Volume, Sessions created after the selected
  backup are retained as product records but marked unavailable.
  Any Sandpi replica may scan it, but a per-Environment advisory lock elects
  exactly one replica to pause after it rechecks that no Turn is active or
  pending. Browser disconnection is irrelevant. Sandbox0 auto-resume
  handles the next supported runtime access; Sandpi observes and retries the
  native `waking up` transition but owns no parallel resume state machine.
  PostgreSQL derives historical idle
  pause intervals from the current runtime projection, and the Metrics API
  returns overlapping intervals so charts shade intentional pause gaps instead
  of presenting them as missing telemetry.
- **Explicit deletion:** Environment settings require the persisted Environment
  name before permanent deletion. Sandpi serializes deletion with Turn admission,
  stops retained harness and login workers, deletes the Sandbox, Workspace Volume
  and owned rootfs snapshot, then transactionally removes every active or archived
  Session, credential and Environment row. Failed external cleanup retains its
  resource coordinates so the operation can be retried safely.
- **User-owned Environments:** every Environment belongs to exactly one user.
  Only that user can list, use, configure or delete it. OIDC users receive
  independent default Environments on first login; Sandpi has no shared tenant,
  membership, invitation or role model.
- **Session attribution and personal pins:** every Session stays inside its
  creator's Environment and shares that Environment runtime. Pinning is stored
  for the owning user and persists across clients without becoming native
  harness state.
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

The Sandpi database is authoritative for user ownership, every native Session
reference, Sandbox and Volume. The deployment Sandbox0 key does not identify a
Sandpi user, so every SDK operation must be authorized against Sandpi metadata
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
and Environment; OIDC creates an independent default Environment on a user's
first successful login.

### Connect Codex

After creating an Environment, select **Connect Codex** on its New Session page
or open **Agent harness** from Environment settings. Sandpi does not open setup
or an external page until the user chooses that action.
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
does not persist them or mix them with a Sandpi-owned billing model.

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

Codex native configuration is the only source of truth for MCP servers. Add or
remove servers through Codex `config.toml` or the Codex CLI.
Open **Environment Settings → MCP servers** to inspect the effective native
inventory, refresh its runtime status, and enable or disable definitions from
the Environment's user layer. A remote server that reports **Sign-in required**
can start Codex's native OAuth flow from the same list. Project and admin
definitions are visible but read-only, while their native OAuth connection
remains available when required.

Sandpi does not maintain an MCP catalog, copy definitions into PostgreSQL,
store MCP API keys or OAuth tokens, or apply a separate MCP tool policy.
Authentication and tool behavior remain native to Codex and the MCP provider.
For a remote Environment, Sandpi publishes a constrained, rate-limited
Sandbox0 callback route so the browser can return to Codex's listener. The
callback cannot auto-resume a paused Environment and no OAuth flow or token is
projected into Sandpi storage. Environment network settings continue to control
ordinary sandbox egress.

Local STDIO servers run beside Codex with access to the Environment Workspace.
Treat their command and package as trusted code.


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

Configuration is server-owned. It must not appear in personal Preferences or
Environment settings.

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
record or a user preference.

The server can boot without Sandbox0 configuration for UI and database
inspection, but runtime operations return a clear
`sandbox0_not_configured` error until both Sandbox0 variables are present.
An admin-mode deployment may also boot without `SANDPI_SECRET_KEY`, but it must
set one before connecting an Environment to Codex. Changing the key makes
previously stored Environment credentials unreadable.

Coding-agent authentication remains Environment-scoped. Only the Environment
owner can use its agent, Workspace or Terminal and must be treated as capable of
exporting the materialized provider credential, just as with a native harness
host.

### Credential materialization and refresh

Codex receives the official native file at
`/dev/shm/sandpi-codex-auth.json`. Its persistent `CODEX_HOME/auth.json` is a
symlink from `/workspace/.sandpi/harnesses/codex` to that memory-backed file, so
the Workspace Volume contains no provider tokens. Sandpi materializes the
current Environment credential when starting or recovering the shared harness
runtime and reconciles a native refresh during runtime recovery. The
Environment owner has terminal and agent execution in that Sandbox and must be
treated as able to export its provider credential.

If Workspace or Supervisor repair pauses the Sandbox after an early credential
write, Sandpi re-materializes the credential in Sandbox0's final runtime
generation before initializing app-server.

Sandpi never sends this credential to Sandbox0's deployment API as an API key;
the Sandbox0 host and key remain independent deployment-level server secrets.

## User ownership model

- A user is the Sandpi authorization boundary. Every Environment has one owner,
  and every Session belongs to an Environment owned by that same user.
- Sandpi does not model shared tenants, memberships, invitations, roles,
  organization switching or shared Environment visibility.
- Sandpi OSS does not contain a Plan, quota, billing or invoice model.
- Provider accounts use the official authentication supported by the native
  harness, allowing users to retain their own coding plan and provider limits.
- Sandbox0 and Sandpi remain separate products with separate identity and
  authorization boundaries.

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
- The Environment Sandbox explicitly disables Sandbox0 soft and hard TTLs. Its
  configurable idle pause defaults to thirty minutes without a running Turn
  following the latest activity; setting it to zero leaves no time-based
  expiration. Deadlines and retries are PostgreSQL state, not process-local
  timers.
- Workspace backups use Sandbox0's native SandboxVolume snapshot checkpoint.
  Automatic backups are disabled by default to avoid unexpected snapshot
  storage usage; a user can still create one immediately from Environment
  Settings. Creation, retention and restore share the Environment lifecycle
  lock with pause, recovery and deletion. Failed backup operations remain
  durable retries; restore is idempotently retryable against the same native
  snapshot. The Web surface requires the current Environment name before
  destructive restore and the server independently rechecks that no native
  Turn or Session operation is active before pausing the Sandbox.
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
- Sandpi has no local Plan, quota or billing projection. Provider usage remains
  a separate live, Environment-scoped projection.

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

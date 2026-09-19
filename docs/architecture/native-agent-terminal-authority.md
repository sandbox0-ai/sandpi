# Native agent terminal authority

Sandpi v2 treats the coding agent's native terminal as the interactive product
surface. An Environment owns one Sandbox0 Sandbox and one logical supervised
agent PTY. Sandpi renders that PTY in the browser without maintaining a second
conversation model.

## Ownership

```text
PostgreSQL
├── Environment ownership and selected agent
├── terminal controller lease and generation fence
├── Sandbox coordinates and runtime generation
├── encrypted native agent credential
├── snapshot policy and Environment fork saga
└── product network and quota policy

Sandbox0
├── Sandbox lifecycle and resource lease
├── durable writable RootFS and named snapshots
├── fork, restore, network policy, and usage truth
└── procd supervised session
    ├── process attempt
    ├── PTY dimensions and input
    └── bounded replay journal and event cursor

Native coding agent
└── its own history, configuration, approvals, tools, and TUI behavior
```

PostgreSQL does not persist a terminal transcript. procd's session journal is
the replay source for a connected browser, while the agent's files remain the
durable source for agent-native history. A process attempt can be replaced
without changing the Environment or logical supervised session identity.

## Agent registry

The server registry binds each supported agent to:

- its exact command and environment variables;
- persistent state paths below `/workspace`;
- an Environment-specific memory-backed credential projection;
- restart behavior and declared terminal capabilities.

The v2 registry includes Codex, Claude Code, and Pi. Commands start the official
unmodified CLIs. Agent-specific behavior stays in the registry instead of being
spread across route handlers or browser components.

### Codex self-updates

The template supplies a pinned Codex through a symlink to its local npm
installation. Sandpi gives the native Codex TUI an independent global npm
prefix at `/workspace/.sandpi/harnesses/codex/npm`. The built-in update command
installs there, and the launcher prepends its `bin` directory to the inherited
PATH before executing Codex. Before the first update, lookup falls back to the
template binary. Reconnects and resumed runtimes use the installed update;
normal RootFS checkpoint and restore semantics apply to the persisted package.

The launcher resolves the command inside the guest shell because procd resolves
bare executable names before applying session environment variables. It uses
`exec` with positional arguments, preserving flags, exit status, and signals.
Existing live TUIs are not interrupted: the launch command and npm prefix are
reconciled when the old attempt has exited. Shell terminals launched separately
do not inherit this agent-specific prefix.

## Terminal connection

The browser opens
`/api/v1/environments/{environmentId}/agent-terminal` as a WebSocket. Before
proxying terminal traffic, Sandpi:

1. authenticates the user and authorizes the Environment;
2. acquires the Environment runtime-access lock;
3. resumes or repairs a supported paused runtime when required;
4. materializes the encrypted native credential in `/dev/shm`;
5. creates or reuses the Environment-scoped procd supervised session;
6. validates the Sandbox runtime generation, procd session id, and process
   attempt before accepting input; and
7. resumes output from the browser's scoped replay cursor.

The browser stores its replay cursor by Environment, agent, device, and tab.
A cursor from another agent or runtime attempt cannot silently skip output.
When a journal cursor expires or belongs to a replaced journal, the client
rebuilds from the retained tail.

Terminal input is serialized in arrival order. Writable frames are checked
against the controller lease before they are forwarded. A connection may use a
short-lived lease snapshot (bounded well below the lease expiry) so a burst of
keystrokes is not amplified into one PostgreSQL round trip per key; explicit
takeover and lease synchronization revoke that snapshot. Resize-only frames
remain safe for viewers and do not grant input authority.

### Terminal fast path

When the browser sends `protocol=terminal-fast-v1`, Sandpi negotiates a
binary terminal fast path in the `ready` message. The protocol preserves the
native TUI byte stream: Sandpi never decodes ANSI into product semantics,
reorders events, or drops a sequence. Consecutive PTY output events from one
attempt and stream are combined into a compact binary frame, while lifecycle,
control, acknowledgement, and error messages remain JSON. If the negotiated
protocol is unavailable, the browser automatically falls back to the original
JSON event transport.

Binary input uses a connection-scoped random input-id prefix plus a monotonic
sequence. This keeps Supervisor input deduplication idempotent across browser
reconnects without allocating a cryptographic random identifier for every key.
The browser keeps a small ordered input outbox across terminal replay and
brief reconnects, but never predicts remote PTY echo.

The browser renders xterm with the WebGL addon when the browser exposes a
usable context and falls back to xterm's DOM renderer otherwise. Screen-reader
mode is an explicit terminal mode rather than always doubling the terminal's
render work. A page-lifetime replay cache may avoid redownloading a journal
tail when returning to an in-app Environment route; procd's retained journal
remains the authoritative replay source.

## Multi-device controller lease

Many devices may watch one Environment terminal, but only one tab may control
it. PostgreSQL stores a lease containing the Environment, device, tab, lease
token, monotonic generation, expiry, and last heartbeat.

- A fresh tab becomes a viewer when another valid controller exists.
- The controller renews its lease with bounded heartbeats.
- Explicit takeover increments the generation and revokes the previous token.
- Every input frame rechecks the token and generation; a queued frame from the
  old controller is rejected after takeover.
- Disconnect does not kill the agent. Expiry only releases input authority.

This lease is intentionally outside the browser and outside the Sandbox, so it
works across Sandpi replicas and survives client disconnects.

## Runtime replacement

Sandbox0 pause/resume preserves a committed RootFS generation, not process
memory, sockets, or PTY state. procd persists the supervised session's logical
spec and journal and starts a new process attempt after runtime replacement.

Sandpi fences terminal writes with Sandbox runtime generation and procd attempt
identity. It never forwards input to coordinates observed before a lifecycle
transition. The browser reconnects and consumes the new attempt's retained
output. The agent decides how to recover its native history from its own files.

## Native credentials

Agent login files must not become durable RootFS secrets. Sandpi stores one
encrypted native credential per Environment and projects it to an
agent-specific file under `/dev/shm`.

On first login or credential refresh, Sandpi:

1. rejects a managed path that is or traverses an unsafe symbolic link;
2. reads and validates the agent-specific credential shape;
3. encrypts it using the deployment secret and Environment-bound context;
4. publishes the winner under a database concurrency fence; and
5. replaces the persistent location with a link to the memory-backed file.

Before an agent attempt starts, Sandpi writes the current decrypted value to
that memory-backed path with user-only permissions. A snapshot or fork copies
neither PostgreSQL ciphertext ownership nor a plaintext credential. A forked
child starts paused and without inherited Sandbox0 credential bindings.

## Snapshot, restore, and fork

Named snapshots use Sandbox0's RootFS boundary and can be created for a running
Environment. Restore invalidates runtime-local terminal coordinates and any v1
app-server state because process memory is not part of the snapshot.

Environment fork is a PostgreSQL saga joined to Sandbox0's stable operation id:

1. claim a Sandpi idempotency key and reserve the target Environment id;
2. store the source Environment and optional named snapshot id;
3. call Sandbox0 fork with the stable operation id, producing one paused child;
4. when requested, restore the named snapshot into that child;
5. strip inherited credential bindings and reapply only non-secret policy; and
6. publish the child Environment as ready for explicit use.

A lost response resumes the same saga. The periodic reconciler never creates a
second child for the same operation. A deleted source fails an uncommitted saga
instead of guessing another RootFS.

## ttyd boundary

The Sandbox0 `coding-agent` template contains pinned ttyd 1.7.7 binaries for
amd64 and arm64, each verified by SHA-256 during image build. ttyd can launch
and render Codex, Claude Code, Pi, or a diagnostic shell directly in a browser.

Sandpi does not make ttyd its terminal authority. ttyd is a WebSocket terminal
transport, but the product also needs:

- Sandbox0-aware auto-resume and runtime repair;
- procd supervised session identity and retained replay;
- PostgreSQL controller fencing across devices and replicas;
- Environment authorization and quota admission; and
- credential materialization before process start.

Keeping ttyd as a diagnostic compatibility surface proves that the template's
native TUIs are browser-renderable without introducing a second durable session
path.

## Retired v1 execution surfaces

Sandpi v1 modeled Codex Threads and Turns in the product and used app-server for
structured execution, Schedules, and Webhooks. v2 removes those surfaces from
the UI and server workers. Read and cleanup routes remain temporarily available
for migration; execution-producing mutations return HTTP 410 with
`native_tui_structured_operation_unavailable`.

Migration `0070_retire_legacy_app_server` terminalizes any in-flight v1 Session
projection without deleting its native history. The lifecycle reconciler then
writes `stopped` to the legacy procd Supervisor and clears its coordinates only
after Sandbox0 accepts that durable desired state (or proves the Session is
already absent). A failed stop remains retryable, and legacy Session rows no
longer prevent the Environment idle-pause policy from releasing compute.

Future unattended automation must have an explicit headless adapter with its
own durable execution contract. It must not inject keystrokes into the shared
human TUI.

## Native session navigation

The Environment sidebar indexes up to 200 recent readable native sessions for
Codex, Claude Code, and Pi. The index contains opaque IDs, titles, timestamps,
and validated resume paths; it contains no conversation transcript. Native
JSONL remains authoritative. Partial scans are explicitly labeled, including
unsupported compressed-only history. Traversal, bytes read per file, and scan
time are bounded.

Reading the index never accesses the guest. The selected Environment refreshes
its index every 30 seconds while the page is visible; users can explicitly
refresh another Environment. Refresh checks Sandbox0 state and does not request
resume for paused Environments. An Environment with no cached history displays
an explicit empty index until it is refreshed while running.

Opening history or creating a new session requires an explicit **Stop and open**
confirmation. This release retains one active Agent TUI per Environment:
changing sessions stops the current process, including unfinished work, and
preserves saved native history and Workspace files. Selecting another
Environment or disconnecting a browser does not stop its Agent. A process being
alive is not interpreted as an Agent actively generating or executing tools.

The server rechecks native history before stopping the old process, serializes
selection under the Environment lifecycle lock, waits for termination, and
removes the old supervised session. It commits a new launch ID and native resume
reference, clears old terminal coordinates, and revokes old controller leases.
The next terminal connection starts the exact native resume command. Launch-ID
CAS rejects stale devices and late terminal-coordinate publication; retrying
the same selection request is idempotent. The existing terminal protocol resets
replay when the procd session changes. No ANSI parsing or hidden TUI keystrokes
implement session switching.

The highlighted row is the history selected through Sandpi, not an authoritative
view of later native `/new` or `/resume` commands typed inside the TUI. Native
history changes appear on the next refresh. Workspace restore clears the index
and the old resume target; Environment forks build their own index rather than
inheriting a source Environment's runtime binding.

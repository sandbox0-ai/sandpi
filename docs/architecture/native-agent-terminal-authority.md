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

Terminal input is serialized in arrival order. Every writable frame is checked
against the current controller lease immediately before it is forwarded.
Resize-only frames remain safe for viewers and do not grant input authority.

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

Future unattended automation must have an explicit headless adapter with its
own durable execution contract. It must not inject keystrokes into the shared
human TUI.

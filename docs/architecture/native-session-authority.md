# Native coding-agent Session authority

Sandpi treats the coding agent's native Session as the only durable source of
conversation truth. For Codex this is an app-server Thread and its rollout under
the Environment's persistent `CODEX_HOME`. Sandpi never persists, normalizes or
reconstructs a parallel chat transcript in PostgreSQL.

## Resource boundaries

```text
Environment
  Sandbox + /workspace Volume + credential binding
  + one native harness process + Supervisor journal + Terminal
       |
       +-- Sandpi Session A -> native Thread A
       +-- Sandpi Session B -> native Thread B
       +-- Sandpi Session C -> native Thread C
```

- An Environment owns the Sandbox0 resource allocation. Its Sandbox, Workspace
  Volume, Supervisor decoder cursor, Terminal, audit and metrics are shared by
  every product Session in that Environment.
- A Sandpi Session stores product metadata and one opaque harness-native Session
  id. It owns no Sandbox, Volume, Terminal or transcript.
- PostgreSQL stores scalar recovery state: native Session id, selected model,
  history revision, active native Turn id and ambiguous delivery coordinates.
  It never stores message, reasoning, tool-call, delta or JSON-RPC payloads.
- The Supervisor journal is a durable transport, not conversation storage. One
  Environment worker holds a cursor-resumable Sandbox0 event stream, consumes
  retained replay followed by live events, decodes the journal once and routes
  native notifications to the owning product Session by native Thread id. It
  does not poll the event-list API while the Environment is idle.
- A reconnect begins with `thread/read(includeTurns: true)`. The server captures
  a process-local live cursor at the matching JSON-RPC response record, and the
  client applies only the bounded notification suffix after that point.
- A missing native rollout is an invariant failure. Sandpi reports it and never
  substitutes a database transcript or silently starts a replacement Thread.

## Persistent native state and credentials

Codex uses `/workspace/.sandpi/harnesses/codex` as its persistent `CODEX_HOME`.
This keeps all native Threads on the Environment Workspace Volume, so a Sandbox
runtime or harness process restart can resume them without a Sandpi chat store.
The Web IDE, file APIs, Git projection and file watcher reject the reserved
`/workspace/.sandpi` subtree.

Workspace directory transport is deliberately shallow. The initial IDE
snapshot lists only `/workspace`; every folder expansion requests that
folder's direct entries and clients cache the result. Recursive file watching
invalidates loaded pages but never causes the server to eagerly enumerate the
whole Workspace. While a native volume watch is connecting or unavailable, the
client reconciles only the shallow pages it already loaded; this keeps live
agent-created files visible without reverting to eager recursive traversal.

The Environment credential source is encrypted in PostgreSQL and materialized
at `/dev/shm/sandpi-codex-auth.json`. Persistent `CODEX_HOME/auth.json` is only a
symlink to that ephemeral file; the Workspace Volume contains no provider
credential body. The Environment owner and its coding agents have execution in
the same Sandbox and must still be treated as able to inspect their own native
credential, just as with a local harness.

## Start, resume and event routing

Creating a Sandpi Session calls native `thread/start`; it does not claim or fork
a Sandbox0 resource. Subsequent Turns call `turn/start` with that native Thread
id. Codex app-server can own many Threads, so one Environment Supervisor is
sufficient.

When Sandpi starts or recovers an Environment app-server, it initializes that
one transport and calls native `thread/resume` for every referenced Thread.
Each resume response repairs only the Session's active-Turn/status projection;
the returned conversation remains native and is not written to PostgreSQL. A
failure to resume one Thread does not replace it or invent a new conversation,
and does not prevent other Threads in the Environment from reattaching.

The Environment decoder extracts only scalar control transitions from
`turn/started` and `turn/completed` for refresh-safe button/status state. The
unmodified native notifications remain in bounded process memory for SSE and
are discarded after their live window. Every native tool start, output update,
file patch and completion is forwarded immediately; rendering is never delayed
until `turn/completed`. The browser SSE follows the lifetime of its streaming
response rather than the already-finished GET request body. Browser disconnects
therefore have no effect on the native process or rollout.

## Environment lifecycle

Every Environment Sandbox is claimed with a 30-day Sandbox0 hard TTL,
`auto_resume=true`, and soft `ttl=0`. The hard TTL is an absolute destruction
bound; pause preserves the rootfs checkpoint but does not extend that deadline.
Sandpi disables Sandbox0 soft TTL because its native Turn projection owns the
idle-pause decision. The Workspace Volume and native harness home have their
independent durable lifecycle.

Each native `turn/completed` transition stores `last_turn_completed_at` and a
thirty-minute `idle_pause_due_at` in PostgreSQL in the same transaction as the
active-Turn projection. These rows are the distributed timers: every Sandpi
replica may scan due Environments, while a PostgreSQL advisory lock keyed by
Environment elects the replica allowed to call Sandbox0. Under that lock it
rechecks that no product Session is provisioning or running and that no native
Turn is active or pending before calling `pauseAndWait`.

Turn admission takes the same advisory lock and persists pending delivery
before touching the native harness. Therefore either pause completes first and
the following supported runtime access is serialized and auto-resumed by
Sandbox0, or admission completes first and the pause recheck observes work.
Failed pause requests retain a durable retry deadline. Sandpi records the new
runtime generation after auto-resume and grants a fresh thirty-minute idle window
to avoid an immediately repeated pause, but the next native completion remains
the authoritative deadline source. Sandbox0 may return `sandbox is waking up`
while that transition commits; Sandpi waits for the native running generation
and retries the same supported runtime access. No Sandpi worker calls an
explicit resume API. Runtime recovery and pause share the Environment advisory
lock, so their database projections cannot commit out of order.

The lifecycle policy migration stores one absolute hard-expiry target before
updating an older Sandbox. A retry sends only the seconds remaining to that
target, so a crash between the Sandbox0 update and the database commit cannot
silently reset the Sandbox to another full month.

Permanent Environment deletion uses the same advisory-lock namespace as pause
and Turn admission. It first marks the desired runtime state terminated,
stops retained harness and device-login workers, and deletes Sandbox0 resources.
Only after that succeeds does one PostgreSQL transaction remove active and
archived Session references, credentials and Environment metadata. If Sandbox0
cleanup fails, Sandpi keeps the coordinates and records the error for a safe
retry instead of hiding a leaked Sandbox or Workspace Volume.

## Branch and mutation semantics

- Session fork calls native `thread/fork` without a Turn boundary and creates a
  new product Session pointing to the returned native Thread.
- Turn fork calls `thread/fork(lastTurnId)` and creates a new product Session
  pointing to that native child.
- Edit reads the native Thread, branches through the predecessor of the selected
  Turn (or calls `thread/start` at the empty-history boundary), starts the
  replacement Turn on the candidate Thread, then compare-and-swaps the product
  Session to the candidate native id.
- Delete performs the same branch but does not start a replacement Turn.
- The original native Thread is not destroyed. A failed compare-and-swap may
  leave an unreferenced candidate Thread, but cannot corrupt the referenced
  Session.
- None of these operations snapshots, forks or restores `/workspace`. The
  Workspace is intentionally shared and mutable at Environment scope, so
  rolling it back for one Session would corrupt every other Session.
- Sandpi does not use deprecated `thread/rollback`.

The native snapshot exposes fork and mutation capability sets separately even
when a particular Codex version implements both with branching. Each future
harness integration must define its own native rules instead of inheriting a
cross-harness Sandpi abstraction.

## Concurrency consequence

Multiple native Sessions in one Environment can observe and modify the same
files. This is the intended workspace model, not isolation. Sandpi must never
label a product Session as a private checkout or imply that edit/delete rewinds
files. Users or agents may create Git worktrees or repositories when they need
source-level isolation; Sandpi does not choose that policy for them.

## Legacy isolated Sessions

Sessions created by the retired per-Session Sandbox architecture cannot be
silently rebound: their native rollout lived on a different private Workspace
Volume. Migration preserves their opaque native ids for diagnosis, marks them
`legacy_isolated_runtime`, and fails them explicitly. New Sessions immediately
use the Environment runtime. Sandpi does not copy a legacy transcript into the
database to make it appear resumable.

Codex documents `thread/read(includeTurns: true)` as a UI projection that may
omit transient deltas. Sandpi intentionally accepts the harness-visible native
projection instead of creating a second durable conversation store.

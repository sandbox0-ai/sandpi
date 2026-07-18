# Native coding-agent Session authority

Sandpi treats the coding agent's native Session as the only durable source of
conversation truth. For Codex, the app-server Thread returned by
`thread/read(includeTurns: true)` is the conversation authority. The rollout
JSONL for that same native Thread supplies a separate, harness-owned Activity
read model; it is not a second conversation transcript. Sandpi never persists,
normalizes or reconstructs a parallel chat transcript in PostgreSQL.

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
  Volume, Supervisor decoder cursor, Terminal, signed Environment Audit and
  metrics are shared by every product Session in that Environment.
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
  client applies only the bounded notification suffix after that point. The
  conversation snapshot carries an Activity-loading marker and is sent
  immediately; the bounded Volume read completes in a separate SSE `activity`
  event keyed by native Thread id and product history revision. The client
  ignores an Activity result for a superseded snapshot.
- A missing native Thread is an invariant failure. Sandpi reports it and never
  substitutes a database transcript or silently starts a replacement Thread.
  Failure to read or fully parse the sibling rollout Activity is reported
  explicitly as unavailable or partial, but does not invalidate a successfully
  restored conversation.

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

## Environment Audit and native Session Activity

Environment Audit is harness-agnostic, signed Sandbox0 evidence. It belongs to
the Environment because all product Sessions use the same Sandbox; it must not
be presented as if a Sandbox-level event were attributable to one product
Session. The product exposes this feed from the Environment's **Settings →
Audit** section rather than from a Session surface.

The canonical layer preserves every signed event identity, payload hash, phase,
producer and integrity result. It correlates facts only by Sandbox0's exact
`operationId`; it never joins by timestamp. Sandbox0 audit cursors move from the
oldest records toward newer records, so the UI labels the currently loaded time
range and whether it is partial. **Load newer signed records** advances the
opaque cursor on demand. Overlapping pages discard only an exact
`eventId + payloadHash` duplicate, while conflicting payload variants remain
visible as evidence. The UI does not poll this endpoint automatically because
reading Environment Audit is itself an auditable operation.

The compact activity list is a presentation read model, not another audit
store. It can collapse successful allowlisted routine reads into short bursts
and summarize successful external connections by a signed host and port across
the loaded range. Denied, failed, unknown, integrity-affected, mutating and
effect records remain independently visible. The overview reports loaded event
and operation counts, puts issues first, and scopes verification claims to the
loaded records. Expanding an activity reveals canonical operations and
attempt/result/effect evidence; raw signed JSON is mounted only when its
technical disclosure is opened.

Session Activity is instead a harness-native execution record. Each harness
defines and renders its own tool kinds, statuses and payloads rather than
projecting them into a shared Sandpi activity schema. For Codex,
`thread/read(includeTurns: true)` remains authoritative for conversation
messages, but historical `ThreadItem`s are intentionally lossy and can omit
command executions. The Codex adapter therefore builds a sibling Activity read
model from the rollout JSONL named by that same native Thread, pairing native
calls and every recorded output by Turn, call family and call id while
preserving Codex-native types, bounded payloads and timestamps. The reader
accepts Codex's canonical JSONL or exact compressed sibling, requires matching
`session_meta` before any Activity record, and rejects paths outside the managed
Codex home, symbolic links and oversized input. The bounded notification suffix
still supplies live updates. A native `turn/completed` notification starts
another non-blocking rollout read so calls omitted from historical
`ThreadItem`s appear without a browser refresh; Thread id, history revision and
read generation prevent a late result from replacing a newer Session snapshot.

The native `threadId` is the exact product-Session attribution key. The shared
Sandbox0 Supervisor Session and journal identify transport provenance only;
they do not identify which Codex Thread owns an item. Sandpi does not use
Codex's logs SQLite as Activity input: those rows are diagnostic tracing, not a
stable native Session contract. If the rollout is unavailable or only partly
parseable, the Activity surface shows the source error and any safe partial
records while the conversation remains usable. The shared Inspector hosts the
harness-owned renderer; it does not define a cross-harness Activity contract.

The Activity UI projects those native records into a compact, readable action
layer: concrete commands, changed paths, integration targets and explicit
outcomes are primary, while call ids, native types and payloads remain available
as technical evidence. Background waits or terminal updates are attached only
when Codex provides an exact cell or session handle. A richer app-server
command or file-change item replaces a rollout duplicate only when its semantic
signature is unique within the Turn; neither grouping rule relies on timestamp
proximity. The UI reports both logical action count and retained native-record
count so progressive disclosure never hides evidence.

External interactions preserve the same separation. Codex-native MCP, dynamic
tool and web-search activity describes the semantic tool execution in Session
Activity, while Sandbox0 network events remain signed Environment Audit
evidence. The network audit feed has no native Thread correlation key, so
Sandpi displays the two views separately, does not normalize their timestamps
onto a common timeline, and never infers a join from temporal proximity.

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

Codex documents `thread/read(includeTurns: true)` as a lossy UI projection that
may omit transient deltas and historical command executions. Sandpi accepts it
as the native conversation projection and reads the same Thread's rollout only
for the sibling Codex Activity model. It does not create a second durable
conversation store or treat diagnostic logs SQLite as one.

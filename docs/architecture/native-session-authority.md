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

Recovery may speculatively materialize that credential before Workspace health
checks so app-server can start early. If Workspace or Supervisor repair then
pauses the Sandbox, Sandpi materializes it again in the final Sandbox0 runtime
generation before admitting protocol initialization; `/dev/shm` never survives
that native lifecycle transition.

## Runtime authority and cold access

Sandbox0 is the authority for the live Sandbox lifecycle, Supervisor attempt
and runtime generation. Sandpi's `environment_runtime.attempt_id` and
`runtime_generation` are an observation of the last Sandbox0 epoch for which
Sandpi materialized the ephemeral credential. They are recovery and
compare-and-swap coordinates, not a second runtime state machine and not proof
that a process is still live. Protocol initialization is a process-local lease.
The Supervisor decoder persists its replay coordinates separately, so merely
observing an event from a newer attempt cannot promote that attempt to
credential-ready.

Every Codex input first reads the current Supervisor from Sandbox0 and compares
its attempt and generation with the credential-hydrated coordinates. A mismatch
before delivery performs one Environment recovery before retrying the same
logical request id. Once delivery starts, an epoch loss is instead ambiguous:
Sandpi never replays the mutation and an uncertain `turn/start` is reconciled
from the native Thread. Sandbox0's expected-attempt receipt remains the final
fence for a pause that lands between that read and the input write. Input
delivery has its own abortable deadline, while the response deadline is armed
only after submission; Sandbox wake-up, credential materialization and
lifecycle lock waiting are not counted as Codex response time.

Files, the Web IDE, its watcher and Terminal are Environment capabilities rather
than Codex capabilities. They enter a shared PostgreSQL advisory lock keyed by
Environment, which permits concurrent user access while excluding pause,
delete and harness recovery. Their warm path executes the requested native
operation directly with no health probe. Only a native wake-up or disconnected
Workspace portal invokes harness-neutral Sandbox recovery and one retry. A
Workspace portal repair releases shared admission and owns the exclusive
lifecycle lock because rebuilding FUSE can pause the Sandbox.
Successful access records a fresh idle window but never changes the
credential-hydrated Codex epoch. It therefore cannot start a Supervisor or wait
for app-server initialization. A live Terminal uses protocol ping/pong and a
throttled shared-lock heartbeat to extend only an already-running
Environment; it cannot project a paused Sandbox back to running. The UI also
changes its long-running
conversation status after two seconds to explain that an idle checkpoint may
be restoring and that Files and Terminal remain independently available.

## Start, resume and event routing

Creating a Sandpi Session calls native `thread/start`; it does not claim or fork
a Sandbox0 resource. Subsequent Turns call `turn/start` with that native Thread
id. Codex app-server can own many Threads, so one Environment Supervisor is
sufficient.

The browser allocates `clientUserMessageId` before submitting a Turn and may
render that prompt as an ephemeral pending row while HTTP admission and native
events race. Codex echoes the same value on its native `userMessage.clientId`;
that item replaces the pending row in place. The returned or observed native
Turn id is a compatibility fallback when a native version omits the echoed
client id. The pending row exists only in browser memory, is restored to the
composer if submission fails before native acceptance, and is never written to
PostgreSQL or treated as conversation authority. Tool Activity can therefore
remain below its prompt without introducing a second transcript.

When Sandpi starts or recovers an Environment app-server, it restores and
initializes only that shared transport. It does not bulk-read or resume product
Threads. Conversation reconnect reads the selected persisted Thread directly
with `thread/read(includeTurns: true)`, including when an archived Session is
explicitly opened, and repairs only that Session's scalar active-Turn/status
projection.

Environment recovery also schedules a delayed, non-blocking control-state
repair. Its PostgreSQL query includes only non-archived Sessions still projected
as running, active or pending, waits behind interactive Turn operations, and
uses metadata-only `thread/read(includeTurns: false)` rather than
`thread/resume`. It never loads replies or reconstructs rollout history. An idle
or unloaded native Thread can clear abandoned pending delivery only when both
the app-server epoch and Session runtime version still match. Fresh pending
delivery receives a ten-minute distributed grace so another Sandpi replica
cannot clear a Turn that is still being attached or submitted; the exact request
from an ambiguous `turn/start` timeout can be repaired immediately after its
interactive operation releases its lease. Active native Threads preserve the
existing pending and active-Turn projection. Ordinary waiting Sessions and
archived Sessions are never inspected by this repair.

The background read holds the Environment lifecycle advisory lock only while it
rechecks the native epoch and submits `thread/read`; it releases the lock before
waiting for the response. The submission itself has a short abortable deadline,
so pause, delete and server shutdown cannot remain trapped behind a stalled
Sandbox0 write. That response path is lifecycle-neutral, so a pause that wins
after submission is never reversed by Session repair. Transient discovery,
transport and native errors retry with capped backoff; an active exceptional
Thread receives a slow metadata-only recheck so a lost completion event cannot
pin the Environment indefinitely. A new exact timeout target or explicit
unarchive repair wakes any longer pending grace timer.

Archiving is allowed only after the Session's native control projection is idle.
The archive transaction uses the same Environment-runtime, Session-runtime,
Session-metadata lock order as Turn admission. Archived Sessions can therefore
be excluded both from background repair and from the idle-pause guard without
pausing hidden work, and Turn admission rejects an archived Session until it is
unarchived. Unarchive schedules metadata-only control repair, while explicitly
opening an archived Session still reads that one conversation and can repair
sufficiently old pending scalar state.

Operations that require a loaded Thread, currently `turn/start` and
`turn/interrupt`, attach only their target Session with
`thread/resume`. Concurrent callers share one attachment per native Thread and
app-server attempt; a new Supervisor Session, process attempt or Sandbox runtime
generation invalidates that process-local attachment state.
`thread/start` and `thread/fork` already return loaded Threads and mark their
results attached without an extra resume. A failed attachment remains local to
that Session and can be retried; it never delays Environment recovery or
unrelated and archived Sessions.

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
The UI presents the newest Turn group first and keeps Codex's native action
order inside each Turn.

New Session model discovery is also Environment-native. Its request wakes and
initializes that Environment's Codex app-server, waits for `model/list`, and
selects the native default model. Each model's `supportedReasoningEfforts` and
`defaultReasoningEffort` drive the second picker directly. The selected effort
is passed as `model_reasoning_effort` when creating or resuming a Thread and as
`effort` on `turn/start`; the PostgreSQL Session runtime stores only this scalar
control projection for recovery, never a separate model catalog.
Every future coding-agent adapter follows the same capability-discovery rule:
models and model-specific options come from the running native agent, unknown
option values remain forward-compatible strings, and shared Sandpi code must
not introduce a fallback catalog or capability enum.

The two Codex composer surfaces share a harness-owned toolbar so model,
reasoning, upload and `@` behavior cannot drift between New Session and an
existing conversation. Workspace discovery itself is not a Codex capability:
the Environment API delegates a bounded search of the mounted `/workspace` to
the harness-neutral Sandbox0 `RuntimeAdapter`. The scan does not follow symbolic
links, prunes hidden, Sandpi-internal and dependency directories before
matching, and caps candidate output. It neither walks the Workspace from the
browser nor persists a parallel file index. Codex-specific code only converts
the selected generic path into the native `mention` passed to `thread/start` or
`turn/start`; future coding-agent harnesses reuse the same Workspace search
contract and map the result to their own input protocol.

Uploaded composer files use the Sandbox0 File API and live under
`/workspace/.sandpi/uploads/{upload-id}/{safe-name}`. Sandpi validates a
bounded canonical payload before writing it, rejects symbolic-link path
components, and accepts subsequent browser references only from that exact
subtree. PNG, JPEG, GIF and WebP uploads whose bytes match their declared type
become native `localImage` inputs; other uploads remain native `mention`
inputs. Existing Workspace mentions must resolve under the user-visible
`/workspace` policy. The broader `.sandpi` internal tree is never referenceable,
and the upload subtree remains absent from the Workspace IDE and Workspace
search results. PostgreSQL stores neither uploaded bytes nor a file-reference
catalog.

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

## MCP integration authority

Environment MCP settings include a curated shortcut catalog in three groups:
aggregator services, hosted third-party servers and local STDIO servers. Every
non-local shortcut prefills the service provider's hosted HTTPS endpoint;
self-hosted endpoints remain available through Custom server. The catalog
itself is the only maintained preset list. Documentation describes category and
security boundaries rather than copying entries that can drift.

Codex `config.toml` remains authoritative for server URL or command, enablement,
timeouts, scopes and tool policy. Sandpi persists only the non-secret
orchestration metadata needed to reconcile that definition with external
resources: preset and auth mode, endpoint fingerprint, credential source and
binding references, destination match and lifecycle status. It is not a second
MCP definition. Changing the endpoint invalidates the prior consent and prevents
an existing credential from being rebound to a different host without review.

Static remote credentials are write-only. A browser submits a replacement
value to Sandpi once; Sandpi creates a new immutable Sandbox0 `static_headers`
Credential Source without persisting the value in its integration row.
Sandbox0's egress credential binding injects the managed header only for the
exact HTTPS domain, port and path, with fail-closed matching. The credential
does not enter Codex `config.toml`, process environment, Workspace files, logs
or a Sandpi response. Rotation switches the complete network policy to the new
source before retiring the old source, without restarting Codex. Removal first
detaches the binding so no stale header remains.

Credential injection and traffic authorization are orthogonal. Composing an MCP
binding preserves the Environment's user traffic policy and never turns a deny
into an allow. A `block-all` Environment must explicitly allow the remote MCP
domain in **Environment Settings → Network** before Codex can connect. Endpoint
consent only authorizes which destination may receive the credential.

OAuth reuses Codex's native `mcpServer/oauth/login` flow, state and callback
validation, scope handling and refresh behavior. Sandpi publishes only the
Environment's fixed callback port through a constrained Sandbox0 manual app
service. The callback route accepts `GET /callback/`, does not enable
auto-resume and is rate-limited. Sandpi polls its non-secret flow record for UI
status; a successful OAuth completion moves the UI to checking until a fresh
Codex MCP initialize/status result proves readiness.

Every authorization attempt gets a dedicated ephemeral native Thread before
the login request starts. The durable flow stores that Thread id together with
the exact runtime generation and attempt. A completion notification is accepted
only when its name, Thread and runtime tuple all match; Sandpi never falls back
to whichever flow happens to be active. The native event coordinates are
journaled in the same PostgreSQL statement that publishes the terminal flow, so
replayed Supervisor records are idempotent. Thread unsubscription is durable
cleanup performed by startup or ordinary API reconciliation, never by the
event-consumer callback that must remain free to decode its own RPC response.
If the Sandpi process crashes after creating that Thread but before journaling
its id, native login has not yet been submitted: the unused in-memory Thread
cannot alter credentials and is reclaimed with the Environment runtime.

Cancelling authorization leaves a short-lived durable quarantine longer than
Codex's native login timeout. Sandpi revokes any token that wins the
cancellation race and blocks update or deletion of that server definition until
the old listener cannot complete. A late successful notification is discarded
and makes the shared credential slot require authorization again rather than
being attributed to a newer attempt.

Codex's MCP OAuth credential file is materialized in
`/dev/shm/sandpi-codex-mcp-oauth.json`; persistent
`CODEX_HOME/.credentials.json` is only a symlink. Sandpi encrypts that native
JSON as a separate Environment credential slot for recovery and never stores
authorization codes or tokens in the OAuth flow row. Pause or runtime recovery
re-materializes the file before app-server starts. Whole-file synchronization
is serialized across Sandpi replicas by an Environment advisory lock and inside
the Sandbox by Codex's native `mcp-oauth-locks/file-store.lock`; installs use a
protected temporary file and atomic rename, while reads use a locked snapshot.
The global lock order is MCP mutation, Environment lifecycle, then OAuth
credential. Advisory locks use a pool separate from ordinary queries, and
nested locks reuse the outer lock-scoped connection to avoid pool starvation.

Local STDIO servers stay entirely on the native harness side. Codex launches
their configured process inside the Environment Sandbox, not in the browser or
Sandpi server. They use the Environment filesystem and process trust boundary,
receive no remote egress credential binding, and must obtain any package or
external-network access through the Environment's ordinary network policy.
They are trusted code beside Codex, can access the workspace, and curated
shortcuts therefore pin package versions instead of following mutable tags.

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

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
  Volume, Supervisor decoder cursor, Terminal and metrics are shared by every
  product Session in that Environment.
- A Sandpi Session stores product metadata and one opaque harness-native Session
  id. It owns no Sandbox, Volume, Terminal or transcript.
- PostgreSQL stores scalar control and repair state: native Session id, selected
  model, history revision, active native Turn id, delivery runtime epoch and
  explicit interrupt marker. A claimed runtime recovery also stores only its
  source Turn id, prompt version and bounded attempt count. PostgreSQL never
  stores interactive message, reasoning, tool-call, delta, recovery-prompt text
  or JSON-RPC payloads. Environment Automation is the deliberate exception:
  [Schedules](./environment-schedules.md) persist a future user-authored prompt
  and immutable run-delivery snapshot outside conversation history.
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

## Workspace `AGENTS.md`

Codex project instructions remain ordinary Environment Workspace state. The
header shortcut opens `/workspace/AGENTS.md`, creating an empty file through
the normal Workspace API when it is missing. Sandpi does not copy its contents
into PostgreSQL, maintain a second instruction model, inject a hidden Turn
prompt or ask Codex to reload it.

Instruction discovery is fixed for the lifetime of a native Session. Editing,
creating, deleting or renaming an `AGENTS.md` file does not mutate an existing
Thread, so the UI states that changes apply to new Sessions. Sandpi does not
simulate hot reload by adding custom instructions to a later Turn. Sessions
currently start at `/workspace`; product support for nested `AGENTS.md` scopes
therefore requires a future native working-directory selection passed to
`thread/start`, rather than a Sandpi-owned discovery algorithm.

## Persistent native state and credentials

Codex uses `/workspace/.sandpi/harnesses/codex` as its persistent `CODEX_HOME`.
This keeps all native Threads on the Environment Workspace Volume, so a Sandbox
runtime or harness process restart can reopen their persisted history without a
Sandpi chat store. An in-flight Turn itself does not survive an app-server
restart: Codex reports it as interrupted. When Sandpi proves that its delivery
belongs to the replaced runtime epoch, it may submit one visible, versioned
recovery Turn on the same Thread. That Turn tells Codex to inspect persisted
conversation and Workspace state, continue only unfinished work that is safe,
and avoid repeating external side effects; it never replays the original user
request. Explicit user interruption and a second recovery failure always stop
automatic continuation. The Web IDE and file APIs expose the reserved
`/workspace/.sandpi` subtree as readable, Sandpi-managed state while keeping it
read-only and outside the Git projection.

Workspace directory transport is deliberately shallow. The initial IDE
snapshot lists only `/workspace`; every folder expansion requests that
folder's direct entries and clients cache the result. Recursive file watching
invalidates loaded pages but never causes the server to eagerly enumerate the
whole Workspace. While a native volume watch is connecting or unavailable, the
client reconciles only the shallow pages it already loaded; this keeps live
agent-created files visible without reverting to eager recursive traversal.
File-tree context actions create one direct child, rename an entry within its
current parent, or delete a file or folder recursively through the Sandpi API.
The server validates paths and leaf names, rejects protected, hidden, symlinked
or existing destinations, and delegates every mutation to the Sandbox0 SDK.
Deletion requires an explicit client confirmation that calls out recursive
folder removal and open unsaved files. A rename remaps open tabs and preserves
dirty drafts; a deletion closes every affected tab. The client then reconciles
the parent page and opens a newly created file.
Each file open is one bounded Sandbox0 read. UTF-8 content enters the text
editor; signature-verified image, audio, video and PDF containers receive a
read-only browser preview. Sandpi does not infer a preview MIME type from the
filename alone. The 5 MiB bound also applies to media because Sandbox0 does not
currently expose a ranged file read or streaming URL; browser codec support is
therefore the remaining format-specific playback boundary.

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

Credential bindings fence process-local Codex identity as well as file
materialization. Re-authentication creates a new source revision and marks the
existing Sandbox binding stale. A warm app-server cannot pass native admission
while that binding is stale: recovery writes the new ephemeral credential,
replaces the Supervisor attempt, initializes the replacement app-server, and
only then publishes the new binding as active. This prevents stored account
metadata from advancing while usage and Turns still run through the previous
ChatGPT account.

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

New Codex Supervisors use Sandbox0's `always` restart policy, including for a
clean process exit. The Environment worker also consumes Supervisor lifecycle
records: restart-limit exhaustion, or a legacy clean exit with no replacement
attempt/backoff, enters the same exclusive Environment recovery path as a
Sandbox generation change. Intentional attempt replacement, Session deletion
and desired-state stop are excluded. Recovery rehydrates the memory-backed
credential, repairs or recreates the Supervisor, initializes app-server and
invalidates every process-local Thread attachment before Session repair begins.
A Supervisor in terminal `failed` phase is revived by reasserting `running` on
the same Sandbox0 Session, preserving its spec and journal while resetting the
exhausted restart window. Recovery ownership remains held while a newly observed
attempt races initialization, so a `session is not running` response is
reconciled again instead of leaving a terminal event stream idle.

Files, the Web IDE, its watcher, Terminal and Browser are Environment
capabilities rather than Codex capabilities. They enter a shared PostgreSQL
advisory lock keyed by Environment, which permits concurrent user access while
excluding pause, delete and harness recovery. Their warm path executes the
requested native operation directly with no health probe. Only a native wake-up
or disconnected Workspace portal invokes harness-neutral Sandbox recovery and
one retry. A Workspace portal repair releases shared admission and owns the
exclusive lifecycle lock because rebuilding FUSE can pause the Sandbox.
Successful access records a fresh idle window but never changes the
credential-hydrated Codex epoch. It therefore cannot start a Supervisor or wait
for app-server initialization. Live Terminal and Browser WebSockets use
protocol ping/pong and throttled shared-lock heartbeats to extend only an
already-running Environment; neither can project a paused Sandbox back to
running. The UI also changes its long-running
conversation status after two seconds to explain that an idle checkpoint may
be restoring and that Files and Terminal remain independently available.

## Shared Environment browser

The Browser Inspector embeds the official Playwright Dashboard. Playwright
remains authoritative for browser processes, pages, tabs, snapshots,
interaction and profiles; Sandpi does not define an MCP browser tool, CDP
contract, general automation RPC or replacement CLI. Sandpi invokes only the
official `playwright-cli`. Codex Workspace preparation materializes the bundled
Agent Skill once per installed Playwright package version, before app-server
startup. Every newly provisioned Environment includes the protected Dashboard
AppService definition. Its lazy ingress process starts the Dashboard and
starts prewarming the default persistent session as soon as the Dashboard port
is listening, while the client loads Dashboard assets. This avoids making
separate high-latency control API commands on a normal Browser mount and avoids
cold-loading two Playwright CLI processes at exactly the same time. The same
process periodically verifies the local Playwright session and reopens it after
an ordinary browser-process exit without crossing the Sandbox0 control API.
Sandpi otherwise invokes the CLI directly only for explicit session recovery,
viewport changes and selected loopback URLs. The coding agent can use that same
command directly.

The default Playwright session is shared at Environment scope. The coding-agent
template sets `HOME=/workspace`, so Playwright's official daemon registry and
persistent profile live on the Environment Workspace Volume. Human Dashboard
interaction and agent CLI commands therefore observe the same tabs, cookies
and authenticated sites. Sandpi stores no browser history, cookies, storage
state or page model in PostgreSQL. Workspace backups do include the persistent
browser profile, so access to those snapshots must be treated as access to the
Environment's logged-in browser credentials.

Sandpi adapts only the embedded Dashboard shell: it binds the Dashboard to the
shared `default` session explicitly, projects the current Sandpi theme tokens
into the frame, and exposes the upstream tabs as a compact horizontal tab
strip. Tab selection, creation and closing still invoke Dashboard-owned
controls; Sandpi projects but does not persist an independent page or tab
model. Navigation and tab activity produce a non-blocking loading indicator
until the next live frame.

The embedded shell measures the Dashboard's live screen bounds and sends
bounded, debounced updates through Sandpi's authenticated API. Sandpi
deduplicates an already-applied viewport within one Sandbox runtime generation
and coalesces intermediate updates while one CLI resize is running. The default
`Desktop fit` mode preserves that aspect ratio while targeting a minimum 1280
CSS-pixel width within bounded viewport limits.
This keeps desktop sites out of mobile breakpoints while still filling the
available screen without stretching or cropping. `Responsive` uses the
Inspector screen at 1:1 CSS pixels, while `Mobile` uses a fixed 390 by 844
viewport. The selected mode is a browser-local UI preference. Sandpi applies
all three modes through the official `playwright-cli resize` command.

Sandpi starts `playwright-cli show` without pinning a session so Dashboard
readiness does not wait for Chromium startup. Every newly embedded connection
selects the first tab in `default` after Playwright publishes it, then reveals
the official Dashboard as soon as that shared session and first tab exist.
Viewport reconciliation continues in the background instead of imposing a
fixed wait for a resized screencast frame. A bounded compatibility fallback
reveals the native Dashboard if Sandpi cannot recognize a future session
markup. Users never need to operate the session picker in the supported shape.

The adapter is injected by Sandpi's authenticated HTML proxy; it does not edit
the coding-agent template or the installed Playwright package. Hiding the
native sidebar is capability-gated. If a future Dashboard no longer exposes
the expected accessible tab controls, Sandpi leaves the official sidebar
visible and stops presenting the compact tab strip, so the upstream UI remains
usable after an image upgrade. Playwright continues to own the browser toolbar,
pages, profiles and interaction behavior.

An Environment resume can terminate Chromium while leaving its persistent
profile's `Singleton*` symlinks on the Workspace Volume. If Playwright reports
that `default` is stopped and then reports its validated default profile is
still in use, Sandpi checks that `SingletonLock` names another Sandbox host or
a dead local PID, removes only the three ephemeral singleton symlinks, and
retries the official CLI once. It never deletes profile data. Sandpi reuses an
identical published AppService rather than rewriting it on each mount or server
restart. A forced user retry increments the persisted service revision so the
embedded client reconnects cleanly. An HTTP authorization rejection refreshes
only the cached coordinates; ordinary WebSocket failures retain
generation-fenced coordinates, while browser startup is discovered dynamically
by Playwright's Dashboard. None of these paths restarts a healthy AppService.
Missing CLI or Chromium dependencies remain a template compatibility error;
other failed starts are reported as runtime recovery failures instead of
telling the user to recreate the Environment unconditionally.

An authenticated chat link using HTTP or HTTPS on `localhost`, `127.0.0.1` or
`::1` opens in a new tab in that remote browser, where loopback resolves inside
the Sandbox rather than on the user's device. Scheme-less Markdown link targets
for those exact hosts are normalized to HTTP. The Dashboard address bar remains
an official Playwright surface and can navigate elsewhere subject to the
Environment's network policy.

Sandbox0 currently exposes the Dashboard through an app-service ingress rather
than a private port-tunnel API. That public DNS name is transport, not the user
authorization boundary: Sandpi derives a per-Environment HMAC request token,
Sandbox0 stores only its SHA-256 verifier, and the upstream URL and request
token remain server-only. The token is scoped to the Sandpi Environment rather
than exposed or persisted in the browser. After Sandpi authenticates the user
and authorizes Environment ownership, the protected ingress may perform
Sandbox0-native auto-resume. This avoids a separate control API wake-up command
without exposing the ingress credential to the browser.
Every Dashboard asset and WebSocket upgrade first crosses Sandpi login,
ownership and lifecycle admission, then Sandpi forwards it with the protected
header. The client receives only the authenticated Sandpi proxy path. Static
paths and Dashboard socket identifiers are allowlisted. Rewritten HTML remains
uncached, while static assets use bounded private browser caching. The
WebSocket relay preserves all control traffic but retains only the latest
unsent screencast frame when a downstream is slower than Playwright, preventing
stale frames from accumulating. A live downstream WebSocket heartbeat keeps the
already-running Environment active.

## Start, resume and event routing

Creating a Sandpi Session calls native `thread/start`; it does not claim or fork
a Sandbox0 resource. Subsequent Turns call `turn/start` with that native Thread
id. Codex app-server can own many Threads, so one Environment Supervisor is
sufficient.

`thread/start` and `thread/fork` carry a deterministic, Session-scoped
`threadSource`. Codex persists that source before answering. If the response is
lost, Sandpi searches the native Thread store for the exact source and binds the
single result instead of replaying creation. Zero matches fail closed; multiple
matches are an integrity error. The original interactive prompt is still not
stored in PostgreSQL. Scheduled input follows the separate durable-delivery
contract described in
[Environment Schedules](./environment-schedules.md).

The browser allocates `clientUserMessageId` before submitting a Turn and may
render that prompt as an ephemeral pending row while HTTP admission and native
events race. Codex echoes the same value on its native `userMessage.clientId`;
that item replaces the pending row in place. The returned or observed native
Turn id is a compatibility fallback when a native version omits the echoed
client id. The pending row exists only in browser memory, is restored to the
composer if submission fails before native acceptance, and is never written to
PostgreSQL or treated as conversation authority. Tool Activity can therefore
remain below its prompt without introducing a second transcript.

The conversation keeps Codex commentary and tool items in native order inside
Turn-level work disclosures. A running item owns the disclosure that already
contains that item, even when a later steering message is present; Sandpi does
not add a second empty Running disclosure. If an active Turn has no visible
item yet, the UI renders a non-interactive status row. Compact tool rows become
expandable only when they have meaningful output or payload data, show live
details directly, and collapse when the tool or Turn completes.

When Sandpi starts or recovers an Environment app-server, it restores and
initializes only that shared transport. It does not bulk-read or resume product
Threads. Conversation reconnect reads the selected persisted Thread directly
with `thread/read(includeTurns: true)`, including when an archived Session is
explicitly opened, and repairs only that Session's scalar active-Turn/status
projection.

Environment recovery also schedules a delayed, non-blocking control-state
repair. Its PostgreSQL query includes only non-archived Sessions still projected
as running, active or pending, waits behind interactive Turn operations, and
reads each candidate with `thread/read(includeTurns: true)`. Full Turns are
required only on this exceptional path to distinguish a completed Turn, an
explicit user interrupt and an interruption caused by replacement of the
Sandbox runtime epoch. It does not reconstruct rollout history. An idle or
unloaded native Thread can clear abandoned pending delivery only when both the
app-server epoch and Session runtime version still match. Fresh pending delivery
receives a ten-minute distributed grace so another Sandpi replica cannot clear a
Turn that is still being attached or submitted; the exact request from an
ambiguous `turn/start` timeout can be repaired immediately after its interactive
operation releases its lease. Active native Threads preserve the existing
pending and active-Turn projection. Ordinary waiting Sessions and archived
Sessions are never inspected by this repair.

If the authoritative native Turn is `interrupted`, Sandpi compares its persisted
delivery attempt and Sandbox generation with the current Environment epoch. A
current-epoch interruption, an explicit user interrupt, or an interruption with
no provably replaced delivery epoch clears local control state and returns the
Session to `waiting`.

Only an old-epoch interruption can atomically claim one automatic recovery.
The claim is durable across a Sandpi restart and starts a new, visible
`turn/start` on the same native Thread with a versioned Sandpi recovery client
message id. The recovery prompt asks Codex to inspect native history,
Workspace/Git state and any observable external result before deciding what
remains. It explicitly forbids blindly repeating the original request or
external side effects. Sandpi does not possess or replay that original prompt.
If recovery delivery is ambiguous in the current epoch, native state is
reconciled without resubmission. It can be delivered again only after its own
recorded runtime epoch has been replaced and the native Thread proves the
recovery Turn absent. An interrupted recovery records exhaustion and never
chains another recovery Turn.

The background read holds the Environment lifecycle advisory lock only while it
rechecks the native epoch and submits `thread/read`; it releases the lock before
waiting for the response. The submission itself has a short abortable deadline,
so pause, delete and server shutdown cannot remain trapped behind a stalled
Sandbox0 write. That response path is lifecycle-neutral, so a pause that wins
after submission is never reversed by Session repair. Transient discovery,
transport and native errors retry with capped backoff; an active exceptional
Thread receives a slow full-state recheck so a lost completion event cannot pin
the Environment indefinitely. A new exact timeout target or explicit unarchive
repair wakes any longer pending grace timer.

Archiving is allowed only after the Session's native control projection is idle.
The archive transaction uses the same Environment-runtime, Session-runtime,
Session-metadata lock order as Turn admission. Archived Sessions can therefore
be excluded both from background repair and from the idle-pause guard without
pausing hidden work, and Turn admission rejects an archived Session until it is
unarchived. Unarchive schedules exceptional control repair, while explicitly
opening an archived Session still reads that one conversation and can repair
sufficiently old pending scalar state.

Operations that require a loaded Thread, including user `turn/start`,
`turn/interrupt` and thread-scoped native command RPCs, attach only their target
Session with `thread/resume`. Concurrent callers share one attachment per
native Thread and app-server attempt; a new Supervisor Session, process attempt
or Sandbox runtime generation invalidates that process-local attachment state.
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

## Native Session Activity

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

The same non-blocking rollout pass restores the latest persisted
`token_count.info` for the Thread, while `thread/tokenUsage/updated` supplies
new values during an active Turn. The existing Session composer displays the
baseline-adjusted percentage of the user-controllable context window, matching
Codex's native calculation from `last.totalTokens` and `modelContextWindow`.
Sandpi does not estimate message text or persist a second usage counter.

New Session model discovery is also Environment-native. Its request wakes and
initializes that Environment's Codex app-server, waits for `model/list`, and
selects the native default model. Each model's `supportedReasoningEfforts` and
`defaultReasoningEffort` drive the second picker directly. The selected effort
is passed as `model_reasoning_effort` when creating or resuming a Thread and as
`effort` on `turn/start`; the PostgreSQL Session runtime stores only this scalar
control projection for recovery, never a separate model catalog. The UI
projection stably keeps the first native entry for each model id, so repeated
pages or duplicate native records cannot create duplicate picker options. It
does not deduplicate by a Sandpi-maintained display-name list.
Every future coding-agent adapter follows the same capability-discovery rule:
models and model-specific options come from the running native agent, unknown
option values remain forward-compatible strings, and shared Sandpi code must
not introduce a fallback catalog or capability enum.

Model and reasoning pickers may remember an opaque browser-local choice, but
that preference is not native capability state and is not written to the
server-synchronized `SandpiPreferences` record. Sandpi scopes New Session
choices to an Environment and unsubmitted conversation choices to a product
Session under `sandpi.local-ui-preferences.v1`. A stored model or effort is
applied only after the running harness returns its current catalog; unavailable
values fall back to the live native model defaults. Selecting a control updates
only browser UI state until `thread/start` or `turn/start` submits it. The same
versioned browser-only record contains device layout choices, including the
sidebar and Inspector open/collapsed state, the resizable Inspector width
ratio, as well as filter choices. The conversation and Inspector consume the
remaining desktop width proportionally, so collapsing the sidebar or resizing
the window preserves the user's split. It never contains prompts, attachments,
credentials, native history or Workspace content.

The two Codex composer surfaces share a harness-owned toolbar so model,
reasoning, upload and `@` behavior cannot drift between New Session and an
existing conversation. Workspace discovery itself is not a Codex capability:
the Environment API delegates a bounded search of the mounted `/workspace` to
the harness-neutral Sandbox0 `RuntimeAdapter`. The scan does not follow symbolic
links, prunes hidden, Sandpi-internal and dependency directories before
matching, and caps candidate output. It neither walks the Workspace from the
browser nor persists a parallel file index. Codex-specific code reproduces the
Codex CLI completion boundary: Sandpi's `@` affordance opens search, and choosing
a result inserts a visible Workspace-relative path at the active composer
selection, matching the path the CLI leaves after replacing its temporary
`@token`. `thread/start` and `turn/start` receive that visible path as part of
the native text input, not a filesystem-shaped app/plugin `mention`. Future
coding-agent harnesses reuse the same Workspace search contract and own their
corresponding visible composer and native input mapping.

The shared toolbar also mounts an Environment-owned, read-only resource status.
It polls a compact current-metrics endpoint at Sandbox0's 15-second collection
cadence and displays the latest CPU and memory utilization beside native context
usage. The endpoint requests only the latest CPU, memory working-set and memory
limit gauges; it does not load network series, historical pause intervals or
billing usage, and the client silently omits unavailable metrics.

Their page headers also share the Environment-owned Terminal and Inspector
operations. New Session can inspect Files and Metrics without creating a native
Thread; the Activity tab is added only when a selected Session supplies its
harness-owned renderer. Environment settings remain a sidebar management
action and do not replace these Workspace operations.

## Codex slash command boundary

Slash completion is part of the Codex harness adapter, not the shared
conversation dispatcher. The New Session and active Session composers use one
Codex registry and parser, support pointer plus Up/Down/Tab/Enter/Escape
interaction, and reject unknown commands locally instead of sending them to the
model as user text. Each registry entry also names a stable browser intent.
Dispatch switches on that intent rather than command text. The Codex TUI is the
behavioral reference for command meaning, while app-server remains the data and
mutation authority; redundant aliases and terminal-only presentation commands
are not copied into the browser.

The model-visible input boundary is strict. Sandpi submits only text the user
can see in a composer, validated native image inputs, or the verbatim Codex TUI
`/init` prompt after the user explicitly invokes that command. It never supplies
Sandpi-authored `baseInstructions` or `developerInstructions`, calls
`thread/inject_items`, or replays a user mutation after runtime repair. The only
Sandpi-authored model input is the visible, versioned, single-attempt recovery
Turn described above. Custom review instructions remain user input and go only
through Codex's native `review/start` contract.

Commands preserve Sandpi product ownership where a browser-native surface
already exists:

- `/new [name]` and `/clear [name]` navigate to the Environment's New Session
  composer, preserve the optional name until creation, and pass Codex the
  matching `startup` or `clear` native Session start source. They remain
  unavailable during an active Turn, matching Codex TUI command availability.
- `/fork` calls native `thread/fork`, creates a child product Session and
  selects it.
- `/rename [name]` updates only the product Session title; native Thread
  metadata remains harness-owned. Bare `/rename` opens the same product
  operation in a dialog. `/archive`
  updates product Session metadata.
- `/mention`, `/diff`, `/skills`, `/mcp [verbose]` and `/permissions` open the
  corresponding composer, Inspector or Environment settings surface. MCP
  verbose requests full native status and renders server tools, resources and
  resource templates.
- `/ide` opens the Workspace Inspector. `/agent` opens the dedicated native
  Agent Threads picker described below. `/logout` opens the Codex account
  connection so the user retains the existing confirmation and reconnect flow.
- `/copy` copies the latest assistant message.
- `/compact` calls `thread/compact/start`; `/review` calls inline
  `review/start` with either the native `uncommittedChanges` target or a custom
  target. Their ordinary native Turn/item notifications remain authoritative.
  Inline review can also expose Codex's private one-shot reviewer Turn beside
  the completed review wrapper in `thread/read`. Sandpi derives that exact
  adjacent relationship from the native review markers and matching output:
  the wrapper remains the Session control Turn and owns the visible result,
  while the private delegate is omitted from conversation and interruption
  state. The raw native snapshot is not rewritten or persisted separately.
- `/goal` reads, creates and edits native `thread/goal/*` state; `pause`,
  `resume` and `clear` map to native status updates or goal removal.
- `/personality` offers the same Friendly and Pragmatic choices as Codex TUI,
  reads the live model capability, writes native config, rereads the effective
  layered value, and applies that value with
  `thread/settings/update` on a loaded Thread. `/usage
  daily|weekly|cumulative` projects `account/usage/read` token activity and is
  deliberately separate from Sandpi/Sandbox0 billing usage.
- `/memories` writes `features.memories` and native memory policy. Its feature
  switch enables or disables both memory use and generation together; after
  enabling, either policy can still be adjusted independently. Sandpi rereads
  the effective layered values, updates the selected Thread's
  `thread/memoryMode/set` eligibility, and exposes
  `memory/reset`. `/hooks` reads `hooks/list` and only upserts user-controlled
  enablement or the reviewed current hash under `hooks.state`.
- `/ps` lists `thread/backgroundTerminals/list`; `/stop` cleans every native
  background terminal, while the process dialog can terminate one process.
- Fast is a
  first-class composer switch that sends the service-tier id returned by the
  selected model's live `model/list` entry and is absent when Codex reports no
  Fast tier for that model.
- `/plan` sends the selected live model and effort through Codex's native Plan
  collaboration-mode settings. `/init` submits the same visible user prompt
  vendored from Codex TUI's `prompt_for_init_command.md`; Sandpi does not add
  hidden instructions around it.

### Native Agent Threads

Session Activity is a parent-Thread execution and audit feed; it is not the
Codex Agent picker. Sandpi initializes app-server with
`capabilities.experimentalApi`, then `/agent` uses
`thread/list(ancestorThreadId)` to page the persisted spawn tree at any depth.
The Agent picker contains the main Agent thread and its spawned subagent
threads. This preserves completed descendants across Sandpi, app-server and
Sandbox restarts. Selecting a row calls `thread/read(includeTurns: true)` and
projects that native child transcript with the same Codex message, tool and
Turn renderers used by the main conversation. A child that has not materialized
history yet falls back to metadata-only display.

The server re-reads the ancestor tree before accepting a child Thread id, so a
caller cannot use the endpoint to inspect an unrelated Thread in the same
Environment. Child metadata and transcripts are never copied into PostgreSQL
or converted into product Sessions. The browser records the open picker as
`agents=1` and a selected child as `agent={threadId}` so refresh restores the
same GUI state. Closing the picker removes both parameters.

Codex app-server does not expose the TUI slash catalog as a runtime capability.
Sandpi therefore keeps an explicit, reviewed command registry instead of
pretending to discover it dynamically. Future command maintenance should
compare the pinned Codex TUI source with that registry, map browser-relevant
commands to an existing or new intent, and deliberately exclude TUI-only
commands. Native protocol types should continue moving toward output generated
from the Sandbox0-pinned Codex version (`@openai/codex` 0.144.1 at the time of
this document) rather than adding parallel Sandpi protocol models. Browser API
projections may normalize validated native values, but must not invent harness
behavior.

`/resume` is intentionally absent because Sandpi's sidebar and URL own product
Session selection. `/model` and `/fast` are absent because the composer owns
those controls, and `/status` is absent because the browser already presents
the relevant state. TUI terminal styling, local-login and debug commands are
likewise omitted rather than emulated or forwarded. Commands for Apps, plugins,
experimental flags, feedback and permanent deletion stay absent until Sandpi
has a faithful product surface and lifecycle contract for them. A native
mutation that cannot safely overlap a Turn is hidden and rejected while the
current Turn is active.

Uploaded composer files use the Sandbox0 File API and live under
`/workspace/.sandpi/uploads/{upload-id}/{safe-name}`. Sandpi validates a
bounded canonical payload before writing it, rejects symbolic-link path
components, and accepts structured browser local-image inputs only from that
exact subtree. PNG, JPEG, GIF and WebP uploads whose bytes match their declared
type become native `localImage` inputs; other uploads insert the protected
Workspace-relative upload path into the visible composer text at the current
selection. Sandpi submits only that visible user text and native image inputs;
it does not append an attachment explanation, instruction or any other hidden
prompt. The broader `.sandpi` internal tree cannot be submitted as a local
image, and the upload subtree remains absent from the Workspace IDE and
Workspace search results. PostgreSQL stores neither uploaded bytes nor a
file-reference catalog.

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

Codex-native MCP, dynamic tool and web-search activity describes semantic tool
execution in Session Activity. Environment network policy remains shared
runtime configuration and is not projected into a product Session timeline.

## MCP native authority

Codex owns MCP definitions, authentication, discovery and tool behavior.
Sandpi reads the effective server inventory through Codex native RPCs and does
not project it into PostgreSQL. The Environment settings surface mirrors the
Skills model: it lists the native inventory, refreshes status, and writes only
the native `enabled` value for definitions in the user configuration layer.
Project and admin definitions remain visible and read-only.

There is no Sandpi MCP catalog, integration record, credential store, OAuth
flow projection, endpoint-consent record or tool allowlist. Remote
authentication is handled by Codex and the provider. Sandpi starts the native
`mcpServer/oauth/login` request and exposes only Codex's callback listener
through a constrained Sandbox0 manual app service because a browser cannot
reach the remote Sandbox's loopback address. The public route accepts only
rate-limited callback GETs and cannot auto-resume the Environment. The
short-lived attempt and resulting credential remain native Codex state; Sandpi
stores neither in PostgreSQL. A successful native completion queues
`config/mcpServer/reload` so loaded Threads receive the new tool surface on
their next active Turn. Ordinary Environment network policy remains the
sandbox egress boundary, but it is not composed with MCP-specific credentials
or protocol rules.

Environment app-server processes disable Codex Apps, plugin discovery and tool
suggestion. Sandpi supports native Skills and direct MCP definitions, but it
does not implement the host-side plugin installation approval contract. This
keeps `request_plugin_install` out of Turns instead of allowing an unhandled
approval request to leave a Turn waiting indefinitely.

Local STDIO definitions remain inside the native harness trust boundary. Codex
launches those processes in the Environment Sandbox, where they can access the
Workspace and any network destinations allowed by the Environment policy.


## Environment lifecycle

Every Environment Sandbox is claimed with a 30-day Sandbox0 hard TTL,
`auto_resume=true`, and soft `ttl=0`. The hard TTL is an absolute destruction
bound; pause preserves the rootfs checkpoint but does not extend that deadline.
Sandpi disables Sandbox0 soft TTL because its native Turn projection owns the
idle-pause decision. The Workspace Volume and native harness home have their
independent durable lifecycle.

Each native `turn/completed` transition stores `last_turn_completed_at` and the
configured `idle_pause_due_at` in PostgreSQL in the same transaction as the
active-Turn projection. The idle window defaults to fifteen minutes. These rows
are the distributed timers: every Sandpi replica may scan due Environments,
while a PostgreSQL advisory lock keyed by Environment elects the replica
allowed to call Sandbox0. Under that lock it rechecks that no product Session
is provisioning or running and that no native Turn is active or pending before
calling `pauseAndWait`.

Turn admission takes the same advisory lock and persists pending delivery
before touching the native harness. Therefore either pause completes first and
the following supported runtime access is serialized and auto-resumed by
Sandbox0, or admission completes first and the pause recheck observes work.
Failed pause requests retain a durable retry deadline. Sandpi records the new
runtime generation after auto-resume and grants a fresh configured idle window
to avoid an immediately repeated pause, but the next native completion remains
the authoritative deadline source. Sandbox0 may return `sandbox is waking up`
while that transition commits; Sandpi waits for the native running generation
and retries the same supported runtime access. No Sandpi worker calls an
explicit resume API. Runtime recovery and pause share the Environment advisory
lock, so their database projections cannot commit out of order.

`environment_runtime.paused_at` remains the current Sandpi lifecycle
projection. Its transitions automatically append and close
`environment_pause_intervals` rows, preserving the history after auto-resume
clears the current field. Only the lifecycle worker's completed idle pause sets
this projection; temporary Sandbox0 pauses used for Workspace or Supervisor
repair are not mislabeled. The Metrics endpoint queries intervals overlapping
the exact Sandbox0 metrics window, and the Inspector shades them across every
runtime chart so intentional checkpoint gaps remain distinguishable from
collector failures. Sandbox0 aggregation points retain their effective bucket
step; the chart extends only adjacent segment endpoints within one step to the
exact pause boundary, without joining longer collection or reset gaps.

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

# SandPi v2: Native TUI Coding Agents on Sandbox0

Status: implemented release design
Baseline: `sandbox0-ai/sandpi` `main` at `d473d2b` (2026-08-31)

## 1. Objective

SandPi v2 should make native TUI coding agents available from the Web while
preserving their native interaction model. A user should be able to leave one
device, open another, and continue controlling the same running agent without
moving the Workspace or terminating the process.

SandPi manages multiple Environments. Each Environment is backed by exactly
one Sandbox0 Sandbox and owns its Workspace, coding-agent state, runtime
resources, network policy, credentials, snapshots, and forks.

Initial agent targets:

- OpenAI Codex
- Claude Code
- Pi

The entire SandPi interface should use a terminal-inspired visual language,
but product operations must remain usable with mouse and touch. Keyboard-only
navigation is not a requirement for managing SandPi.

## 2. Core product model

```text
Environment
├── one Sandbox0 Sandbox
├── one selected coding-agent type
├── one active native TUI process
├── persistent writable RootFS and Workspace
├── native coding-agent configuration and history
├── ephemeral credential projection
├── files, Git, preview, network, resources, and metrics
└── snapshots, restore, and forks
```

For the first v2 release, an Environment has one active agent TUI. If multiple
concurrent tasks inside one Environment are needed later, SandPi can add
multiple opaque Terminal Session tabs without reconstructing the agent's
conversation protocol.

The coding agent remains authoritative for its own session history, model
selection, tools, permissions, slash commands, and TUI behavior. SandPi does
not translate the native experience into a common chat protocol.

## 3. Recommended runtime architecture

```text
SandPi terminal-style Web UI
    ├── clickable Environment, Files, Snapshot, Fork, and Settings UI
    └── xterm.js native Agent surface
              │ authenticated WebSocket
              ▼
         SandPi server
              │ official Sandbox0 SDK
              ▼
      Environment Sandbox
          ├── persistent RootFS
          ├── procd persistent PTY Session
          │      └── codex | claude | pi
          └── ephemeral credential files
```

The existing SandPi terminal transport is the preferred foundation:

- browser-side xterm.js;
- Sandbox0 `procd` PTY Session;
- retained Supervisor event journal;
- cursor-based replay;
- terminal resize forwarding;
- reconnect support;
- runtime generation and attempt coordinates.

The main v2 change is therefore not to invent a new terminal transport. It is
to replace the current Codex app-server/Web chat surface with a persistent
native coding-agent TUI as the Environment's primary surface.

## 4. ttyd decision

Real browser tests confirmed that ttyd renders Codex, Claude Code, and Pi with
their native ANSI colors, layout, diff output, keyboard input, and PTY resize.
It can also be embedded in an HTTP dashboard iframe.

However, ttyd should not be the v2 runtime authority:

- `ttyd codex` terminates the child with SIGHUP when the browser disconnects;
- multiple ttyd clients do not naturally share one agent process;
- ttyd duplicates SandPi's existing xterm.js and WebSocket transport;
- it introduces another authentication, proxy, lifecycle, and origin boundary;
- using tmux behind ttyd would add another state owner while still not
  surviving a Sandbox runtime replacement.

The `coding-agent` template may include a pinned ttyd binary for diagnostics,
development, or an emergency terminal fallback. Production Agent control
should continue through SandPi -> Sandbox0 -> procd PTY.

If an early prototype deliberately uses ttyd, it must be treated as temporary:

- run behind the authenticated SandPi reverse proxy;
- do not publish the writable ttyd port directly;
- use same-origin WebSocket routing and origin checks;
- allow only one active controller;
- keep the actual agent process outside ttyd's browser-connection lifecycle.

## 5. Agent adapter boundary

SandPi should introduce an Environment-level agent registry rather than encode
Codex protocol details throughout the product.

Conceptual interface:

```ts
interface AgentAdapter {
  id: "codex" | "claude-code" | "pi";
  label: string;
  command: string[];
  environment: Record<string, string>;
  persistentStatePaths: string[];
  credentialProjection: AgentCredentialProjection;
  runtimeRecovery: AgentRuntimeRecoveryPolicy;
  capabilities: {
    nativeResume: boolean;
    mouse: boolean;
    structuredAutomation: boolean;
  };
}
```

The adapter owns only process launch and agent-specific credential/state
layout. It must not parse the visual terminal stream into messages, tool calls,
or a synthetic transcript.

Agent versions in the `coding-agent` template should be pinned and released as
an explicit template version/digest. A floating `latest` package is not a
runtime contract.

## 6. Multi-device continuity

Closing or backgrounding a browser must close only that browser attachment.
The procd PTY Session and agent process continue running in the Sandbox.

### Active controller lease

Multiple devices may watch the same terminal, but only one device may control
it. Without this rule, concurrent input can interleave and competing resize
events can continuously corrupt the native TUI layout.

Required behavior:

1. Every attachment has a stable client/device identifier.
2. One attachment owns the short-lived active-controller lease.
3. Only the controller may send input, signals, mouse data, or resize events.
4. A second device opens in view-only mode.
5. Clicking `[TAKE CONTROL]` atomically transfers the lease.
6. The previous controller immediately receives `control.revoked` and disables
   terminal input.
7. The new controller's size becomes authoritative for the PTY and triggers a
   redraw.

The lease must be fenced by at least:

```text
environment_id + runtime_generation + agent_session_id + attempt_id
```

It must work across multiple SandPi server replicas, so the controller record
cannot live only in one Node.js process.

### Screen recovery

- On an ordinary reconnect, reuse the existing xterm buffer and request events
  after the last received cursor.
- On a new device, replay the retained journal when possible, then send the
  controller's terminal dimensions to force the native TUI to redraw.
- If the retained cursor is no longer available, issue an explicit
  `screen.reset` state and rebuild from retained output plus a TUI redraw.
- SandPi should not create a second semantic transcript or parse terminal
  escape sequences into product messages.

## 7. Sandbox lifecycle semantics

| Operation | SandPi v2 behavior |
| --- | --- |
| Switch device | Reattach to the same procd PTY Session; agent keeps running. |
| Network reconnect | Resume journal consumption after the last cursor. |
| Snapshot | Create a named Sandbox0 RootFS snapshot; the running source remains running. |
| Restore | Pause the Sandbox, restore RootFS, invalidate the old PTY coordinates, and launch a new agent attempt. |
| Fork current state | Use Sandbox0 Sandbox fork; register the returned paused child as a new Environment. |
| Fork a named snapshot | Claim the same template with `snapshotId` and register the new Sandbox as an Environment. |
| Pause/resume | RootFS and native history survive; process, memory, socket, and PTY attempt do not. |
| Delete | Delete the Environment's Sandbox and product-owned snapshot references according to explicit retention policy. |

Sandbox0 snapshots and forks preserve filesystem state, not live process
memory. A forked Environment starts a new agent process, but it can read the
copied Workspace and native agent history.

### Snapshot changes from v1

The current product calls these operations “Workspace backups,” although the
latest implementation now captures the complete writable RootFS. v2 should
rename the concept to **Environment Snapshot**.

Current SandPi pauses a running Environment before taking a snapshot. Current
Sandbox0 supports a running-source RootFS snapshot through a brief writer
barrier, so v2 should avoid a full pause for ordinary snapshot creation.

Restore remains a destructive lifecycle operation and must:

- acquire the Environment lifecycle lock;
- revoke terminal control;
- pause the Sandbox;
- restore the selected snapshot;
- clear stale agent Session/attempt coordinates;
- publish a new runtime generation before accepting input;
- require explicit user confirmation in the UI.

### Environment fork transaction

Fork is an external-resource saga rather than one database transaction:

1. Authorize and lock the source Environment.
2. Persist a fork operation with an idempotency key.
3. Ask Sandbox0 to fork the current RootFS, or claim from a named snapshot.
4. Record the returned child Sandbox ID immediately.
5. Create the child Environment metadata and desired policy.
6. Reconcile network, resources, credential bindings, and lifecycle intent.
7. Keep the child paused until the user opens or explicitly resumes it.
8. Retry or clean up an orphan child if SandPi crashes between steps.

## 8. Credentials and snapshot safety

Native TUI login must not cause plaintext provider credentials to become part
of a RootFS snapshot or fork.

Preserve the existing security pattern:

- encrypt Environment credential material in PostgreSQL;
- materialize it only into memory-backed paths such as `/dev/shm`;
- point persistent agent configuration at the ephemeral projection when the
  agent supports this layout;
- rehydrate credentials after every runtime generation change;
- fence a new attempt until the current credential revision is installed.

Codex, Claude Code, and Pi need separate credential adapters because their
native storage layouts and login flows differ.

A fork must never inherit plaintext secret files through RootFS. Inheriting an
existing product credential binding should be an explicit, authorized policy;
otherwise the child starts disconnected and asks the user to connect an
account.

The same explicit-copy rule applies to SandPi-owned network and egress
credential policy. These policies must not be inferred solely from the bytes in
the forked RootFS.

## 9. Terminal-style product UI

The whole application uses a terminal visual system, while keeping semantic
HTML controls and pointer interaction.

### Desktop layout

```text
┌─ SANDPI v2 ─ environments ────────────────────────────────────────┐
│ ● development       │ ENV development / AGENT codex / LIVE       │
│ ○ release-lab       ├─────────────────────────────────────────────┤
│ ◐ experiments       │                                             │
│                     │         native coding-agent TUI              │
│ [+ ENVIRONMENT]     │                                             │
│                     ├─────────────────────────────────────────────┤
│                     │ [FILES] [SNAPSHOT] [FORK] [PAUSE] [SETTINGS]│
└─────────────────────┴─────────────────────────────────────────────┘
```

Design rules:

- monospace typography and ANSI-inspired color tokens;
- square or lightly rounded box-drawing panels instead of chat bubbles;
- environment state shown with both text and color;
- clickable rows, tabs, command tokens, menus, forms, and confirmation dialogs;
- visible hover, active, focus, disabled, and destructive states;
- semantic `<button>`, `<input>`, `<select>`, dialog, and landmark elements;
- no essential action hidden behind a keyboard shortcut;
- light and dark terminal themes with sufficient contrast.

### Mobile and touch

- Environment list becomes a drawer or full-screen panel.
- Agent, Files, Snapshots, and Environment become bottom navigation targets.
- Provide a virtual terminal key strip for `Esc`, `Tab`, `Ctrl`, `Alt`, arrow
  keys, paste, and other keys that mobile keyboards do not expose reliably.
- Tapping the terminal opens the software keyboard, but SandPi lifecycle and
  management actions remain fully touch-operable.
- Touch targets should be at least 44 CSS pixels even when they visually look
  like compact terminal tokens.

The terminal renderer may remain Canvas-based, but surrounding product UI must
remain accessible and searchable in the DOM.

## 10. Capabilities to keep from v1

- OIDC/builtin identity and ownership checks
- Environment CRUD and ordering
- one Environment to one Sandbox mapping
- Sandbox0 lifecycle authority and lifecycle locks
- idle pause, quota pause, manual pause/restart
- RootFS persistence
- network policy and egress credential injection
- resource settings, metrics, usage, and billing boundaries
- Files/Git/Web IDE and preview routing
- xterm.js terminal renderer and fit/search/link addons
- procd PTY Session transport and retained event journal
- terminal reconnect and cursor replay
- encrypted credential storage and ephemeral materialization
- generated OpenAPI contract and CLI boundary

## 11. Capabilities to remove or redesign

- Web chat Conversation and Composer as the main Agent UI
- Codex app-server event-to-React rendering
- product-owned Turn timeline and activity projections
- Codex-specific model/reasoning selectors outside the native TUI
- product Session fork and Turn fork UI
- duplicate Session status and unread state derived from native Turns
- automatic Turn recovery state machines that exist only for the app-server
  chat protocol

Native agent history already lives in the Environment RootFS. A v1-to-v2
migration can stop the app-server Supervisor and start the native TUI with the
same persistent agent home, allowing the native CLI to discover its own saved
history.

## 12. Automation boundary

Existing Schedules and Webhooks rely on Codex app-server operations such as
structured `turn/start`, stable input IDs, native completion events, and
idempotent reconciliation.

A pure TUI must not implement automation by typing prompts into a PTY. That is
brittle, cannot prove whether the agent is ready, and cannot safely reconcile
an ambiguous submission.

Recommended v2 scope:

- interactive Environment: native TUI only;
- initial v2 release: disable or defer Schedule/Webhook execution;
- later: add an optional headless adapter with structured admission and
  completion semantics;
- never make terminal keystroke injection the durable automation protocol.

## 13. Proposed data model

The exact schema should remain spec-first, but the conceptual tables are:

### `environments`

- ownership/team
- name, description, display order
- agent type
- template ID and configuration revision
- desired resources, network, credentials, and lifecycle policy

### `environment_runtime`

- Sandbox ID
- agent procd Session ID
- attempt ID
- runtime generation
- desired lifecycle state
- last terminal journal coordinates needed for recovery

### `environment_terminal_controllers`

- Environment ID
- runtime/session/attempt fencing coordinates
- holder user and client/device ID
- lease version and expiration

### `environment_snapshots`

- Sandbox0 snapshot ID
- Environment ID and source Sandbox ID
- name, description, kind, creation time, expiration/retention metadata

### `environment_fork_operations`

- operation and idempotency ID
- source Environment/snapshot
- target Environment
- child Sandbox ID
- durable phase, retry metadata, and terminal error

Existing `sessions`, `session_runtime`, Turn checkpoint, native delivery,
app-server decoder, and Conversation projection state can be retired after the
v1 migration is proven.

## 14. Implementation phases

### Phase 0: contracts and acceptance tests

- Define v2 Environment and Agent Session API contracts.
- Record real Codex, Claude Code, and Pi behavior in a Sandbox0 procd PTY.
- Test ANSI, alternate-screen mode, Unicode/CJK, IME, paste, mouse, resize,
  disconnect/reconnect, and mobile virtual keys.
- Define the production readiness boundary as regional ingress to usable Agent
  TUI, not a narrower local process stage.

### Phase 1: native Agent surface

- Add the `AgentAdapter` registry.
- Launch the selected agent directly in the existing persistent PTY Session.
- Make the terminal the primary Environment workspace.
- Add terminal screen reset and runtime-generation fencing.

### Phase 2: multi-device control

- Add the active-controller lease.
- Support view-only attachments and explicit take-over.
- Fence input and resize across SandPi replicas.
- Verify process survival while every client is disconnected.

### Phase 3: terminal-style shell

- Replace the current chat-oriented shell.
- Restyle Environment navigation, Files, metrics, settings, dialogs, and mobile
  navigation.
- Add the touch terminal key strip and command/action palette.

### Phase 4: Environment snapshot and fork

- Rename Workspace Backup to Environment Snapshot.
- Use running-source RootFS snapshots where supported.
- Add current-state and named-snapshot Environment forks.
- Add restore/fork sagas, lifecycle locking, cleanup, and UI progress.

### Phase 5: v1 retirement

- Migrate existing Environment RootFS and credential bindings.
- Mark in-flight v1 Session projections terminal while retaining native history
  as read-only migration data.
- Persist `stopped` as the desired state of every legacy Codex app-server
  Supervisor before clearing its runtime coordinates. Failed Sandbox0 calls
  remain durable lifecycle retries.
- Remove legacy Session projections from the Environment idle-pause authority;
  only the native Agent Terminal and Environment activity extend its deadline.
- Ensure the native Codex TUI can discover persisted history.
- Remove Conversation, Turn, app-server projection, and obsolete database
  state only after migration and rollback paths are tested.

### Phase 6: optional headless automation

- Introduce structured, agent-specific automation adapters only where the
  upstream agent exposes reliable programmatic semantics.

## 15. Required acceptance scenarios

1. Start a long Codex task, close the browser, open SandPi on another device,
   take control, and observe the same process still running.
2. Keep two devices connected; verify the viewer cannot send input or resize
   the controller's terminal.
3. Transfer control repeatedly without duplicated input or corrupted layout.
4. Repeat the device-switch scenario for Claude Code and Pi.
5. Snapshot a running Environment without stopping the source Agent.
6. Fork a running Environment; verify the source continues and the child starts
   paused with independent RootFS state.
7. Resume the child and verify copied Workspace/native history with no plaintext
   credential copied through RootFS.
8. Restore a snapshot and verify old PTY coordinates cannot accept late input.
9. Pause/resume an Environment and clearly report that the process attempt was
   replaced while persistent state survived.
10. Validate desktop, narrow panel, phone, tablet, IME, paste, selection,
    clipboard, mouse, and touch behavior.

## 16. Release decisions

- Agent type is selected when an Environment is created and is not changed in
  place in the first v2 release.
- A fork always starts without the source Environment's native agent credential
  or Sandbox0 credential bindings.
- Runtime replacement restarts the Environment's logical supervised agent
  session; the native agent restores its own durable history from RootFS.
- The first v2 release exposes one Agent Terminal per Environment. Multiple
  devices share it through one writable controller lease and viewer mode.
- ttyd ships in the production `coding-agent` template as a pinned diagnostic
  and compatibility binary. procd remains terminal authority.
- Existing Schedules and Webhooks are disabled during migration. Read and
  cleanup APIs remain temporarily available, while execution-producing
  mutations return HTTP 410.

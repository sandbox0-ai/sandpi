# Native coding-agent Session authority

Sandpi treats the coding agent's native Session as the only durable source of
conversation truth. For Codex this is the app-server Thread and its rollout in
the Session Workspace Volume. Sandpi does not persist, normalize, or
reconstruct a parallel chat transcript in PostgreSQL.

## Boundaries

- PostgreSQL stores product metadata, immutable Sandbox and Workspace Volume
  allocation coordinates, the opaque native Session id, Supervisor decoder
  coordinates, active native Turn state, checkpoint indexes, and operation
  recovery state. It never stores message, reasoning, tool-call, delta, or
  JSON-RPC response payloads.
- The Supervisor journal and the server's bounded notification ring are live
  transport. A reconnect always starts with a native harness snapshot; neither
  transport is conversation authority.
- A native snapshot is paired with the live cursor captured at the matching
  JSON-RPC response record. The client applies only the notification suffix
  after that boundary, so snapshot refresh neither loses nor duplicates live
  output.
- A missing native rollout is an invariant failure. Sandpi reports it and does
  not silently start a replacement native Session or display a database copy.
- A Sandpi Session keeps its initial Sandbox and Workspace Volume allocation
  for its lifetime. Runtime recovery may replace a Supervisor/process attempt,
  but never rebind the product Session to another Sandbox. If that immutable
  Sandbox disappears, the Session fails explicitly while its allocation and
  Workspace Volume coordinates remain available for diagnosis or recovery.
- Harness state and user workspace state share one Session-owned snapshot
  boundary. Codex stores its persistent home at
  `/workspace/.sandpi/harnesses/codex`; the Web IDE, file APIs, Git projection,
  file watch, and future sharing APIs must treat `/workspace/.sandpi` as a
  server-enforced internal subtree.
- Provider credentials are not part of that boundary. The Environment-scoped
  credential source is materialized at
  `/dev/shm/sandpi-codex-auth.json`; the persistent Codex home contains only a
  symlink to that ephemeral file, so snapshots and forks do not copy the
  credential body.

The reserved subtree is a product API boundary, not a privilege boundary
inside the Session. The coding agent and the Session owner have terminal access
to the same Sandbox and can inspect or corrupt their own native state, just as
they can with a local harness. Sandpi must never place a deployment secret or a
different user's credential there.

## Branch and checkpoint semantics

- Session fork creates a new Sandbox and Workspace Volume fork, then asks the
  native harness to fork its Session.
- Turn fork creates a new Sandbox, initializes its Workspace Volume from the
  selected source checkpoint, and asks the harness to fork through the selected
  native Turn. The checkpoint already contains the native rollout; Sandpi does
  not extract or import a second copy. Inherited Turns do not gain child-owned
  rollback capability unless their Volume checkpoints are explicitly recreated
  on the child Volume.
- At native Turn completion, the Supervisor cursor and a pending Workspace
  Volume checkpoint obligation are committed atomically. Snapshot creation can
  then retry safely without retaining the native event payload.
- Before native `turn/start` is dispatched, Sandpi journals only stable delivery
  coordinates (request id, native client-message id, Supervisor input id, input
  snapshot id, and delivery phase) in PostgreSQL. The exact RPC frame lives
  briefly in a rootfs transport outbox until Codex accepts it, then conversation
  content remains in the harness rollout. On a server restart Sandpi reconciles
  the coordinates and staged frame against the native Session without creating
  a database transcript.
- Edit and delete restore the exact pre-Turn Volume checkpoint, restart the
  native harness, and resume the same native Session id. Restoring one Volume
  rewinds both the rollout and the user workspace, so edit/delete do not create
  a native branch. The candidate replacement Turn and its live events remain
  private until one PostgreSQL transaction commits the history revision,
  active Turn, and checkpoint suffix. `session_turn_mutations` stores only the
  coordinates required to compensate by restoring the former head snapshot
  after a crash.
- Codex does not materialize an empty `thread/start` as a rollout. Restoring the
  input snapshot of the very first Turn therefore leaves no resumable native
  id. Only for that empty-history boundary, Sandpi uses `thread/start` and
  atomically records the returned id; no prior native conversation exists to
  branch or lose. Every materialized-history edit/delete resumes the same id.
- Edit/delete intentionally do not rewind rootfs-only side effects such as an
  OS package installed outside `/workspace`. A full Session fork still copies
  rootfs plus the Workspace Volume because it represents a new execution
  environment, not a history rewrite in the existing Session.
- Codex uses `thread/resume`, `thread/read(includeTurns: true)`, and
  `thread/fork(lastTurnId)`. `thread/fork` is reserved for a new Sandpi Session
  (Session fork or Turn fork) and interrupted-Turn canonicalization; it is not
  an edit/delete implementation. Sandpi does not use deprecated
  `thread/rollback`.

## Layout migration

Sessions created before the Volume layout stored Codex state in the Sandbox
rootfs. Their immutable historical Volume snapshots cannot be upgraded with
SQL because those snapshots never contained the rollout. Sandpi therefore
migrates an idle legacy Session lazily before its next state-changing operation:
it stops the old Supervisor, atomically copies the native home into the reserved
Volume subtree, starts a Volume-backed Supervisor, resumes and verifies the same
native Session, and only then commits the new layout. Legacy checkpoints remain
readable history but are never advertised as forkable or rewindable. New
checkpoints become capable as they are created on the Volume-backed layout.
The durable `migrating` state is scanned by startup maintenance without blocking
the API listener or unrelated Session workers, so a backend restart resumes the
migration instead of leaving the product Session permanently paused. Concurrent
callers in one Sandpi backend server share one in-flight migration promise.

The native snapshot exposes forkable and rewindable Turn ids separately. An
output snapshot is sufficient to fork a new Session; edit/delete additionally
requires the exact input snapshot so IDE or Terminal changes made between Turns
are not discarded.

Harness integrations remain native by design. A future Claude Code, OpenCode,
or Pi integration must define its own snapshot, live events, tool UI, models,
commands, and branching rules instead of being coerced into a Sandpi-wide chat
or tool-call schema.

Codex currently describes `thread/read(includeTurns: true)` as a lossy UI
projection: transient deltas and some execution lifecycle details may not be
present after reconnect. Sandpi intentionally accepts the harness-visible
native projection instead of creating a second durable conversation store.

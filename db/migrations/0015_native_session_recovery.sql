ALTER TABLE session_runtime
    ADD COLUMN pending_interrupted_native_turn_id TEXT;

ALTER TABLE session_turn_checkpoints
    ADD COLUMN workspace_volume_id TEXT,
    ADD COLUMN terminal_status TEXT
        CHECK (terminal_status IN ('completed', 'failed', 'interrupted')),
    ADD COLUMN seal_kind TEXT
        CHECK (seal_kind IN ('native_event', 'runtime_canonicalization')),
    ADD COLUMN sealed_supervisor_session_id TEXT,
    ADD COLUMN sealed_supervisor_sequence BIGINT
        CHECK (sealed_supervisor_sequence IS NULL OR sealed_supervisor_sequence >= 0);

UPDATE session_turn_checkpoints checkpoint
SET workspace_volume_id = runtime.workspace_volume_id
FROM session_runtime runtime
WHERE runtime.session_id = checkpoint.session_id;

ALTER TABLE session_turn_checkpoints
    ALTER COLUMN workspace_volume_id SET NOT NULL;

COMMENT ON COLUMN session_runtime.pending_interrupted_native_turn_id IS
    'Native Turn whose interruption still needs checkpoint and status reconciliation after a process recovery.';

COMMENT ON COLUMN session_runtime.native_branch_revision IS
    'Increments whenever the product Session atomically switches to a new canonical native branch, including edit/delete and interrupted-Turn recovery.';

COMMENT ON COLUMN session_turn_checkpoints.workspace_volume_id IS
    'Immutable Workspace Volume that owns both the input and output snapshots; Sandbox0 rejects cross-Volume restore.';
COMMENT ON COLUMN session_turn_checkpoints.terminal_status IS
    'Native terminal state sealed before the output Workspace snapshot is captured.';

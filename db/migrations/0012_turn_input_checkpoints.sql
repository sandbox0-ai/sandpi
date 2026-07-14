ALTER TABLE session_runtime
    ADD COLUMN pending_turn_input_snapshot_id TEXT;

ALTER TABLE session_turn_checkpoints
    ADD COLUMN input_workspace_snapshot_id TEXT;

COMMENT ON COLUMN session_runtime.pending_turn_input_snapshot_id IS
    'Workspace Volume snapshot captured immediately before the active native Turn. Completion transfers ownership to its durable Turn checkpoint.';

COMMENT ON COLUMN session_turn_checkpoints.input_workspace_snapshot_id IS
    'Exact pre-Turn Workspace state. History edit/delete restores this snapshot so browser or terminal edits made between Turns are preserved.';

-- The harness transcript remains native-only. This monotonic control bit says
-- only whether replacing a missing native Thread with an empty one could lose
-- history; it never stores conversation content or reconstructed Turns.

ALTER TABLE session_runtime
    ADD COLUMN native_history_materialized BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE session_runtime runtime
SET native_history_materialized = TRUE
WHERE EXISTS (
    SELECT 1
    FROM session_turn_checkpoints checkpoint
    WHERE checkpoint.session_id = runtime.session_id
      AND checkpoint.status <> 'deleted'
      AND checkpoint.native_head_turn_id IS NOT NULL
      AND checkpoint.native_session_id = runtime.native_session_id
      AND checkpoint.workspace_volume_id = runtime.workspace_volume_id
);

COMMENT ON COLUMN session_runtime.native_history_materialized IS
    'True when the active native coding-agent Session is known to contain at least one Turn; never transcript content.';

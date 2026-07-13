DROP INDEX session_turn_checkpoints_active_ordinal_unique_idx;

CREATE UNIQUE INDEX session_turn_checkpoints_active_ordinal_unique_idx
    ON session_turn_checkpoints (session_id, ordinal)
    WHERE status IN ('creating', 'ready');

COMMENT ON INDEX session_turn_checkpoints_active_ordinal_unique_idx IS
    'Failed and deleted attempts do not reserve a branch ordinal; only the active creating or ready checkpoint does.';

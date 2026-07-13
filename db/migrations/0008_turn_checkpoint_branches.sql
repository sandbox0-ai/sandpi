ALTER TABLE session_turn_checkpoints
    DROP CONSTRAINT session_turn_checkpoints_session_id_ordinal_key;

CREATE UNIQUE INDEX session_turn_checkpoints_active_ordinal_unique_idx
    ON session_turn_checkpoints (session_id, ordinal)
    WHERE status <> 'deleted';

COMMENT ON INDEX session_turn_checkpoints_active_ordinal_unique_idx IS
    'A rewritten Codex branch reuses logical Turn ordinals while superseded checkpoint records remain immutable.';

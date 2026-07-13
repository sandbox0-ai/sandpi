ALTER TABLE harness_events
    ADD COLUMN visible BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN superseded_at TIMESTAMPTZ;

CREATE INDEX harness_events_session_visible_replay_idx
    ON harness_events (session_id, sequence)
    WHERE visible AND message_kind = 'notification';

COMMENT ON COLUMN harness_events.visible IS
    'False after a native harness branch supersedes this event; the immutable record remains available for product integrity and debugging.';

CREATE TABLE session_turn_checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    turn_id TEXT,
    user_message_item_id TEXT,
    native_head_turn_id TEXT,
    workspace_snapshot_id TEXT,
    status TEXT NOT NULL DEFAULT 'creating'
        CHECK (status IN ('creating', 'ready', 'failed', 'deleted')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, ordinal),
    CHECK (
        (ordinal = 0 AND turn_id IS NULL AND user_message_item_id IS NULL)
        OR
        (ordinal > 0 AND turn_id IS NOT NULL AND user_message_item_id IS NOT NULL)
    ),
    CHECK (
        (status = 'ready' AND workspace_snapshot_id IS NOT NULL AND error IS NULL)
        OR status <> 'ready'
    )
);

CREATE UNIQUE INDEX session_turn_checkpoints_turn_unique_idx
    ON session_turn_checkpoints (session_id, turn_id)
    WHERE turn_id IS NOT NULL;

CREATE UNIQUE INDEX session_turn_checkpoints_user_item_unique_idx
    ON session_turn_checkpoints (session_id, user_message_item_id)
    WHERE user_message_item_id IS NOT NULL;

CREATE INDEX session_turn_checkpoints_ready_idx
    ON session_turn_checkpoints (session_id, ordinal)
    WHERE status = 'ready';

CREATE TRIGGER session_turn_checkpoints_set_updated_at
    BEFORE UPDATE ON session_turn_checkpoints
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE session_turn_checkpoints IS
    'Harness-neutral product checkpoint index. Codex captures one Workspace Volume snapshot before its first Turn and after every completed native Turn.';
COMMENT ON COLUMN session_turn_checkpoints.workspace_snapshot_id IS
    'Sandbox0 Workspace Volume snapshot. Turn history never snapshots or restores the Sandbox rootfs.';
COMMENT ON COLUMN session_turn_checkpoints.native_head_turn_id IS
    'Last native harness Turn included at this Workspace checkpoint; null only for a brand-new thread baseline.';

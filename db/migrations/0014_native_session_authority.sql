-- A coding-agent native Session is the only durable conversation history.
-- PostgreSQL keeps runtime coordinates and checkpoint metadata, never a copy
-- of native messages, tool calls, deltas, or JSON-RPC responses.

ALTER TABLE session_runtime
    RENAME COLUMN thread_id TO native_session_id;

ALTER TABLE session_runtime
    DROP COLUMN history_revision,
    ADD COLUMN native_branch_revision BIGINT NOT NULL DEFAULT 0
        CHECK (native_branch_revision >= 0),
    ADD COLUMN active_native_turn_id TEXT,
    ADD COLUMN active_turn_started_at TIMESTAMPTZ,
    ADD COLUMN active_turn_supervisor_sequence BIGINT
        CHECK (active_turn_supervisor_sequence IS NULL OR active_turn_supervisor_sequence >= 0),
    ADD COLUMN allocation_finalized_at TIMESTAMPTZ,
    ADD COLUMN resources_deleted_at TIMESTAMPTZ,
    ADD COLUMN runtime_error_code TEXT;

UPDATE session_runtime
SET allocation_finalized_at = COALESCE(allocation_finalized_at, updated_at)
WHERE sandbox_id IS NOT NULL AND workspace_volume_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_session_allocation_rebind()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.sandbox_id IS NOT NULL
       AND NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id THEN
        RAISE EXCEPTION 'Sandpi Session sandbox allocation is immutable';
    END IF;
    IF OLD.workspace_volume_id IS NOT NULL
       AND NEW.workspace_volume_id IS DISTINCT FROM OLD.workspace_volume_id THEN
        RAISE EXCEPTION 'Sandpi Session workspace allocation is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_runtime_prevent_allocation_rebind
    BEFORE UPDATE OF sandbox_id, workspace_volume_id ON session_runtime
    FOR EACH ROW EXECUTE FUNCTION prevent_session_allocation_rebind();

DROP INDEX session_turn_checkpoints_user_item_unique_idx;

ALTER TABLE session_turn_checkpoints
    DROP CONSTRAINT session_turn_checkpoints_check;

ALTER TABLE session_turn_checkpoints
    RENAME COLUMN turn_id TO native_turn_id;

ALTER TABLE session_turn_checkpoints
    ADD COLUMN native_session_id TEXT;

UPDATE session_turn_checkpoints checkpoint
SET native_session_id = runtime.native_session_id
FROM session_runtime runtime
WHERE runtime.session_id = checkpoint.session_id;

ALTER TABLE session_turn_checkpoints
    ALTER COLUMN native_session_id SET NOT NULL,
    DROP COLUMN user_message_item_id,
    ADD CONSTRAINT session_turn_checkpoints_native_turn_check CHECK (
        (ordinal = 0 AND native_turn_id IS NULL)
        OR
        (ordinal > 0 AND native_turn_id IS NOT NULL)
    );

COMMENT ON COLUMN session_runtime.native_session_id IS
    'Opaque active coding-agent native Session identifier. Codex calls this a thread id.';
COMMENT ON COLUMN session_runtime.native_branch_revision IS
    'Increments only when an explicit edit or delete switches this product Session to a new native branch.';
COMMENT ON COLUMN session_runtime.active_native_turn_id IS
    'Operational pointer used for interruption and checkpoint recovery; it contains no conversation content.';
COMMENT ON COLUMN session_runtime.allocation_finalized_at IS
    'Once set, this Session keeps the same Sandbox and Workspace Volume until resource deletion.';
COMMENT ON COLUMN session_turn_checkpoints.native_session_id IS
    'Native Session branch that owns this checkpoint.';
COMMENT ON COLUMN session_turn_checkpoints.native_turn_id IS
    'Native Turn completed at this Workspace point-in-time; null only for the branch baseline.';

CREATE TABLE session_turn_mutations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('edit', 'delete', 'recovery')),
    phase TEXT NOT NULL CHECK (
        phase IN ('prepared', 'restoring', 'branched', 'compensating', 'failed')
    ),
    selected_native_turn_id TEXT,
    selected_ordinal INTEGER CHECK (selected_ordinal IS NULL OR selected_ordinal > 0),
    original_native_session_id TEXT NOT NULL,
    replacement_native_session_id TEXT,
    restore_workspace_snapshot_id TEXT,
    head_workspace_snapshot_id TEXT NOT NULL,
    branch_through_native_turn_id TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        kind = 'recovery'
        OR (
            selected_native_turn_id IS NOT NULL
            AND selected_ordinal IS NOT NULL
            AND restore_workspace_snapshot_id IS NOT NULL
        )
    )
);

CREATE TRIGGER session_turn_mutations_set_updated_at
    BEFORE UPDATE ON session_turn_mutations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Preserve the minimum compensation coordinates for any mutation interrupted
-- while upgrading from the former database event projection.
INSERT INTO session_turn_mutations (
    id, session_id, kind, phase, original_native_session_id,
    head_workspace_snapshot_id
)
SELECT
    'mutation_migrated_' || session.id,
    session.id,
    'recovery',
    'compensating',
    COALESCE(
        (
            SELECT event.notification #>> '{params,threadId}'
            FROM harness_events event
            WHERE event.session_id = session.id AND event.visible
              AND event.notification->>'method' = 'turn/completed'
            ORDER BY event.sequence DESC LIMIT 1
        ),
        (
            SELECT event.notification #>> '{params,thread,id}'
            FROM harness_events event
            WHERE event.session_id = session.id AND event.visible
              AND event.notification->>'method' = 'thread/started'
            ORDER BY event.sequence LIMIT 1
        ),
        runtime.native_session_id
    ),
    head.workspace_snapshot_id
FROM sessions session
JOIN session_runtime runtime ON runtime.session_id = session.id
JOIN LATERAL (
    SELECT workspace_snapshot_id
    FROM session_turn_checkpoints
    WHERE session_id = session.id AND status = 'ready'
    ORDER BY ordinal DESC LIMIT 1
) head ON TRUE
WHERE session.status = 'paused'
  AND COALESCE(
      (
          SELECT event.notification #>> '{params,threadId}'
          FROM harness_events event
          WHERE event.session_id = session.id AND event.visible
            AND event.notification->>'method' = 'turn/completed'
          ORDER BY event.sequence DESC LIMIT 1
      ),
      runtime.native_session_id
  ) IS NOT NULL;

COMMENT ON TABLE session_turn_mutations IS
    'Crash-recovery journal for explicit native edit/delete branches. It stores coordinates only, never conversation content.';

DROP TABLE harness_events;

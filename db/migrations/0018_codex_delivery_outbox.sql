-- A staged native RPC frame lives only in the Session rootfs outbox. PostgreSQL
-- records its delivery phase, never the prompt or message payload.

ALTER TABLE session_runtime
    DROP CONSTRAINT session_runtime_pending_turn_phase_check,
    DROP CONSTRAINT session_runtime_pending_turn_snapshot_check;

ALTER TABLE session_runtime
    ADD CONSTRAINT session_runtime_pending_turn_phase_check CHECK (
        pending_turn_phase IN (
            'prepared',
            'snapshot_ready',
            'staged',
            'submitted',
            'accepted'
        )
    ),
    ADD CONSTRAINT session_runtime_pending_turn_snapshot_check CHECK (
        pending_turn_phase NOT IN (
            'snapshot_ready', 'staged', 'submitted', 'accepted'
        )
        OR pending_turn_input_snapshot_id IS NOT NULL
    );

COMMENT ON COLUMN session_runtime.pending_turn_phase IS
    'Durable delivery phase. staged means the exact RPC frame is recoverable from the Session rootfs outbox.';

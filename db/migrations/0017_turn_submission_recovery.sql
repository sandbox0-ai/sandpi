-- Persist only delivery coordinates for the one Turn a Session may submit at a
-- time. The prompt remains exclusively in the native coding-agent Session.

ALTER TABLE session_runtime
    ADD COLUMN pending_turn_request_id TEXT,
    ADD COLUMN pending_turn_client_message_id TEXT,
    ADD COLUMN pending_turn_stable_input_id TEXT,
    ADD COLUMN pending_turn_phase TEXT
        CHECK (pending_turn_phase IN (
            'prepared',
            'snapshot_ready',
            'submitted',
            'accepted'
        )),
    ADD COLUMN pending_turn_native_turn_id TEXT,
    ADD COLUMN pending_turn_started_at TIMESTAMPTZ,
    ADD COLUMN pending_turn_submitted_at TIMESTAMPTZ;

-- An upgrade can encounter a Turn that was already accepted by the native
-- harness. Preserve its input snapshot until the existing completion path
-- transfers it to the durable Turn checkpoint.
UPDATE session_runtime
SET pending_turn_request_id = 'legacy:' || session_id,
    pending_turn_stable_input_id = 'legacy:' || session_id,
    pending_turn_phase = CASE
        WHEN active_native_turn_id IS NULL THEN 'submitted'
        ELSE 'accepted'
    END,
    pending_turn_native_turn_id = active_native_turn_id,
    pending_turn_started_at = COALESCE(active_turn_started_at, updated_at),
    pending_turn_submitted_at = COALESCE(active_turn_started_at, updated_at)
WHERE pending_turn_input_snapshot_id IS NOT NULL;

ALTER TABLE session_runtime
    ADD CONSTRAINT session_runtime_pending_turn_coordinates_check CHECK (
        (
            pending_turn_phase IS NULL
            AND pending_turn_request_id IS NULL
            AND pending_turn_client_message_id IS NULL
            AND pending_turn_stable_input_id IS NULL
            AND pending_turn_native_turn_id IS NULL
            AND pending_turn_started_at IS NULL
            AND pending_turn_submitted_at IS NULL
        )
        OR
        (
            pending_turn_phase IS NOT NULL
            AND pending_turn_request_id IS NOT NULL
            AND pending_turn_stable_input_id IS NOT NULL
            AND pending_turn_started_at IS NOT NULL
        )
    ),
    ADD CONSTRAINT session_runtime_pending_turn_snapshot_check CHECK (
        pending_turn_phase NOT IN ('snapshot_ready', 'submitted', 'accepted')
        OR pending_turn_input_snapshot_id IS NOT NULL
    ),
    ADD CONSTRAINT session_runtime_pending_turn_acceptance_check CHECK (
        pending_turn_native_turn_id IS NULL
        OR pending_turn_phase = 'accepted'
    );

CREATE INDEX session_runtime_pending_turn_idx
    ON session_runtime (pending_turn_started_at)
    WHERE pending_turn_phase IS NOT NULL;

COMMENT ON COLUMN session_runtime.pending_turn_request_id IS
    'Stable native JSON-RPC request id for crash reconciliation; never prompt content.';
COMMENT ON COLUMN session_runtime.pending_turn_client_message_id IS
    'Native clientUserMessageId echoed by the corresponding userMessage item.';
COMMENT ON COLUMN session_runtime.pending_turn_stable_input_id IS
    'Supervisor input id used to deduplicate delivery of the native RPC frame.';
COMMENT ON COLUMN session_runtime.pending_turn_phase IS
    'Durable delivery phase for the one in-flight native Turn submission.';
COMMENT ON COLUMN session_runtime.pending_turn_native_turn_id IS
    'Native Turn id once Codex acceptance has been observed.';

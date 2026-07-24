-- A replaced Sandbox runtime cannot preserve an in-flight Codex Turn. Keep
-- only scalar coordinates needed to distinguish a runtime interruption from a
-- user interrupt and to submit one visible recovery Turn on the native Thread.
-- The original prompt remains exclusively in the Codex rollout.

ALTER TABLE session_runtime
    ADD COLUMN active_turn_attempt_id TEXT,
    ADD COLUMN active_turn_runtime_generation BIGINT
        CHECK (
            active_turn_runtime_generation IS NULL
            OR active_turn_runtime_generation >= 0
        ),
    ADD COLUMN pending_turn_attempt_id TEXT,
    ADD COLUMN pending_turn_runtime_generation BIGINT
        CHECK (
            pending_turn_runtime_generation IS NULL
            OR pending_turn_runtime_generation >= 0
        ),
    ADD COLUMN interrupt_requested_native_turn_id TEXT,
    ADD COLUMN recovery_source_native_turn_id TEXT,
    ADD COLUMN recovery_prompt_version INTEGER
        CHECK (recovery_prompt_version IS NULL OR recovery_prompt_version > 0),
    ADD COLUMN recovery_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (recovery_attempt_count >= 0);

COMMENT ON COLUMN session_runtime.active_turn_attempt_id IS
    'Supervisor attempt that accepted or started the active native Turn.';
COMMENT ON COLUMN session_runtime.active_turn_runtime_generation IS
    'Sandbox runtime generation that accepted or started the active native Turn.';
COMMENT ON COLUMN session_runtime.pending_turn_attempt_id IS
    'Supervisor attempt targeted by the current submitted native Turn request.';
COMMENT ON COLUMN session_runtime.pending_turn_runtime_generation IS
    'Sandbox runtime generation targeted by the current submitted native Turn request.';
COMMENT ON COLUMN session_runtime.interrupt_requested_native_turn_id IS
    'Native Turn the user explicitly asked Sandpi to interrupt; suppresses automatic continuation.';
COMMENT ON COLUMN session_runtime.recovery_source_native_turn_id IS
    'Interrupted native Turn for which Sandpi claimed one automatic continuation Turn.';
COMMENT ON COLUMN session_runtime.recovery_prompt_version IS
    'Version of the server-defined recovery instruction; no prompt content is stored.';
COMMENT ON COLUMN session_runtime.recovery_attempt_count IS
    'Number of semantic automatic continuation Turns claimed for the current interrupted Turn.';

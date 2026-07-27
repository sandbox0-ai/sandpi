-- Sandpi owns recovery from Sandbox and Codex process replacement. Persist
-- only scalar coordinates needed to claim one visible recovery Turn without
-- storing or replaying the original user prompt.

ALTER TABLE session_runtime
    ADD COLUMN recovery_source_native_turn_id TEXT,
    ADD COLUMN recovery_prompt_version INTEGER
        CHECK (recovery_prompt_version IS NULL OR recovery_prompt_version > 0),
    ADD COLUMN recovery_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (recovery_attempt_count >= 0);

COMMENT ON COLUMN session_runtime.recovery_source_native_turn_id IS
    'Interrupted native Turn for which Sandpi claimed one automatic recovery Turn.';
COMMENT ON COLUMN session_runtime.recovery_prompt_version IS
    'Version of the server-defined recovery instruction; no prompt content is stored.';
COMMENT ON COLUMN session_runtime.recovery_attempt_count IS
    'Number of automatic recovery Turns claimed for the current interrupted Turn.';

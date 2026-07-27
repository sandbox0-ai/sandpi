-- Sandpi no longer creates semantic continuation Turns after a Sandbox
-- runtime replacement. Clear recovery-only errors and remove the obsolete
-- semantic state from the current schema.

UPDATE session_runtime
SET runtime_error_code = NULL
WHERE runtime_error_code LIKE 'automatic_turn_recovery_%';

ALTER TABLE session_runtime
    DROP COLUMN recovery_source_native_turn_id,
    DROP COLUMN recovery_prompt_version,
    DROP COLUMN recovery_attempt_count;

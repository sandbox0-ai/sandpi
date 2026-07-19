-- Sandbox0 owns the live Sandbox and Supervisor epoch. Sandpi persists the
-- last fully hydrated epoch for CAS and recovery, while the decoder keeps
-- separate coordinates for replaying the Supervisor journal.

ALTER TABLE environment_runtime
    ADD COLUMN decoder_attempt_id TEXT,
    ADD COLUMN decoder_runtime_generation BIGINT NOT NULL DEFAULT 0
        CHECK (decoder_runtime_generation >= 0);

UPDATE environment_runtime
SET decoder_attempt_id = attempt_id,
    decoder_runtime_generation = runtime_generation;

COMMENT ON COLUMN environment_runtime.attempt_id IS
    'Last Sandbox0 Supervisor attempt fully hydrated with ephemeral credentials and initialized by Sandpi.';
COMMENT ON COLUMN environment_runtime.runtime_generation IS
    'Last Sandbox0 runtime generation fully hydrated and initialized by Sandpi.';
COMMENT ON COLUMN environment_runtime.decoder_attempt_id IS
    'Supervisor journal decoder coordinate only; it is not proof that the Harness runtime is ready.';
COMMENT ON COLUMN environment_runtime.decoder_runtime_generation IS
    'Supervisor journal decoder coordinate only; Sandbox0 remains authoritative for the live runtime generation.';

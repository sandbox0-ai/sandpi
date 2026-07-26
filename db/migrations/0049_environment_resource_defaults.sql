-- Apply the smaller product defaults only to newly created Environments.
-- Existing values may be user-configured and must remain unchanged.
ALTER TABLE environments
    ALTER COLUMN idle_pause_timeout_seconds SET DEFAULT 900,
    ALTER COLUMN sandbox_memory_mib SET DEFAULT 1024;

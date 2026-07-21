-- Environment Sandboxes no longer have an absolute lifetime. Existing
-- Sandboxes are reconciled to hardTtl = 0 by lifecycle policy version 3.
DROP INDEX IF EXISTS environment_runtime_hard_expiry_idx;

ALTER TABLE environment_runtime
    DROP COLUMN sandbox_hard_expires_at;

COMMENT ON COLUMN environment_runtime.lifecycle_policy_version IS
    'Version of the Sandpi-owned Sandbox0 lifecycle policy last applied to the Environment Sandbox.';

COMMENT ON COLUMN environments.idle_pause_timeout_seconds IS
    'Seconds after the latest runtime activity before Sandpi pauses the Sandbox; zero disables automatic pause; maximum 30 days.';

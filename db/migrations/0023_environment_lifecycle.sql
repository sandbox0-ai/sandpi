-- Environment lifecycle deadlines are durable database state. Every Sandpi
-- server may scan them, while a per-Environment advisory lock elects the one
-- server allowed to execute the external Sandbox0 lifecycle transition.

ALTER TABLE environment_runtime
    ADD COLUMN lifecycle_policy_version INTEGER NOT NULL DEFAULT 0
        CHECK (lifecycle_policy_version >= 0),
    ADD COLUMN sandbox_hard_expires_at TIMESTAMPTZ,
    ADD COLUMN last_turn_completed_at TIMESTAMPTZ,
    ADD COLUMN idle_pause_due_at TIMESTAMPTZ,
    ADD COLUMN lifecycle_error TEXT,
    ADD COLUMN paused_at TIMESTAMPTZ;

CREATE INDEX environment_runtime_lifecycle_policy_idx
    ON environment_runtime (lifecycle_policy_version, environment_id)
    WHERE sandbox_id IS NOT NULL;

CREATE INDEX environment_runtime_idle_pause_due_idx
    ON environment_runtime (idle_pause_due_at, environment_id)
    WHERE sandbox_id IS NOT NULL
      AND desired_state IN ('running', 'paused');

CREATE INDEX environment_runtime_hard_expiry_idx
    ON environment_runtime (sandbox_hard_expires_at, environment_id)
    WHERE sandbox_id IS NOT NULL;

COMMENT ON COLUMN environment_runtime.sandbox_hard_expires_at IS
    'Absolute Sandbox0 hard-expiry deadline. Updating lifecycle policy must preserve this target across retries.';
COMMENT ON COLUMN environment_runtime.idle_pause_due_at IS
    'Durable distributed timer set by the latest native turn/completed event.';

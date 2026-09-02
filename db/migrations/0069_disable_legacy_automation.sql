-- Native TUI v2 deliberately has no durable prompt-injection protocol.
-- Preserve released definitions and history as read-only migration data, but
-- make every queued or enabled app-server automation terminal before v2 runs.

UPDATE environment_schedules
SET enabled = FALSE,
    next_run_at = NULL,
    last_error = 'Disabled by Sandpi v2: native TUI automation requires a structured headless adapter.',
    revision = revision + 1
WHERE deleted_at IS NULL
  AND (enabled = TRUE OR next_run_at IS NOT NULL);

UPDATE environment_schedule_runs
SET status = 'failed',
    error = 'Disabled by Sandpi v2 before native TUI migration.',
    lease_token = NULL,
    lease_expires_at = NULL,
    finished_at = COALESCE(finished_at, NOW())
WHERE status IN ('claimed', 'running');

UPDATE environment_webhooks
SET enabled = FALSE,
    last_error = 'Disabled by Sandpi v2: native TUI automation requires a structured headless adapter.',
    revision = revision + 1
WHERE deleted_at IS NULL AND enabled = TRUE;

UPDATE environment_webhook_runs
SET status = 'failed',
    error = 'Disabled by Sandpi v2 before native TUI migration.',
    lease_token = NULL,
    lease_expires_at = NULL,
    finished_at = COALESCE(finished_at, NOW())
WHERE status IN ('queued', 'claimed', 'running');

COMMENT ON TABLE environment_schedules IS
    'Read-only v1 Schedule definitions retained during native TUI v2 migration; execution is disabled.';
COMMENT ON TABLE environment_webhooks IS
    'Read-only v1 Webhook definitions retained during native TUI v2 migration; ingress and execution are disabled.';

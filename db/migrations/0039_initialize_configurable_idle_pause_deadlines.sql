-- Existing running Sandboxes may not have a deadline until their next access.
-- Start their configured idle window at migration time; paused and disabled
-- Environments remain untouched.
UPDATE environment_runtime runtime
SET idle_pause_due_at = NOW() + (
      environment.idle_pause_timeout_seconds::BIGINT * INTERVAL '1 second'
    ),
    version = version + 1
FROM environments environment
WHERE environment.id = runtime.environment_id
  AND environment.idle_pause_timeout_seconds > 0
  AND runtime.sandbox_id IS NOT NULL
  AND runtime.desired_state = 'running'
  AND runtime.observed_state = 'running'
  AND runtime.idle_pause_due_at IS NULL;

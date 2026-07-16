-- Existing durable deadlines were calculated with the former three-minute
-- policy. Preserve each deadline's activity anchor while extending active or
-- already-prepared idle timers to the new thirty-minute policy.

UPDATE environment_runtime
SET idle_pause_due_at = idle_pause_due_at + INTERVAL '27 minutes',
    version = version + 1
WHERE idle_pause_due_at IS NOT NULL
  AND desired_state IN ('running', 'paused')
  AND observed_state = 'running';

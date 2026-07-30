ALTER TABLE environment_pause_intervals
    DROP CONSTRAINT environment_pause_intervals_reason_check,
    ADD CONSTRAINT environment_pause_intervals_reason_check
        CHECK (reason IN ('idle', 'quota', 'manual'));

ALTER TABLE environment_runtime
    DROP CONSTRAINT environment_runtime_pause_reason_check,
    ADD CONSTRAINT environment_runtime_pause_reason_check
        CHECK (pause_reason IN ('idle', 'quota', 'manual'));

COMMENT ON COLUMN environment_runtime.pause_reason IS
    'Sandpi-owned completed pause reason: idle policy, quota enforcement, or an explicit user recovery action.';

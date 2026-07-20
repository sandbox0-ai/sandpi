-- Preserve completed Sandpi idle-pause intervals for observability. The
-- environment_runtime.paused_at column remains the current-state projection;
-- this table is its append-only history for explaining metric gaps.

CREATE TABLE environment_pause_intervals (
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    paused_at TIMESTAMPTZ NOT NULL,
    resumed_at TIMESTAMPTZ,
    reason TEXT NOT NULL DEFAULT 'idle'
        CHECK (reason IN ('idle')),
    PRIMARY KEY (environment_id, paused_at),
    CHECK (resumed_at IS NULL OR resumed_at >= paused_at)
);

CREATE UNIQUE INDEX environment_pause_intervals_open_idx
    ON environment_pause_intervals (environment_id)
    WHERE resumed_at IS NULL;

CREATE INDEX environment_pause_intervals_range_idx
    ON environment_pause_intervals (environment_id, paused_at, resumed_at);

INSERT INTO environment_pause_intervals (environment_id, paused_at)
SELECT environment_id, paused_at
FROM environment_runtime
WHERE paused_at IS NOT NULL;

CREATE FUNCTION project_environment_pause_interval()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.paused_at IS DISTINCT FROM NEW.paused_at THEN
        IF OLD.paused_at IS NOT NULL THEN
            UPDATE environment_pause_intervals
            SET resumed_at = GREATEST(NOW(), paused_at)
            WHERE environment_id = OLD.environment_id
              AND paused_at = OLD.paused_at
              AND resumed_at IS NULL;
        END IF;

        IF NEW.paused_at IS NOT NULL THEN
            INSERT INTO environment_pause_intervals (
                environment_id,
                paused_at
            )
            VALUES (NEW.environment_id, NEW.paused_at)
            ON CONFLICT (environment_id, paused_at) DO NOTHING;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER environment_runtime_project_pause_interval
    AFTER UPDATE OF paused_at ON environment_runtime
    FOR EACH ROW
    EXECUTE FUNCTION project_environment_pause_interval();

COMMENT ON TABLE environment_pause_intervals IS
    'Historical Sandpi-owned idle-pause intervals derived from environment_runtime.paused_at transitions for runtime observability.';

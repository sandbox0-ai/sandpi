-- Environment Schedules are Sandpi-owned Automation definitions. PostgreSQL
-- stores their user-authored input and an immutable per-run delivery snapshot
-- so server or Sandbox replacement cannot duplicate a native Turn.

CREATE TABLE environment_schedules (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    prompt TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 100000),
    timing_kind TEXT NOT NULL CHECK (timing_kind IN ('once', 'cron')),
    run_at TIMESTAMPTZ,
    cron_expression TEXT CHECK (
        cron_expression IS NULL OR char_length(cron_expression) BETWEEN 1 AND 200
    ),
    time_zone TEXT CHECK (
        time_zone IS NULL OR char_length(time_zone) BETWEEN 1 AND 100
    ),
    target_kind TEXT NOT NULL
        CHECK (target_kind IN ('new_session', 'session')),
    target_session_id TEXT,
    overlap_policy TEXT NOT NULL DEFAULT 'skip'
        CHECK (overlap_policy = 'skip'),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    title TEXT CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
    model_id TEXT CHECK (
        model_id IS NULL OR char_length(model_id) BETWEEN 1 AND 200
    ),
    reasoning_effort TEXT CHECK (
        reasoning_effort IS NULL
        OR char_length(reasoning_effort) BETWEEN 1 AND 100
    ),
    collaboration_mode TEXT CHECK (
        collaboration_mode IS NULL OR collaboration_mode = 'plan'
    ),
    service_tier TEXT CHECK (
        service_tier IS NULL OR char_length(service_tier) BETWEEN 1 AND 100
    ),
    next_run_at TIMESTAMPTZ,
    last_scheduled_for TIMESTAMPTZ,
    last_run_status TEXT CHECK (
        last_run_status IS NULL
        OR last_run_status IN (
            'claimed', 'running', 'succeeded', 'failed', 'skipped'
        )
    ),
    last_error TEXT,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (
            timing_kind = 'once'
            AND run_at IS NOT NULL
            AND cron_expression IS NULL
            AND time_zone IS NULL
        )
        OR (
            timing_kind = 'cron'
            AND run_at IS NULL
            AND cron_expression IS NOT NULL
            AND time_zone IS NOT NULL
        )
    ),
    CHECK (
        (target_kind = 'new_session' AND target_session_id IS NULL)
        OR (target_kind = 'session' AND target_session_id IS NOT NULL)
    )
);

CREATE INDEX environment_schedules_due_idx
    ON environment_schedules (next_run_at, id)
    WHERE enabled = TRUE
      AND deleted_at IS NULL
      AND next_run_at IS NOT NULL;
CREATE INDEX environment_schedules_environment_idx
    ON environment_schedules (environment_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE TRIGGER environment_schedules_set_updated_at
    BEFORE UPDATE ON environment_schedules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE environment_schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL
        REFERENCES environment_schedules(id) ON DELETE CASCADE,
    schedule_revision BIGINT NOT NULL CHECK (schedule_revision > 0),
    scheduled_for TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('claimed', 'running', 'succeeded', 'failed', 'skipped')
    ),
    prompt TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 100000),
    title TEXT CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
    model_id TEXT,
    reasoning_effort TEXT,
    collaboration_mode TEXT CHECK (
        collaboration_mode IS NULL OR collaboration_mode = 'plan'
    ),
    service_tier TEXT,
    target_kind TEXT NOT NULL
        CHECK (target_kind IN ('new_session', 'session')),
    target_session_id TEXT,
    session_id TEXT,
    native_turn_id TEXT,
    request_id TEXT NOT NULL,
    client_message_id TEXT NOT NULL,
    stable_input_id TEXT NOT NULL,
    lease_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    dispatch_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (dispatch_attempt_count >= 0),
    error TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (schedule_id, scheduled_for),
    UNIQUE (client_message_id),
    CHECK (
        target_kind = 'new_session'
        OR target_session_id IS NOT NULL
    )
);

CREATE INDEX environment_schedule_runs_active_idx
    ON environment_schedule_runs (
        COALESCE(lease_expires_at, created_at), scheduled_for, id
    )
    WHERE status IN ('claimed', 'running');
CREATE INDEX environment_schedule_runs_history_idx
    ON environment_schedule_runs (schedule_id, scheduled_for DESC, id DESC);

CREATE TRIGGER environment_schedule_runs_set_updated_at
    BEFORE UPDATE ON environment_schedule_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION disable_environment_schedules_for_deleted_session()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE environment_schedules
    SET enabled = FALSE,
        next_run_at = NULL,
        last_error = 'The target Session was deleted.',
        revision = revision + 1
    WHERE target_kind = 'session'
      AND target_session_id = OLD.id
      AND deleted_at IS NULL;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_disable_environment_schedules
    BEFORE DELETE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION disable_environment_schedules_for_deleted_session();

COMMENT ON TABLE environment_schedules IS
    'User-authored Environment Automation definitions; prompts are future inputs, not copied native conversation history.';
COMMENT ON TABLE environment_schedule_runs IS
    'Durable occurrence ledger and immutable input snapshots for crash-safe native Turn delivery.';
COMMENT ON COLUMN environment_schedules.next_run_at IS
    'Earliest unprocessed occurrence; recurring downtime is coalesced when claimed.';
COMMENT ON COLUMN environment_schedule_runs.lease_expires_at IS
    'Short multi-replica claim lease; expiry permits safe reconciliation, not blind replay.';

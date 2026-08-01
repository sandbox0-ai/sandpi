-- Environment Webhooks are Sandpi-owned Automation trigger definitions.
-- The public ingress records verified deliveries before an asynchronous worker
-- wakes an Environment or submits a native Turn.

CREATE TABLE environment_webhooks (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    endpoint_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    provider TEXT NOT NULL
        CHECK (provider IN ('github', 'alertmanager', 'slack', 'custom')),
    secret_ciphertext BYTEA NOT NULL,
    secret_initialization_vector BYTEA NOT NULL,
    secret_authentication_tag BYTEA NOT NULL,
    secret_algorithm TEXT NOT NULL CHECK (secret_algorithm = 'aes-256-gcm'),
    secret_key_id TEXT NOT NULL,
    prompt TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 50000),
    trigger_mode TEXT NOT NULL DEFAULT 'every'
        CHECK (trigger_mode IN ('every', 'state_change')),
    event_types JSONB NOT NULL DEFAULT '[]'::JSONB,
    conditions JSONB NOT NULL DEFAULT '[]'::JSONB,
    state_path TEXT,
    group_key_path TEXT,
    cooldown_mode TEXT NOT NULL DEFAULT 'none'
        CHECK (cooldown_mode IN ('none', 'throttle', 'debounce', 'batch')),
    cooldown_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (cooldown_seconds BETWEEN 0 AND 86400),
    cooldown_behavior TEXT NOT NULL DEFAULT 'merge'
        CHECK (cooldown_behavior IN ('suppress', 'latest', 'merge')),
    target_kind TEXT NOT NULL
        CHECK (target_kind IN ('new_session', 'session')),
    target_session_id TEXT,
    overlap_policy TEXT NOT NULL DEFAULT 'queue'
        CHECK (overlap_policy IN ('queue', 'skip')),
    max_concurrent_runs INTEGER NOT NULL DEFAULT 1
        CHECK (max_concurrent_runs BETWEEN 1 AND 10),
    max_pending_runs INTEGER NOT NULL DEFAULT 100
        CHECK (max_pending_runs BETWEEN 1 AND 1000),
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
    last_delivery_at TIMESTAMPTZ,
    last_delivery_status TEXT CHECK (
        last_delivery_status IS NULL
        OR last_delivery_status IN (
            'queued', 'batched', 'filtered', 'suppressed', 'duplicate'
        )
    ),
    last_run_status TEXT CHECK (
        last_run_status IS NULL
        OR last_run_status IN (
            'queued', 'claimed', 'running', 'succeeded', 'failed', 'skipped'
        )
    ),
    last_error TEXT,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (target_kind = 'new_session' AND target_session_id IS NULL)
        OR (target_kind = 'session' AND target_session_id IS NOT NULL)
    ),
    CHECK (
        (trigger_mode = 'state_change' AND state_path IS NOT NULL)
        OR trigger_mode = 'every'
    ),
    CHECK (
        (cooldown_mode = 'none' AND cooldown_seconds = 0)
        OR (cooldown_mode <> 'none' AND cooldown_seconds > 0)
    ),
    CHECK (jsonb_typeof(event_types) = 'array'),
    CHECK (jsonb_typeof(conditions) = 'array')
);

CREATE INDEX environment_webhooks_environment_idx
    ON environment_webhooks (environment_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE TRIGGER environment_webhooks_set_updated_at
    BEFORE UPDATE ON environment_webhooks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE environment_webhook_runs (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL
        REFERENCES environment_webhooks(id) ON DELETE CASCADE,
    webhook_revision BIGINT NOT NULL CHECK (webhook_revision > 0),
    status TEXT NOT NULL CHECK (
        status IN (
            'queued', 'claimed', 'running', 'succeeded', 'failed', 'skipped'
        )
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
    overlap_policy TEXT NOT NULL CHECK (overlap_policy IN ('queue', 'skip')),
    session_id TEXT,
    native_turn_id TEXT,
    request_id TEXT NOT NULL,
    client_message_id TEXT NOT NULL,
    stable_input_id TEXT NOT NULL,
    event_count INTEGER NOT NULL CHECK (event_count > 0),
    event_types JSONB NOT NULL CHECK (jsonb_typeof(event_types) = 'array'),
    not_before TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    dispatch_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (dispatch_attempt_count >= 0),
    error TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_message_id),
    CHECK (
        target_kind = 'new_session'
        OR target_session_id IS NOT NULL
    )
);

CREATE INDEX environment_webhook_runs_dispatch_idx
    ON environment_webhook_runs (
        COALESCE(lease_expires_at, not_before), created_at, id
    )
    WHERE status IN ('queued', 'claimed', 'running');
CREATE INDEX environment_webhook_runs_history_idx
    ON environment_webhook_runs (webhook_id, created_at DESC, id DESC);

CREATE TRIGGER environment_webhook_runs_set_updated_at
    BEFORE UPDATE ON environment_webhook_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE environment_webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL
        REFERENCES environment_webhooks(id) ON DELETE CASCADE,
    provider_delivery_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 200),
    group_key TEXT NOT NULL CHECK (char_length(group_key) BETWEEN 1 AND 500),
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'batched', 'filtered', 'suppressed')
    ),
    normalized_event JSONB NOT NULL,
    run_id TEXT REFERENCES environment_webhook_runs(id) ON DELETE SET NULL,
    reason TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (webhook_id, provider_delivery_id)
);

CREATE INDEX environment_webhook_deliveries_history_idx
    ON environment_webhook_deliveries (
        webhook_id, received_at DESC, id DESC
    );

CREATE TRIGGER environment_webhook_deliveries_set_updated_at
    BEFORE UPDATE ON environment_webhook_deliveries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE environment_webhook_cooldown_buckets (
    webhook_id TEXT NOT NULL
        REFERENCES environment_webhooks(id) ON DELETE CASCADE,
    group_key TEXT NOT NULL,
    webhook_revision BIGINT NOT NULL CHECK (webhook_revision > 0),
    mode TEXT NOT NULL CHECK (mode IN ('throttle', 'debounce', 'batch')),
    behavior TEXT NOT NULL CHECK (behavior IN ('suppress', 'latest', 'merge')),
    duration_seconds INTEGER NOT NULL
        CHECK (duration_seconds BETWEEN 1 AND 86400),
    due_at TIMESTAMPTZ NOT NULL,
    configuration JSONB NOT NULL,
    events JSONB NOT NULL DEFAULT '[]'::JSONB
        CHECK (jsonb_typeof(events) = 'array'),
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    truncated_event_count INTEGER NOT NULL DEFAULT 0
        CHECK (truncated_event_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (webhook_id, group_key)
);

CREATE INDEX environment_webhook_cooldown_due_idx
    ON environment_webhook_cooldown_buckets (due_at, webhook_id, group_key);

CREATE INDEX environment_webhook_deliveries_batched_group_idx
    ON environment_webhook_deliveries (webhook_id, group_key)
    WHERE status = 'batched';

CREATE TRIGGER environment_webhook_cooldown_buckets_set_updated_at
    BEFORE UPDATE ON environment_webhook_cooldown_buckets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE environment_webhook_trigger_states (
    webhook_id TEXT NOT NULL
        REFERENCES environment_webhooks(id) ON DELETE CASCADE,
    group_key TEXT NOT NULL,
    state_value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (webhook_id, group_key)
);

CREATE FUNCTION disable_environment_webhooks_for_deleted_session()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE environment_webhooks
    SET enabled = FALSE,
        last_error = 'The target Session was deleted.',
        revision = revision + 1
    WHERE target_kind = 'session'
      AND target_session_id = OLD.id
      AND deleted_at IS NULL;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_disable_environment_webhooks
    BEFORE DELETE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION disable_environment_webhooks_for_deleted_session();

CREATE FUNCTION disable_environment_webhooks_for_archived_session()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE environment_webhooks
    SET enabled = FALSE,
        last_error = 'The target Session was archived.',
        revision = revision + 1
    WHERE target_kind = 'session'
      AND target_session_id = NEW.id
      AND deleted_at IS NULL;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_disable_environment_webhooks_on_archive
    BEFORE UPDATE OF archived ON sessions
    FOR EACH ROW
    WHEN (NEW.archived = TRUE AND OLD.archived = FALSE)
    EXECUTE FUNCTION disable_environment_webhooks_for_archived_session();

COMMENT ON TABLE environment_webhooks IS
    'Environment-owned external Automation trigger definitions and encrypted ingress secrets.';
COMMENT ON TABLE environment_webhook_deliveries IS
    'Verified and deduplicated inbound delivery ledger; a delivery need not produce a native Turn.';
COMMENT ON TABLE environment_webhook_cooldown_buckets IS
    'Durable throttle, debounce, and batch windows with immutable execution configuration snapshots.';
COMMENT ON TABLE environment_webhook_runs IS
    'Crash-safe native Turn delivery ledger generated from one or more accepted webhook deliveries.';

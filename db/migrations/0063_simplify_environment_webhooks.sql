-- Webhooks have not been released to users. Replace the generic rule engine
-- with the smaller product contract instead of carrying compatibility state.

DELETE FROM environment_webhooks;

DROP TABLE environment_webhook_trigger_states;
DROP TABLE environment_webhook_cooldown_buckets;

ALTER TABLE environment_webhooks
    DROP COLUMN trigger_mode,
    DROP COLUMN event_types,
    DROP COLUMN conditions,
    DROP COLUMN state_path,
    DROP COLUMN group_key_path,
    DROP COLUMN cooldown_mode,
    DROP COLUMN cooldown_seconds,
    DROP COLUMN cooldown_behavior,
    DROP COLUMN overlap_policy,
    DROP COLUMN max_concurrent_runs,
    DROP COLUMN max_pending_runs,
    ADD COLUMN batch_window_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (batch_window_seconds BETWEEN 0 AND 86400);

ALTER TABLE environment_webhook_runs
    DROP COLUMN overlap_policy;

ALTER TABLE environment_webhook_github_sources
    ADD COLUMN event_types JSONB NOT NULL,
    ADD CONSTRAINT environment_webhook_github_sources_event_types_check CHECK (
        jsonb_typeof(event_types) = 'array'
        AND jsonb_array_length(event_types) BETWEEN 1 AND 100
    );

ALTER TABLE environment_webhooks
    DROP CONSTRAINT environment_webhooks_last_delivery_status_check,
    ADD CONSTRAINT environment_webhooks_last_delivery_status_check CHECK (
        last_delivery_status IS NULL
        OR last_delivery_status IN ('queued', 'batched', 'duplicate')
    );

ALTER TABLE environment_webhook_deliveries
    DROP CONSTRAINT environment_webhook_deliveries_status_check,
    DROP COLUMN reason,
    ADD CONSTRAINT environment_webhook_deliveries_status_check CHECK (
        status IN ('queued', 'batched')
    );

CREATE TABLE environment_webhook_batch_buckets (
    webhook_id TEXT NOT NULL
        REFERENCES environment_webhooks(id) ON DELETE CASCADE,
    group_key TEXT NOT NULL,
    webhook_revision BIGINT NOT NULL CHECK (webhook_revision > 0),
    due_at TIMESTAMPTZ NOT NULL,
    configuration JSONB NOT NULL,
    events JSONB NOT NULL DEFAULT '[]'::JSONB
        CHECK (jsonb_typeof(events) = 'array'),
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count > 0),
    truncated_event_count INTEGER NOT NULL DEFAULT 0
        CHECK (truncated_event_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (webhook_id, group_key)
);

CREATE INDEX environment_webhook_batch_due_idx
    ON environment_webhook_batch_buckets (due_at, webhook_id, group_key);

CREATE TRIGGER environment_webhook_batch_buckets_set_updated_at
    BEFORE UPDATE ON environment_webhook_batch_buckets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE environment_webhook_batch_buckets IS
    'One fixed merge window per Webhook event group with an immutable execution snapshot.';

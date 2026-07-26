-- Sandpi owns user subscriptions and entitlement enforcement. Sandbox0 remains
-- the usage-truth producer; imported windows below are a consumer projection.

CREATE TABLE stripe_customers (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    stripe_customer_id TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER stripe_customers_set_updated_at
    BEFORE UPDATE ON stripe_customers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_subscriptions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    stripe_subscription_id TEXT NOT NULL UNIQUE,
    stripe_price_id TEXT NOT NULL,
    plan_id TEXT NOT NULL CHECK (plan_id IN ('plus', 'pro')),
    status TEXT NOT NULL CHECK (status IN (
        'incomplete',
        'incomplete_expired',
        'trialing',
        'active',
        'past_due',
        'canceled',
        'unpaid',
        'paused'
    )),
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    current_period_starts_at TIMESTAMPTZ,
    current_period_ends_at TIMESTAMPTZ,
    quota_anchor_at TIMESTAMPTZ,
    grace_ends_at TIMESTAMPTZ,
    pending_plan_id TEXT CHECK (pending_plan_id IN ('plus', 'pro')),
    pending_price_id TEXT,
    pending_effective_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        current_period_starts_at IS NULL
        OR current_period_ends_at IS NULL
        OR current_period_ends_at > current_period_starts_at
    ),
    CHECK (
        (pending_plan_id IS NULL
         AND pending_price_id IS NULL
         AND pending_effective_at IS NULL)
        OR
        (pending_plan_id IS NOT NULL
         AND pending_price_id IS NOT NULL
         AND pending_effective_at IS NOT NULL)
    )
);

CREATE INDEX user_subscriptions_status_idx
    ON user_subscriptions (status, updated_at);

CREATE TRIGGER user_subscriptions_set_updated_at
    BEFORE UPDATE ON user_subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stripe_webhook_events (
    stripe_event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    processing_error TEXT,
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE sandbox_usage_attributions (
    sandbox_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at TIMESTAMPTZ
);

CREATE INDEX sandbox_usage_attributions_user_idx
    ON sandbox_usage_attributions (user_id, allocated_at);

CREATE TABLE sandbox_runtime_segments (
    id BIGSERIAL PRIMARY KEY,
    sandbox_id TEXT NOT NULL REFERENCES sandbox_usage_attributions(sandbox_id)
        ON DELETE RESTRICT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
    memory_mib INTEGER NOT NULL CHECK (memory_mib > 0),
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX sandbox_runtime_segments_open_idx
    ON sandbox_runtime_segments (sandbox_id)
    WHERE ended_at IS NULL;

CREATE INDEX sandbox_runtime_segments_usage_idx
    ON sandbox_runtime_segments (user_id, started_at, ended_at);

CREATE TABLE sandbox_usage_windows (
    window_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
    sandbox_id TEXT NOT NULL REFERENCES sandbox_usage_attributions(sandbox_id)
        ON DELETE RESTRICT,
    window_type TEXT NOT NULL,
    window_starts_at TIMESTAMPTZ NOT NULL,
    window_ends_at TIMESTAMPTZ NOT NULL,
    value BIGINT NOT NULL CHECK (value >= 0),
    unit TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (window_ends_at >= window_starts_at)
);

CREATE INDEX sandbox_usage_windows_period_idx
    ON sandbox_usage_windows (user_id, window_starts_at, window_ends_at);

CREATE TABLE usage_import_cursors (
    source TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE environment_pause_intervals
    DROP CONSTRAINT environment_pause_intervals_reason_check,
    ADD CONSTRAINT environment_pause_intervals_reason_check
        CHECK (reason IN ('idle', 'quota'));

ALTER TABLE environment_runtime
    ADD COLUMN pause_reason TEXT NOT NULL DEFAULT 'idle'
        CHECK (pause_reason IN ('idle', 'quota'));

CREATE OR REPLACE FUNCTION project_environment_pause_interval()
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
                paused_at,
                reason
            )
            VALUES (
                NEW.environment_id,
                NEW.paused_at,
                NEW.pause_reason
            )
            ON CONFLICT (environment_id, paused_at) DO UPDATE
            SET reason = EXCLUDED.reason;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

INSERT INTO sandbox_usage_attributions (
    sandbox_id,
    user_id,
    environment_id,
    allocated_at
)
SELECT
    runtime.sandbox_id,
    environment.created_by_user_id,
    environment.id,
    LEAST(environment.created_at, runtime.created_at)
FROM environment_runtime runtime
JOIN environments environment ON environment.id = runtime.environment_id
WHERE runtime.sandbox_id IS NOT NULL
ON CONFLICT (sandbox_id) DO NOTHING;

INSERT INTO sandbox_runtime_segments (
    sandbox_id,
    user_id,
    environment_id,
    memory_mib,
    started_at
)
SELECT
    runtime.sandbox_id,
    environment.created_by_user_id,
    environment.id,
    environment.sandbox_memory_mib,
    LEAST(runtime.updated_at, NOW())
FROM environment_runtime runtime
JOIN environments environment ON environment.id = runtime.environment_id
WHERE runtime.sandbox_id IS NOT NULL
  AND runtime.observed_state = 'running'
ON CONFLICT (sandbox_id) WHERE ended_at IS NULL DO NOTHING;

CREATE FUNCTION project_sandbox_runtime_usage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    owner_id TEXT;
    memory_limit_mib INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.sandbox_id IS NOT NULL AND OLD.observed_state = 'running' THEN
            UPDATE sandbox_runtime_segments
            SET ended_at = GREATEST(NOW(), started_at)
            WHERE sandbox_id = OLD.sandbox_id
              AND ended_at IS NULL;
        END IF;
        IF OLD.sandbox_id IS NOT NULL THEN
            UPDATE sandbox_usage_attributions
            SET released_at = COALESCE(released_at, NOW())
            WHERE sandbox_id = OLD.sandbox_id;
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.sandbox_id IS NOT NULL
       AND OLD.observed_state = 'running'
       AND (
           NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id
           OR NEW.observed_state <> 'running'
       )
    THEN
        UPDATE sandbox_runtime_segments
        SET ended_at = GREATEST(NOW(), started_at)
        WHERE sandbox_id = OLD.sandbox_id
          AND ended_at IS NULL;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.sandbox_id IS NOT NULL
       AND NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id
    THEN
        UPDATE sandbox_usage_attributions
        SET released_at = COALESCE(released_at, NOW())
        WHERE sandbox_id = OLD.sandbox_id;
    END IF;

    IF NEW.sandbox_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT created_by_user_id, sandbox_memory_mib
    INTO owner_id, memory_limit_mib
    FROM environments
    WHERE id = NEW.environment_id;

    INSERT INTO sandbox_usage_attributions (
        sandbox_id,
        user_id,
        environment_id
    )
    VALUES (NEW.sandbox_id, owner_id, NEW.environment_id)
    ON CONFLICT (sandbox_id) DO UPDATE
    SET environment_id = EXCLUDED.environment_id,
        released_at = NULL
    WHERE sandbox_usage_attributions.user_id = EXCLUDED.user_id;

    IF NEW.observed_state = 'running'
       AND (
           TG_OP = 'INSERT'
           OR OLD.sandbox_id IS DISTINCT FROM NEW.sandbox_id
           OR OLD.observed_state <> 'running'
       )
    THEN
        INSERT INTO sandbox_runtime_segments (
            sandbox_id,
            user_id,
            environment_id,
            memory_mib,
            started_at
        )
        VALUES (
            NEW.sandbox_id,
            owner_id,
            NEW.environment_id,
            memory_limit_mib,
            NOW()
        )
        ON CONFLICT (sandbox_id) WHERE ended_at IS NULL DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER environment_runtime_project_usage_upsert
    AFTER INSERT OR UPDATE OF sandbox_id, observed_state
    ON environment_runtime
    FOR EACH ROW
    EXECUTE FUNCTION project_sandbox_runtime_usage();

CREATE TRIGGER environment_runtime_project_usage_delete
    BEFORE DELETE ON environment_runtime
    FOR EACH ROW
    EXECUTE FUNCTION project_sandbox_runtime_usage();

CREATE FUNCTION project_sandbox_memory_usage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    runtime_sandbox_id TEXT;
    runtime_observed_state TEXT;
BEGIN
    IF OLD.sandbox_memory_mib = NEW.sandbox_memory_mib THEN
        RETURN NEW;
    END IF;

    SELECT sandbox_id, observed_state
    INTO runtime_sandbox_id, runtime_observed_state
    FROM environment_runtime
    WHERE environment_id = NEW.id;

    IF runtime_sandbox_id IS NULL OR runtime_observed_state <> 'running' THEN
        RETURN NEW;
    END IF;

    UPDATE sandbox_runtime_segments
    SET ended_at = GREATEST(NOW(), started_at)
    WHERE sandbox_id = runtime_sandbox_id
      AND ended_at IS NULL;

    INSERT INTO sandbox_runtime_segments (
        sandbox_id,
        user_id,
        environment_id,
        memory_mib,
        started_at
    )
    VALUES (
        runtime_sandbox_id,
        NEW.created_by_user_id,
        NEW.id,
        NEW.sandbox_memory_mib,
        NOW()
    );

    RETURN NEW;
END;
$$;

CREATE TRIGGER environments_project_memory_usage
    AFTER UPDATE OF sandbox_memory_mib ON environments
    FOR EACH ROW
    EXECUTE FUNCTION project_sandbox_memory_usage();

COMMENT ON TABLE sandbox_usage_windows IS
    'Consumer projection of immutable team-scoped usage windows read through the public Sandbox0 SDK; Sandbox0 remains usage truth.';
COMMENT ON TABLE sandbox_runtime_segments IS
    'Sandpi-local runtime projection used only for timely quota admission while closed Sandbox0 usage windows are eventually consistent.';

-- GitHub is a Webhook-owned direct event source. Provider installations and
-- repository bindings stay separate from generic bearer-token ingress while
-- sharing the existing delivery, cooldown, and Automation run ledgers.

ALTER TABLE environment_webhooks
    ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'custom'
        CHECK (source_kind IN ('custom', 'github'));

ALTER TABLE environment_webhooks
    ALTER COLUMN endpoint_id DROP NOT NULL,
    ALTER COLUMN secret_ciphertext DROP NOT NULL,
    ALTER COLUMN secret_initialization_vector DROP NOT NULL,
    ALTER COLUMN secret_authentication_tag DROP NOT NULL,
    ALTER COLUMN secret_algorithm DROP NOT NULL,
    ALTER COLUMN secret_key_id DROP NOT NULL;

ALTER TABLE environment_webhooks
    ADD CONSTRAINT environment_webhooks_source_configuration_check CHECK (
        (
            source_kind = 'custom'
            AND endpoint_id IS NOT NULL
            AND secret_ciphertext IS NOT NULL
            AND secret_initialization_vector IS NOT NULL
            AND secret_authentication_tag IS NOT NULL
            AND secret_algorithm IS NOT NULL
            AND secret_key_id IS NOT NULL
        )
        OR (
            source_kind = 'github'
            AND endpoint_id IS NULL
            AND secret_ciphertext IS NULL
            AND secret_initialization_vector IS NULL
            AND secret_authentication_tag IS NULL
            AND secret_algorithm IS NULL
            AND secret_key_id IS NULL
        )
    );

CREATE TABLE webhook_github_connections (
    id TEXT PRIMARY KEY,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL CHECK (installation_id ~ '^[0-9]+$'),
    account_id TEXT NOT NULL CHECK (account_id ~ '^[0-9]+$'),
    account_login TEXT NOT NULL CHECK (char_length(account_login) BETWEEN 1 AND 255),
    account_type TEXT NOT NULL CHECK (char_length(account_type) BETWEEN 1 AND 100),
    repository_selection TEXT NOT NULL
        CHECK (repository_selection IN ('all', 'selected')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'revoked', 'disconnected')),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (created_by_user_id, installation_id)
);

CREATE INDEX webhook_github_connections_installation_idx
    ON webhook_github_connections (installation_id, status);

CREATE TRIGGER webhook_github_connections_set_updated_at
    BEFORE UPDATE ON webhook_github_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE webhook_github_repositories (
    connection_id TEXT NOT NULL
        REFERENCES webhook_github_connections(id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL CHECK (repository_id ~ '^[0-9]+$'),
    full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 500),
    private BOOLEAN NOT NULL,
    default_branch TEXT CHECK (
        default_branch IS NULL OR char_length(default_branch) BETWEEN 1 AND 500
    ),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (connection_id, repository_id)
);

CREATE TABLE webhook_github_connection_attempts (
    state_digest BYTEA PRIMARY KEY,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (created_by_user_id, environment_id)
);

CREATE INDEX webhook_github_connection_attempts_expiry_idx
    ON webhook_github_connection_attempts (expires_at);

CREATE TABLE environment_webhook_github_sources (
    webhook_id TEXT PRIMARY KEY
        REFERENCES environment_webhooks(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL
        REFERENCES webhook_github_connections(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER environment_webhook_github_sources_set_updated_at
    BEFORE UPDATE ON environment_webhook_github_sources
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE environment_webhook_github_repositories (
    webhook_id TEXT NOT NULL
        REFERENCES environment_webhook_github_sources(webhook_id)
        ON DELETE CASCADE,
    repository_id TEXT NOT NULL CHECK (repository_id ~ '^[0-9]+$'),
    PRIMARY KEY (webhook_id, repository_id)
);

CREATE INDEX environment_webhook_github_repositories_route_idx
    ON environment_webhook_github_repositories (repository_id, webhook_id);

CREATE TABLE webhook_github_receipts (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL UNIQUE
        CHECK (char_length(delivery_id) BETWEEN 1 AND 200),
    event_name TEXT NOT NULL CHECK (char_length(event_name) BETWEEN 1 AND 200),
    action TEXT CHECK (action IS NULL OR char_length(action) BETWEEN 1 AND 200),
    installation_id TEXT CHECK (
        installation_id IS NULL OR installation_id ~ '^[0-9]+$'
    ),
    repository_id TEXT CHECK (
        repository_id IS NULL OR repository_id ~ '^[0-9]+$'
    ),
    payload JSONB,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'completed', 'ignored', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    not_before TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX webhook_github_receipts_dispatch_idx
    ON webhook_github_receipts (
        COALESCE(lease_expires_at, not_before), received_at, id
    )
    WHERE status IN ('queued', 'processing');

CREATE TRIGGER webhook_github_receipts_set_updated_at
    BEFORE UPDATE ON webhook_github_receipts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE environment_webhook_session_bindings (
    webhook_id TEXT NOT NULL
        REFERENCES environment_webhooks(id) ON DELETE CASCADE,
    group_key TEXT NOT NULL CHECK (char_length(group_key) BETWEEN 1 AND 500),
    session_id TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (webhook_id, group_key)
);

CREATE INDEX environment_webhook_session_bindings_session_idx
    ON environment_webhook_session_bindings (session_id);

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'environment_webhooks'::REGCLASS
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%target_kind%new_session%session%'
    LOOP
        EXECUTE FORMAT(
            'ALTER TABLE environment_webhooks DROP CONSTRAINT %I',
            constraint_name
        );
    END LOOP;
END $$;

ALTER TABLE environment_webhooks
    ADD CONSTRAINT environment_webhooks_target_kind_check
        CHECK (target_kind IN ('new_session', 'source_thread', 'session')),
    ADD CONSTRAINT environment_webhooks_target_configuration_check CHECK (
        (target_kind IN ('new_session', 'source_thread') AND target_session_id IS NULL)
        OR (target_kind = 'session' AND target_session_id IS NOT NULL)
    );

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'environment_webhook_runs'::REGCLASS
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%target_kind%new_session%session%'
    LOOP
        EXECUTE FORMAT(
            'ALTER TABLE environment_webhook_runs DROP CONSTRAINT %I',
            constraint_name
        );
    END LOOP;
END $$;

ALTER TABLE environment_webhook_runs
    ADD CONSTRAINT environment_webhook_runs_target_kind_check
        CHECK (target_kind IN ('new_session', 'source_thread', 'session')),
    ADD CONSTRAINT environment_webhook_runs_target_configuration_check CHECK (
        (target_kind IN ('new_session', 'source_thread') AND target_session_id IS NULL)
        OR (target_kind = 'session' AND target_session_id IS NOT NULL)
    );

CREATE FUNCTION remove_environment_webhook_session_binding()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM environment_webhook_session_bindings
    WHERE session_id = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_remove_environment_webhook_binding
    BEFORE DELETE ON sessions
    FOR EACH ROW EXECUTE FUNCTION remove_environment_webhook_session_binding();

CREATE FUNCTION remove_archived_environment_webhook_session_binding()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM environment_webhook_session_bindings
    WHERE session_id = NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_remove_environment_webhook_binding_on_archive
    BEFORE UPDATE OF archived ON sessions
    FOR EACH ROW
    WHEN (NEW.archived = TRUE AND OLD.archived = FALSE)
    EXECUTE FUNCTION remove_archived_environment_webhook_session_binding();

COMMENT ON TABLE webhook_github_connections IS
    'Webhook-only GitHub App installations proven through a Sandpi user authorization flow.';
COMMENT ON TABLE webhook_github_receipts IS
    'Verified GitHub App deliveries awaiting idempotent fan-out to Environment Webhooks.';
COMMENT ON TABLE environment_webhook_session_bindings IS
    'Durable external event group to native product Session routing for Webhooks.';

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$;

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar_initials TEXT NOT NULL,
    identity_provider TEXT NOT NULL,
    identity_subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (identity_provider, identity_subject)
);

CREATE UNIQUE INDEX users_email_lower_unique
    ON users (LOWER(email));

CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    billing_account_id TEXT NOT NULL UNIQUE,
    billing_status TEXT NOT NULL DEFAULT 'deployment-managed'
        CHECK (billing_status IN ('public-beta', 'active', 'past-due', 'deployment-managed')),
    billing_cadence TEXT NOT NULL DEFAULT 'monthly'
        CHECK (billing_cadence = 'monthly'),
    billing_email TEXT NOT NULL,
    billing_period_starts_at TIMESTAMPTZ NOT NULL,
    billing_period_ends_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (billing_period_ends_at > billing_period_starts_at)
);

CREATE TABLE team_memberships (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'invited')),
    plan_assignment_id TEXT NOT NULL UNIQUE,
    plan_id TEXT NOT NULL DEFAULT 'free'
        CHECK (plan_id IN ('free', 'pro', 'max')),
    plan_status TEXT NOT NULL DEFAULT 'active'
        CHECK (plan_status IN ('active', 'pending', 'suspended')),
    plan_period_starts_at TIMESTAMPTZ NOT NULL,
    plan_period_ends_at TIMESTAMPTZ NOT NULL,
    plan_quotas JSONB NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (team_id, user_id),
    CHECK (plan_period_ends_at > plan_period_starts_at),
    CHECK (jsonb_typeof(plan_quotas) = 'object')
);

COMMENT ON TABLE team_memberships IS
    'Plan assignments belong to memberships. Teams sponsor their members but do not own a plan.';

CREATE INDEX team_memberships_team_status_idx
    ON team_memberships (team_id, status);
CREATE INDEX team_memberships_user_status_idx
    ON team_memberships (user_id, status);

CREATE TABLE user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    language TEXT NOT NULL DEFAULT 'en'
        CHECK (language IN ('en', 'zh-CN')),
    time_zone TEXT NOT NULL DEFAULT 'UTC',
    send_shortcut TEXT NOT NULL DEFAULT 'enter'
        CHECK (send_shortcut IN ('enter', 'mod-enter')),
    theme TEXT NOT NULL DEFAULT 'system'
        CHECK (theme IN ('system', 'light', 'dark')),
    density TEXT NOT NULL DEFAULT 'comfortable'
        CHECK (density IN ('comfortable', 'compact')),
    notify_session_completed BOOLEAN NOT NULL DEFAULT TRUE,
    notify_needs_attention BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE environments (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'updating'
        CHECK (status IN ('updating', 'ready', 'error', 'archived')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    template_id TEXT,
    rootfs_snapshot_id TEXT,
    workspace_volume_id TEXT,
    credential_revision INTEGER NOT NULL DEFAULT 0 CHECK (credential_revision >= 0),
    harness TEXT NOT NULL DEFAULT 'codex',
    harness_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    network_policy JSONB NOT NULL DEFAULT '{"mode":"restricted","allowedDomains":[],"logDeniedRequests":true}'::JSONB,
    functions JSONB NOT NULL DEFAULT '[]'::JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    provisioning_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (jsonb_typeof(harness_metadata) = 'object'),
    CHECK (jsonb_typeof(network_policy) = 'object'),
    CHECK (jsonb_typeof(functions) = 'array'),
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX environments_team_status_idx
    ON environments (team_id, status, updated_at DESC);

CREATE TABLE harness_credentials (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    harness TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    credential_type TEXT NOT NULL,
    ciphertext BYTEA NOT NULL,
    initialization_vector BYTEA NOT NULL,
    authentication_tag BYTEA NOT NULL,
    encryption_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    encryption_key_id TEXT NOT NULL,
    non_secret_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    expires_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (environment_id, harness, revision),
    CHECK (jsonb_typeof(non_secret_metadata) = 'object')
);

COMMENT ON TABLE harness_credentials IS
    'Only encrypted native harness credentials are persisted. Plaintext credentials must never enter PostgreSQL.';

CREATE UNIQUE INDEX harness_credentials_one_active_idx
    ON harness_credentials (environment_id, harness)
    WHERE revoked_at IS NULL;

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE RESTRICT,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paused'
        CHECK (status IN ('provisioning', 'running', 'waiting', 'paused', 'completed', 'failed')),
    unread BOOLEAN NOT NULL DEFAULT FALSE,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    harness TEXT NOT NULL,
    harness_state JSONB NOT NULL DEFAULT '{}'::JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    environment_revision INTEGER NOT NULL CHECK (environment_revision > 0),
    workspace_root TEXT NOT NULL DEFAULT '/workspace',
    rootfs_snapshot_id TEXT,
    origin_kind TEXT CHECK (origin_kind IN ('environment', 'session', 'turn')),
    origin_label TEXT,
    source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    source_native_item_id TEXT,
    hard_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (jsonb_typeof(harness_state) = 'object'),
    CHECK (jsonb_typeof(metadata) = 'object'),
    CHECK (hard_expires_at > created_at)
);

CREATE INDEX sessions_environment_list_idx
    ON sessions (environment_id, archived, pinned DESC, updated_at DESC);
CREATE INDEX sessions_team_status_idx
    ON sessions (team_id, status, updated_at DESC);
CREATE INDEX sessions_hard_expires_idx
    ON sessions (hard_expires_at)
    WHERE status NOT IN ('completed', 'failed');

CREATE TABLE session_runtime (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    sandbox_id TEXT,
    workspace_volume_id TEXT,
    supervisor_session_id TEXT,
    terminal_session_id TEXT,
    supervisor_cursor BIGINT NOT NULL DEFAULT 0 CHECK (supervisor_cursor >= 0),
    stdout_tail TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    model_id TEXT,
    attempt_id TEXT,
    runtime_generation BIGINT NOT NULL DEFAULT 0 CHECK (runtime_generation >= 0),
    desired_state TEXT NOT NULL DEFAULT 'running'
        CHECK (desired_state IN ('running', 'paused', 'terminated')),
    observed_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (observed_state IN ('pending', 'provisioning', 'running', 'paused', 'terminated', 'failed')),
    provisioning_error TEXT,
    last_event_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX session_runtime_sandbox_unique_idx
    ON session_runtime (sandbox_id)
    WHERE sandbox_id IS NOT NULL;
CREATE INDEX session_runtime_supervisor_idx
    ON session_runtime (supervisor_session_id)
    WHERE supervisor_session_id IS NOT NULL;

CREATE TABLE harness_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence >= 0),
    harness TEXT NOT NULL,
    harness_version TEXT NOT NULL,
    protocol_version TEXT NOT NULL,
    runtime_generation BIGINT NOT NULL DEFAULT 0 CHECK (runtime_generation >= 0),
    attempt_id TEXT,
    received_at TIMESTAMPTZ NOT NULL,
    notification JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (session_id, sequence),
    CHECK (jsonb_typeof(notification) = 'object')
);

CREATE INDEX harness_events_session_replay_idx
    ON harness_events (session_id, sequence);
CREATE INDEX harness_events_received_idx
    ON harness_events (received_at);

CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    active_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    authentication_method TEXT NOT NULL CHECK (authentication_method IN ('builtin', 'oidc')),
    token_hash BYTEA NOT NULL UNIQUE,
    csrf_token_hash BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    client_ip INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_active_idx
    ON auth_sessions (user_id, expires_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE oidc_states (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    state_hash BYTEA NOT NULL UNIQUE,
    nonce_hash BYTEA NOT NULL,
    code_verifier_ciphertext BYTEA NOT NULL,
    code_verifier_initialization_vector BYTEA NOT NULL,
    code_verifier_authentication_tag BYTEA NOT NULL,
    encryption_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    encryption_key_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    return_to TEXT NOT NULL DEFAULT '/',
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > created_at)
);

CREATE INDEX oidc_states_expiry_idx
    ON oidc_states (expires_at)
    WHERE consumed_at IS NULL;

CREATE TABLE idempotency_keys (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    operation TEXT NOT NULL,
    key_hash BYTEA NOT NULL,
    request_hash BYTEA NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'completed', 'failed')),
    response_status INTEGER,
    response_headers JSONB,
    response_body JSONB,
    resource_id TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (team_id, operation, key_hash),
    CHECK (response_headers IS NULL OR jsonb_typeof(response_headers) = 'object')
);

CREATE INDEX idempotency_keys_expiry_idx
    ON idempotency_keys (expires_at);

CREATE TABLE outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    topic TEXT NOT NULL,
    deduplication_key TEXT UNIQUE,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'published', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    locked_by TEXT,
    published_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX outbox_pending_delivery_idx
    ON outbox (available_at, id)
    WHERE status = 'pending';

DO $triggers$
DECLARE
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'users',
        'teams',
        'team_memberships',
        'user_preferences',
        'environments',
        'harness_credentials',
        'sessions',
        'session_runtime',
        'auth_sessions',
        'oidc_states',
        'idempotency_keys',
        'outbox'
    ]
    LOOP
        EXECUTE FORMAT(
            'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I '
            'FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            table_name,
            table_name
        );
    END LOOP;
END;
$triggers$;

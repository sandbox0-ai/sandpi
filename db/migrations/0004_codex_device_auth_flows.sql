CREATE TABLE codex_device_auth_flows (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL
        CHECK (status IN (
            'provisioning', 'starting', 'awaiting_user', 'completed',
            'failed', 'cancelled', 'expired'
        )),
    sandbox_id TEXT,
    supervisor_session_id TEXT,
    attempt_id TEXT,
    runtime_generation INTEGER NOT NULL DEFAULT 0 CHECK (runtime_generation >= 0),
    supervisor_cursor BIGINT NOT NULL DEFAULT 0 CHECK (supervisor_cursor >= 0),
    stdout_tail TEXT NOT NULL DEFAULT '',
    native_login_id TEXT,
    verification_url TEXT,
    user_code TEXT,
    protocol_messages JSONB NOT NULL DEFAULT '[]'::JSONB,
    error TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (jsonb_typeof(protocol_messages) = 'array'),
    CHECK (
        status <> 'awaiting_user'
        OR (
            native_login_id IS NOT NULL
            AND verification_url IS NOT NULL
            AND user_code IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX codex_device_auth_flows_one_active_idx
    ON codex_device_auth_flows (environment_id)
    WHERE status IN ('provisioning', 'starting', 'awaiting_user');

CREATE INDEX codex_device_auth_flows_resume_idx
    ON codex_device_auth_flows (status, expires_at)
    WHERE status IN ('starting', 'awaiting_user');

COMMENT ON TABLE codex_device_auth_flows IS
    'Durable coordination state for native Codex device-code login. This table never stores auth.json or bearer/refresh tokens.';

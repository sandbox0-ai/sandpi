CREATE TABLE native_auth_attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    client_state TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_hash BYTEA UNIQUE,
    return_to TEXT NOT NULL DEFAULT '/',
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (length(client_state) BETWEEN 32 AND 128),
    CHECK (length(code_challenge) = 43),
    CHECK (expires_at > created_at),
    CHECK (
        (user_id IS NULL AND code_hash IS NULL AND completed_at IS NULL)
        OR
        (user_id IS NOT NULL AND code_hash IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CHECK (consumed_at IS NULL OR completed_at IS NOT NULL)
);

CREATE INDEX native_auth_attempts_expiry_idx
    ON native_auth_attempts (expires_at)
    WHERE consumed_at IS NULL;

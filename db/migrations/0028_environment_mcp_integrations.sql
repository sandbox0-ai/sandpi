CREATE TABLE environment_mcp_integrations (
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    server_name TEXT NOT NULL,
    preset_id TEXT,
    auth_mode TEXT NOT NULL
        CHECK (auth_mode IN ('none', 'oauth', 'bearer', 'header')),
    credential_source_ref TEXT,
    credential_binding_ref TEXT,
    endpoint_fingerprint TEXT NOT NULL
        CHECK (
            length(endpoint_fingerprint) = 64
            AND endpoint_fingerprint ~ '^[0-9a-f]{64}$'
        ),
    destination_domain TEXT NOT NULL,
    destination_path TEXT NOT NULL DEFAULT '/',
    lifecycle_status TEXT NOT NULL DEFAULT 'provisioning'
        CHECK (
            lifecycle_status IN (
                'provisioning', 'active', 'updating', 'deleting', 'error'
            )
        ),
    credential_status TEXT NOT NULL DEFAULT 'missing'
        CHECK (
            credential_status IN (
                'not-required', 'missing', 'configured', 'authorizing',
                'authorized', 'reauth-required', 'error'
            )
        ),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (environment_id, server_name),
    CHECK (length(btrim(server_name)) > 0),
    CHECK (
        destination_domain = lower(btrim(destination_domain))
        AND destination_domain !~ '[/:?#*[:space:]]'
    ),
    CHECK (
        destination_path LIKE '/%'
        AND destination_path !~ '[?#]'
    ),
    CHECK (
        (credential_source_ref IS NULL)
        = (credential_binding_ref IS NULL)
    ),
    CHECK (
        auth_mode IN ('bearer', 'header')
        OR (
            credential_source_ref IS NULL
            AND credential_binding_ref IS NULL
        )
    ),
    CHECK (
        credential_status <> 'configured'
        OR (
            auth_mode IN ('bearer', 'header')
            AND credential_source_ref IS NOT NULL
            AND credential_binding_ref IS NOT NULL
        )
    ),
    CHECK (
        auth_mode <> 'none'
        OR credential_status = 'not-required'
    )
);

CREATE UNIQUE INDEX environment_mcp_integrations_source_ref_idx
    ON environment_mcp_integrations (credential_source_ref)
    WHERE credential_source_ref IS NOT NULL;

CREATE UNIQUE INDEX environment_mcp_integrations_binding_ref_idx
    ON environment_mcp_integrations (environment_id, credential_binding_ref)
    WHERE credential_binding_ref IS NOT NULL;

CREATE INDEX environment_mcp_integrations_lifecycle_idx
    ON environment_mcp_integrations (lifecycle_status, updated_at);

CREATE TRIGGER environment_mcp_integrations_set_updated_at
    BEFORE UPDATE ON environment_mcp_integrations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE environment_mcp_integrations IS
    'Non-sensitive coordination metadata for Environment-scoped MCP integrations. Native Codex configuration and Sandbox0 Credential Sources remain authoritative.';
COMMENT ON COLUMN environment_mcp_integrations.endpoint_fingerprint IS
    'SHA-256 fingerprint of the configured endpoint used to detect destination drift before reusing a credential association.';

CREATE TABLE environment_mcp_oauth_flows (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    server_name TEXT NOT NULL,
    config_fingerprint TEXT NOT NULL
        CHECK (
            length(config_fingerprint) = 64
            AND config_fingerprint ~ '^[0-9a-f]{64}$'
        ),
    status TEXT NOT NULL
        CHECK (
            status IN (
                'starting', 'awaiting_user', 'completed',
                'failed', 'cancelled', 'expired'
            )
        ),
    error TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (environment_id, server_name)
        REFERENCES environment_mcp_integrations(environment_id, server_name)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX environment_mcp_oauth_flows_one_active_idx
    ON environment_mcp_oauth_flows (environment_id)
    WHERE status IN ('starting', 'awaiting_user');

CREATE INDEX environment_mcp_oauth_flows_resume_idx
    ON environment_mcp_oauth_flows (status, expires_at)
    WHERE status IN ('starting', 'awaiting_user');

CREATE TRIGGER environment_mcp_oauth_flows_set_updated_at
    BEFORE UPDATE ON environment_mcp_oauth_flows
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE environment_mcp_oauth_flows IS
    'Coordination state for native Codex MCP authorization. Authorization material remains in the native runtime credential store.';

-- Sandbox0 egress credentials are Environment-owned Sandpi resources. Secret
-- material remains write-only in Sandbox0; this table stores only the desired
-- projection, destination and external-source reconciliation state.

CREATE TABLE environment_egress_credentials (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    source_ref TEXT NOT NULL UNIQUE,
    resolver_kind TEXT NOT NULL
        CHECK (
            resolver_kind IN (
                'static_headers',
                'static_tls_client_certificate',
                'static_username_password',
                'static_ssh_private_key'
            )
        ),
    projection JSONB NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
    rule JSONB NOT NULL CHECK (jsonb_typeof(rule) = 'object'),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    status TEXT NOT NULL DEFAULT 'provisioning'
        CHECK (status IN ('provisioning', 'active', 'error', 'deleting')),
    source_version BIGINT CHECK (source_version IS NULL OR source_version > 0),
    source_status TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (environment_id, display_name)
);

CREATE INDEX environment_egress_credentials_reconcile_idx
    ON environment_egress_credentials (status, environment_id);

CREATE INDEX environment_egress_credentials_environment_idx
    ON environment_egress_credentials (environment_id, created_at, id);

CREATE TRIGGER environment_egress_credentials_set_updated_at
    BEFORE UPDATE ON environment_egress_credentials
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE environment_egress_credentials IS
    'Secret-free Environment ownership and desired runtime state for Sandbox0 egress credential sources.';

COMMENT ON COLUMN environment_egress_credentials.source_ref IS
    'Opaque server-generated Sandbox0 credential source name; never accepted from a browser.';

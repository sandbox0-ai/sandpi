ALTER TABLE environment_mcp_integrations
    ADD COLUMN credential_header_name TEXT,
    ADD COLUMN credential_value_template TEXT;

ALTER TABLE environment_mcp_integrations
    ADD CONSTRAINT environment_mcp_integrations_projection_pair_check
    CHECK (
        (credential_header_name IS NULL)
        = (credential_value_template IS NULL)
    ),
    ADD CONSTRAINT environment_mcp_integrations_projection_auth_mode_check
    CHECK (
        auth_mode IN ('bearer', 'header')
        OR (
            credential_header_name IS NULL
            AND credential_value_template IS NULL
        )
    ),
    ADD CONSTRAINT environment_mcp_integrations_static_projection_check
    CHECK (
        auth_mode NOT IN ('bearer', 'header')
        OR (
            credential_header_name IS NOT NULL
            AND credential_header_name ~ '^[!#$%&''*+\-.^_`|~0-9A-Za-z]+$'
            AND credential_value_template IS NOT NULL
            AND credential_value_template
                ~ '^([A-Za-z][A-Za-z0-9._~-]{0,31} )?\{\{ \.token \}\}$'
        )
    ),
    ADD CONSTRAINT environment_mcp_integrations_bearer_projection_check
    CHECK (
        auth_mode <> 'bearer'
        OR (
            credential_header_name = 'Authorization'
            AND credential_value_template = 'Bearer {{ .token }}'
        )
    );

COMMENT ON COLUMN environment_mcp_integrations.credential_header_name IS
    'Non-sensitive outbound header name for the Sandbox0 HTTP header projection.';
COMMENT ON COLUMN environment_mcp_integrations.credential_value_template IS
    'Server-generated Sandbox0 token projection template; never a credential value.';

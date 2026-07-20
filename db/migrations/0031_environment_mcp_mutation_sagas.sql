ALTER TABLE environment_mcp_integrations
    ADD COLUMN version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    ADD COLUMN binding_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN pending_credential_source_ref TEXT,
    ADD COLUMN pending_credential_binding_ref TEXT,
    ADD COLUMN pending_credential_header_name TEXT,
    ADD COLUMN pending_credential_value_template TEXT,
    ADD COLUMN retiring_credential_source_ref TEXT,
    ADD COLUMN oauth_config_fingerprint TEXT;

UPDATE environment_mcp_integrations
SET binding_enabled = TRUE
WHERE auth_mode IN ('bearer', 'header')
  AND credential_source_ref IS NOT NULL
  AND credential_binding_ref IS NOT NULL
  AND credential_status IN ('configured', 'authorized')
  AND lifecycle_status <> 'deleting';

ALTER TABLE environment_mcp_integrations
    ADD CONSTRAINT environment_mcp_integrations_binding_enabled_check
    CHECK (
        NOT binding_enabled
        OR (
            auth_mode IN ('bearer', 'header')
            AND credential_source_ref IS NOT NULL
            AND credential_binding_ref IS NOT NULL
            AND credential_header_name IS NOT NULL
            AND credential_value_template IS NOT NULL
            AND credential_status IN ('configured', 'authorized')
        )
    ),
    ADD CONSTRAINT environment_mcp_integrations_pending_pair_check
    CHECK (
        num_nonnulls(
            pending_credential_source_ref,
            pending_credential_binding_ref,
            pending_credential_header_name,
            pending_credential_value_template
        ) IN (0, 4)
    ),
    ADD CONSTRAINT environment_mcp_integrations_pending_auth_mode_check
    CHECK (
        pending_credential_source_ref IS NULL
        OR auth_mode IN ('bearer', 'header')
    ),
    ADD CONSTRAINT environment_mcp_integrations_pending_projection_check
    CHECK (
        pending_credential_header_name IS NULL
        OR (
            pending_credential_header_name
                ~ '^[!#$%&''*+\-.^_`|~0-9A-Za-z]+$'
            AND pending_credential_value_template
                ~ '^([A-Za-z][A-Za-z0-9._~-]{0,31} )?\{\{ \.token \}\}$'
        )
    ),
    ADD CONSTRAINT environment_mcp_integrations_pending_bearer_check
    CHECK (
        auth_mode <> 'bearer'
        OR pending_credential_source_ref IS NULL
        OR (
            pending_credential_header_name = 'Authorization'
            AND pending_credential_value_template = 'Bearer {{ .token }}'
        )
    ),
    ADD CONSTRAINT environment_mcp_integrations_retiring_auth_mode_check
    CHECK (
        retiring_credential_source_ref IS NULL
        OR auth_mode IN ('bearer', 'header')
    ),
    ADD CONSTRAINT environment_mcp_integrations_saga_refs_distinct_check
    CHECK (
        pending_credential_source_ref IS NULL
        OR (
            pending_credential_source_ref
                IS DISTINCT FROM credential_source_ref
            AND pending_credential_binding_ref
                IS DISTINCT FROM credential_binding_ref
        )
    ),
    ADD CONSTRAINT environment_mcp_integrations_retiring_refs_distinct_check
    CHECK (
        retiring_credential_source_ref IS NULL
        OR (
            retiring_credential_source_ref
                IS DISTINCT FROM credential_source_ref
            AND retiring_credential_source_ref
                IS DISTINCT FROM pending_credential_source_ref
        )
    ),
    ADD CONSTRAINT environment_mcp_integrations_saga_lifecycle_check
    CHECK (
        (
            pending_credential_source_ref IS NULL
            AND retiring_credential_source_ref IS NULL
        )
        OR lifecycle_status IN ('updating', 'deleting', 'error')
    ),
    ADD CONSTRAINT environment_mcp_integrations_oauth_config_check
    CHECK (
        oauth_config_fingerprint IS NULL
        OR (
            auth_mode = 'oauth'
            AND length(oauth_config_fingerprint) = 64
            AND oauth_config_fingerprint ~ '^[0-9a-f]{64}$'
        )
    );

CREATE UNIQUE INDEX environment_mcp_integrations_pending_source_ref_idx
    ON environment_mcp_integrations (pending_credential_source_ref)
    WHERE pending_credential_source_ref IS NOT NULL;

CREATE UNIQUE INDEX environment_mcp_integrations_pending_binding_ref_idx
    ON environment_mcp_integrations (
        environment_id,
        pending_credential_binding_ref
    )
    WHERE pending_credential_binding_ref IS NOT NULL;

CREATE UNIQUE INDEX environment_mcp_integrations_retiring_source_ref_idx
    ON environment_mcp_integrations (retiring_credential_source_ref)
    WHERE retiring_credential_source_ref IS NOT NULL;

ALTER TABLE environment_mcp_oauth_flows
    ADD COLUMN endpoint_fingerprint TEXT,
    ADD COLUMN cleanup_completed_at TIMESTAMPTZ;

UPDATE environment_mcp_oauth_flows flow
SET endpoint_fingerprint = integration.endpoint_fingerprint
FROM environment_mcp_integrations integration
WHERE integration.environment_id = flow.environment_id
  AND integration.server_name = flow.server_name;

ALTER TABLE environment_mcp_oauth_flows
    ALTER COLUMN endpoint_fingerprint SET NOT NULL,
    ADD CONSTRAINT environment_mcp_oauth_flows_endpoint_fingerprint_check
    CHECK (
        length(endpoint_fingerprint) = 64
        AND endpoint_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    ADD CONSTRAINT environment_mcp_oauth_flows_cleanup_status_check
    CHECK (
        cleanup_completed_at IS NULL
        OR status IN ('cancelled', 'expired')
    );

UPDATE environment_mcp_oauth_flows
SET status = 'cancelled'
WHERE status IN ('starting', 'awaiting_user')
  AND expires_at <= NOW();

WITH ranked_blocking_flows AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY environment_id
            ORDER BY
                CASE
                    WHEN status IN ('starting', 'awaiting_user') THEN 0
                    ELSE 1
                END,
                created_at DESC,
                id DESC
        ) AS rank
    FROM environment_mcp_oauth_flows
    WHERE status IN ('starting', 'awaiting_user', 'cancelled')
)
UPDATE environment_mcp_oauth_flows flow
SET status = 'expired'
FROM ranked_blocking_flows ranked
WHERE flow.id = ranked.id
  AND ranked.rank > 1;

DROP INDEX environment_mcp_oauth_flows_one_active_idx;

CREATE UNIQUE INDEX environment_mcp_oauth_flows_one_blocking_idx
    ON environment_mcp_oauth_flows (environment_id)
    WHERE status IN ('starting', 'awaiting_user', 'cancelled');

CREATE INDEX environment_mcp_oauth_flows_cleanup_pending_idx
    ON environment_mcp_oauth_flows (created_at, id)
    WHERE status IN ('cancelled', 'expired')
      AND cleanup_completed_at IS NULL;

UPDATE environment_mcp_integrations integration
SET oauth_config_fingerprint = (
    SELECT flow.config_fingerprint
    FROM environment_mcp_oauth_flows flow
    WHERE flow.environment_id = integration.environment_id
      AND flow.server_name = integration.server_name
      AND (
          flow.status IN (
              'starting', 'awaiting_user', 'completed', 'cancelled'
          )
          OR (
              flow.status = 'expired'
              AND flow.cleanup_completed_at IS NULL
          )
      )
    ORDER BY flow.created_at DESC, flow.id DESC
    LIMIT 1
)
WHERE integration.auth_mode = 'oauth'
  AND EXISTS (
      SELECT 1
      FROM environment_mcp_oauth_flows flow
      WHERE flow.environment_id = integration.environment_id
        AND flow.server_name = integration.server_name
        AND (
            flow.status IN (
                'starting', 'awaiting_user', 'completed', 'cancelled'
            )
            OR (
                flow.status = 'expired'
                AND flow.cleanup_completed_at IS NULL
            )
        )
  );

COMMENT ON COLUMN environment_mcp_integrations.version IS
    'Monotonic compare-and-swap version for multi-replica MCP mutations.';
COMMENT ON COLUMN environment_mcp_integrations.binding_enabled IS
    'Explicit gate for including the current static credential binding in the effective network policy.';
COMMENT ON COLUMN environment_mcp_integrations.pending_credential_source_ref IS
    'Non-sensitive reference for an immutable static credential source awaiting policy promotion.';
COMMENT ON COLUMN environment_mcp_integrations.retiring_credential_source_ref IS
    'Previous immutable source awaiting deletion after the promoted policy is applied.';
COMMENT ON COLUMN environment_mcp_integrations.oauth_config_fingerprint IS
    'OAuth definition fingerprint authorized to mutate this integration from native notifications.';
COMMENT ON COLUMN environment_mcp_oauth_flows.cleanup_completed_at IS
    'Durable journal marker set only after strict native OAuth credential discard succeeds.';

-- Codex is the sole authority for MCP definitions, authentication and tools.
-- Sandpi retains no integration projection or MCP credential slot.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM environment_mcp_integrations
        WHERE credential_source_ref IS NOT NULL
           OR credential_binding_ref IS NOT NULL
           OR pending_credential_source_ref IS NOT NULL
           OR pending_credential_binding_ref IS NOT NULL
           OR retiring_credential_source_ref IS NOT NULL
           OR binding_enabled
           OR tool_policy_mode <> 'all'
           OR credential_status IN (
               'configured', 'authorizing', 'authorized', 'reauth-required'
           )
           OR oauth_config_fingerprint IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'Cannot remove legacy MCP integration state while external credentials, tool policies, or authorization are still active'
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM environment_mcp_oauth_flows
        WHERE cleanup_completed_at IS NULL
           OR (
               native_thread_id IS NOT NULL
               AND native_thread_cleanup_completed_at IS NULL
           )
    ) THEN
        RAISE EXCEPTION
            'Cannot remove legacy MCP OAuth state before native cleanup completes'
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

DELETE FROM environment_credential_bindings
WHERE harness = 'codex'
  AND credential_slot = 'mcp-oauth';

DELETE FROM harness_credentials
WHERE harness = 'codex'
  AND credential_slot = 'mcp-oauth';

DROP TABLE environment_mcp_oauth_events;
DROP TABLE environment_mcp_oauth_flows;
DROP TABLE environment_mcp_integrations;

ALTER TABLE harness_credentials
    DROP CONSTRAINT harness_credentials_codex_slot_check,
    ADD CONSTRAINT harness_credentials_codex_slot_check
    CHECK (
        harness <> 'codex'
        OR (
            credential_slot = 'account'
            AND credential_type = 'codex-native-auth-json'
        )
    );

ALTER TABLE environment_credential_bindings
    DROP CONSTRAINT environment_credential_bindings_codex_slot_check,
    ADD CONSTRAINT environment_credential_bindings_codex_slot_check
    CHECK (
        harness <> 'codex'
        OR (
            credential_slot = 'account'
            AND native_target_path = '/dev/shm/sandpi-codex-auth.json'
        )
    );

COMMENT ON COLUMN harness_credentials.credential_slot IS
    'Native credential file slot. Codex uses only the encrypted account auth slot.';

COMMENT ON COLUMN environment_credential_bindings.credential_slot IS
    'Native credential slot materialized for one Environment runtime. Codex uses only account auth.';

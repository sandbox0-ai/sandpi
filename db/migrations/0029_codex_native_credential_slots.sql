-- Codex account auth and MCP OAuth tokens are independent native credential
-- files. Each durable encrypted slot is materialized only into /dev/shm.

ALTER TABLE harness_credentials
    ADD COLUMN credential_slot TEXT NOT NULL DEFAULT 'account';

DROP INDEX harness_credentials_one_active_idx;

ALTER TABLE harness_credentials
    DROP CONSTRAINT harness_credentials_environment_id_harness_revision_key;

ALTER TABLE harness_credentials
    ADD CONSTRAINT harness_credentials_environment_harness_slot_revision_key
    UNIQUE (environment_id, harness, credential_slot, revision);

ALTER TABLE harness_credentials
    ADD CONSTRAINT harness_credentials_codex_slot_check
    CHECK (
        harness <> 'codex'
        OR (
            credential_slot = 'account'
            AND credential_type = 'codex-native-auth-json'
        )
        OR (
            credential_slot = 'mcp-oauth'
            AND credential_type = 'codex-mcp-oauth-json'
        )
    );

CREATE UNIQUE INDEX harness_credentials_one_active_slot_idx
    ON harness_credentials (environment_id, harness, credential_slot)
    WHERE revoked_at IS NULL;

ALTER TABLE environment_credential_bindings
    ADD COLUMN credential_slot TEXT NOT NULL DEFAULT 'account';

ALTER TABLE environment_credential_bindings
    DROP CONSTRAINT environment_credential_bindings_environment_id_key;

ALTER TABLE environment_credential_bindings
    ADD CONSTRAINT environment_credential_bindings_environment_harness_slot_key
    UNIQUE (environment_id, harness, credential_slot);

ALTER TABLE environment_credential_bindings
    ADD CONSTRAINT environment_credential_bindings_codex_slot_check
    CHECK (
        harness <> 'codex'
        OR (
            credential_slot = 'account'
            AND native_target_path = '/dev/shm/sandpi-codex-auth.json'
        )
        OR (
            credential_slot = 'mcp-oauth'
            AND native_target_path = '/dev/shm/sandpi-codex-mcp-oauth.json'
        )
    );

COMMENT ON COLUMN harness_credentials.credential_slot IS
    'Independent native credential file slot. Values are encrypted at rest and materialized only into the slot target.';

COMMENT ON COLUMN environment_credential_bindings.credential_slot IS
    'Native credential slot materialized at native_target_path for one Environment runtime.';

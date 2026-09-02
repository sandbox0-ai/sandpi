-- Claude Code and Pi use the same encrypted Environment credential authority
-- as Codex. Only the native account file is durable in PostgreSQL; the
-- plaintext projection remains in /dev/shm and cannot enter RootFS snapshots.

ALTER TABLE harness_credentials
    ADD CONSTRAINT harness_credentials_native_agent_account_check CHECK (
        harness NOT IN ('claude-code', 'pi')
        OR (
            credential_slot = 'account'
            AND credential_type = CASE harness
                WHEN 'claude-code' THEN 'claude-code-native-credentials-json'
                WHEN 'pi' THEN 'pi-native-auth-json'
            END
        )
    );

ALTER TABLE environment_credential_bindings
    ADD CONSTRAINT environment_credential_bindings_native_agent_account_check
    CHECK (
        harness NOT IN ('claude-code', 'pi')
        OR (
            credential_slot = 'account'
            AND native_target_path = CASE harness
                WHEN 'claude-code' THEN '/dev/shm/sandpi-claude-code-auth.json'
                WHEN 'pi' THEN '/dev/shm/sandpi-pi-auth.json'
            END
        )
    );

COMMENT ON CONSTRAINT harness_credentials_native_agent_account_check
    ON harness_credentials IS
    'Pins each native TUI agent account slot to its encrypted credential format.';
COMMENT ON CONSTRAINT environment_credential_bindings_native_agent_account_check
    ON environment_credential_bindings IS
    'Pins Claude Code and Pi account projections to memory-backed runtime paths.';

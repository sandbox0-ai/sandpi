-- Sandpi v2 promotes one native coding-agent TUI to the Environment runtime
-- surface. Keep the legacy shell terminal coordinates during migration so an
-- older server can be rolled back without interpreting a coding-agent Session
-- as Bash.

ALTER TABLE environment_runtime
    ADD COLUMN agent_session_id TEXT,
    ADD COLUMN agent_attempt_id TEXT;

CREATE INDEX environment_runtime_agent_session_idx
    ON environment_runtime (agent_session_id)
    WHERE agent_session_id IS NOT NULL;

CREATE TABLE environment_terminal_controllers (
    environment_id TEXT PRIMARY KEY
        REFERENCES environments(id) ON DELETE CASCADE,
    runtime_generation BIGINT NOT NULL CHECK (runtime_generation >= 0),
    agent_session_id TEXT NOT NULL,
    agent_attempt_id TEXT NOT NULL,
    holder_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL CHECK (
        LENGTH(client_id) BETWEEN 1 AND 200
        AND client_id !~ '[[:cntrl:]]'
    ),
    lease_version BIGINT NOT NULL DEFAULT 1 CHECK (lease_version > 0),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX environment_terminal_controllers_expiry_idx
    ON environment_terminal_controllers (expires_at, environment_id);

CREATE TRIGGER environment_terminal_controllers_set_updated_at
    BEFORE UPDATE ON environment_terminal_controllers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN environment_runtime.agent_session_id IS
    'Opaque procd Session id for the Environment native coding-agent TUI.';
COMMENT ON COLUMN environment_runtime.agent_attempt_id IS
    'Current process attempt fenced by Sandbox0 runtime generation.';
COMMENT ON TABLE environment_terminal_controllers IS
    'Cross-replica short lease granting one browser device authority to send native terminal input and resize events.';

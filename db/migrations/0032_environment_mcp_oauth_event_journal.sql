ALTER TABLE environment_mcp_oauth_flows
    ADD COLUMN native_thread_id TEXT,
    ADD COLUMN native_runtime_generation BIGINT,
    ADD COLUMN native_attempt_id TEXT,
    ADD COLUMN native_thread_cleanup_completed_at TIMESTAMPTZ,
    ADD CONSTRAINT environment_mcp_oauth_flows_native_correlation_group_check
    CHECK (
        num_nonnulls(
            native_thread_id,
            native_runtime_generation,
            native_attempt_id
        ) IN (0, 3)
    ),
    ADD CONSTRAINT environment_mcp_oauth_flows_native_correlation_check
    CHECK (
        native_thread_id IS NULL
        OR (
            length(btrim(native_thread_id)) > 0
            AND native_runtime_generation >= 0
        )
    ),
    ADD CONSTRAINT environment_mcp_oauth_flows_thread_cleanup_status_check
    CHECK (
        native_thread_cleanup_completed_at IS NULL
        OR (
            native_thread_id IS NOT NULL
            AND status IN ('completed', 'failed', 'cancelled', 'expired')
        )
    );

UPDATE environment_mcp_oauth_flows
SET status = 'cancelled'
WHERE status IN ('starting', 'awaiting_user')
  AND native_thread_id IS NULL;

CREATE UNIQUE INDEX environment_mcp_oauth_flows_native_thread_idx
    ON environment_mcp_oauth_flows (
        environment_id,
        native_thread_id
    )
    WHERE native_thread_id IS NOT NULL;

CREATE INDEX environment_mcp_oauth_flows_thread_cleanup_pending_idx
    ON environment_mcp_oauth_flows (created_at, id)
    WHERE native_thread_id IS NOT NULL
      AND native_thread_cleanup_completed_at IS NULL
      AND status IN ('completed', 'failed', 'cancelled', 'expired');

CREATE TABLE environment_mcp_oauth_events (
    environment_id TEXT NOT NULL
        REFERENCES environments(id) ON DELETE CASCADE,
    runtime_generation BIGINT NOT NULL CHECK (runtime_generation >= 0),
    supervisor_sequence BIGINT NOT NULL CHECK (supervisor_sequence >= 0),
    record_index INTEGER NOT NULL CHECK (record_index >= 0),
    attempt_id TEXT NOT NULL,
    server_name TEXT NOT NULL CHECK (length(btrim(server_name)) > 0),
    success BOOLEAN NOT NULL,
    disposition TEXT NOT NULL CHECK (length(btrim(disposition)) > 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (
        environment_id,
        runtime_generation,
        supervisor_sequence,
        record_index,
        attempt_id
    )
);

CREATE INDEX environment_mcp_oauth_events_server_idx
    ON environment_mcp_oauth_events (
        environment_id,
        server_name,
        processed_at
    );

COMMENT ON COLUMN environment_mcp_oauth_flows.native_thread_id IS
    'Dedicated native Codex thread that correlates this flow with its terminal OAuth notification.';
COMMENT ON COLUMN environment_mcp_oauth_flows.native_runtime_generation IS
    'Runtime generation that owns the dedicated native OAuth correlation thread.';
COMMENT ON COLUMN environment_mcp_oauth_flows.native_attempt_id IS
    'Normalized runtime attempt that owns the correlation thread; an absent native attempt is stored as the empty string.';
COMMENT ON COLUMN environment_mcp_oauth_flows.native_thread_cleanup_completed_at IS
    'Durable marker set only after the ephemeral native OAuth correlation thread is unsubscribed.';
COMMENT ON TABLE environment_mcp_oauth_events IS
    'Idempotency journal for native Codex MCP OAuth terminal notifications. It contains event coordinates and outcomes, never credentials.';

ALTER TABLE environment_mcp_integrations
    ADD COLUMN tool_policy_mode TEXT NOT NULL DEFAULT 'all'
        CHECK (tool_policy_mode IN ('all', 'selected')),
    ADD COLUMN allowed_tools TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN tool_policy_status TEXT NOT NULL DEFAULT 'active'
        CHECK (tool_policy_status IN ('active', 'updating', 'error')),
    ADD COLUMN tool_policy_error TEXT;

ALTER TABLE environment_mcp_integrations
    ADD CONSTRAINT environment_mcp_integrations_tool_policy_shape_check
    CHECK (
        (
            tool_policy_mode = 'all'
            AND cardinality(allowed_tools) = 0
        )
        OR (
            tool_policy_mode = 'selected'
            AND cardinality(allowed_tools) > 0
        )
    ),
    ADD CONSTRAINT environment_mcp_integrations_tool_policy_names_check
    CHECK (
        array_position(allowed_tools, NULL) IS NULL
        AND cardinality(allowed_tools) <= 1024
    ),
    ADD CONSTRAINT environment_mcp_integrations_tool_policy_error_check
    CHECK (
        (tool_policy_status = 'error') = (tool_policy_error IS NOT NULL)
    );

COMMENT ON COLUMN environment_mcp_integrations.tool_policy_mode IS
    'Desired Sandbox0 MCP tool policy. Selected is an explicit allowlist; all emits no tool restriction.';
COMMENT ON COLUMN environment_mcp_integrations.allowed_tools IS
    'Raw MCP tools/call names enforced at the Sandbox0 egress boundary, never Codex model-visible aliases.';
COMMENT ON COLUMN environment_mcp_integrations.tool_policy_status IS
    'Convergence state between the durable desired tool policy and the Sandbox0 network policy.';

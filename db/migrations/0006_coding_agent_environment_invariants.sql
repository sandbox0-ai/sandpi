UPDATE environments
SET template_id = 'coding-agent'
WHERE template_id IS NULL;

ALTER TABLE environments
    ALTER COLUMN template_id SET DEFAULT 'coding-agent',
    ALTER COLUMN template_id SET NOT NULL,
    ADD CONSTRAINT environments_coding_agent_template_only
        CHECK (template_id = 'coding-agent');

CREATE UNIQUE INDEX environments_workspace_volume_unique_idx
    ON environments (workspace_volume_id)
    WHERE workspace_volume_id IS NOT NULL;

CREATE UNIQUE INDEX session_runtime_workspace_volume_unique_idx
    ON session_runtime (workspace_volume_id)
    WHERE workspace_volume_id IS NOT NULL;

COMMENT ON COLUMN environments.template_id IS
    'Every Sandpi Environment uses the deployment coding-agent template; harness selection is an Environment-level Sandpi concern.';
COMMENT ON COLUMN session_runtime.workspace_volume_id IS
    'Private Workspace Volume fork owned by exactly one Sandpi Session.';

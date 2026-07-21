-- Workspace backups are native SandboxVolume snapshots. PostgreSQL owns only
-- the Environment policy, durable scheduler state, and the ids of snapshots
-- created by Sandpi so retention never deletes snapshots owned elsewhere.

ALTER TABLE environments
    ADD COLUMN workspace_backup_interval_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (
            workspace_backup_interval_seconds IN (
                0, 3600, 21600, 43200, 86400, 604800
            )
        ),
    ADD COLUMN workspace_backup_retention_count INTEGER NOT NULL DEFAULT 7
        CHECK (
            workspace_backup_retention_count IN (1, 3, 7, 14, 30)
        );

ALTER TABLE environment_runtime
    ADD COLUMN workspace_backup_due_at TIMESTAMPTZ,
    ADD COLUMN workspace_backup_last_completed_at TIMESTAMPTZ,
    ADD COLUMN workspace_backup_retry_at TIMESTAMPTZ,
    ADD COLUMN workspace_backup_error TEXT;

CREATE TABLE environment_workspace_backups (
    snapshot_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    workspace_volume_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    backup_kind TEXT NOT NULL CHECK (backup_kind IN ('automatic', 'manual')),
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX environment_workspace_backups_environment_created_idx
    ON environment_workspace_backups (
        environment_id, created_at DESC, snapshot_id DESC
    );

CREATE INDEX environment_runtime_workspace_backup_due_idx
    ON environment_runtime (
        COALESCE(workspace_backup_retry_at, workspace_backup_due_at),
        environment_id
    )
    WHERE workspace_backup_due_at IS NOT NULL
       OR workspace_backup_retry_at IS NOT NULL;

COMMENT ON COLUMN environments.workspace_backup_interval_seconds IS
    'Seconds between native Workspace Volume snapshots; zero disables scheduled backups.';
COMMENT ON COLUMN environment_runtime.workspace_backup_retry_at IS
    'Short durable lease and retry deadline for a failed Workspace backup operation.';
COMMENT ON TABLE environment_workspace_backups IS
    'Ownership journal for native SandboxVolume snapshots created by Sandpi; snapshot bytes remain in Sandbox0.';

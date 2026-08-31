-- Sandpi Environments now persist their complete writable filesystem in the
-- Sandbox rootfs. Legacy SandboxVolume snapshots cannot be restored through
-- the rootfs API, so their local journal is deliberately retired after the
-- migration has copied any required user data into the live Sandbox rootfs.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM environments
        WHERE workspace_volume_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'Cannot retire Environment Workspace Volumes before every Environment has completed the rootfs cutover'
            USING ERRCODE = 'check_violation';
    END IF;
END
$$;

DROP TABLE environment_workspace_backups;

DROP INDEX IF EXISTS environments_workspace_volume_unique_idx;
ALTER TABLE environments DROP COLUMN workspace_volume_id;

CREATE TABLE environment_workspace_backups (
    snapshot_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    sandbox_id TEXT NOT NULL,
    name TEXT NOT NULL,
    backup_kind TEXT NOT NULL CHECK (backup_kind IN ('automatic', 'manual')),
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX environment_workspace_backups_environment_created_idx
    ON environment_workspace_backups (
        environment_id, created_at DESC, snapshot_id DESC
    );

COMMENT ON COLUMN environments.rootfs_snapshot_id IS
    'Optional rootfs snapshot used to seed the Environment Sandbox during initial provisioning.';
COMMENT ON COLUMN environments.workspace_backup_interval_seconds IS
    'Seconds between native Sandbox rootfs snapshots; zero disables scheduled backups.';
COMMENT ON TABLE environment_workspace_backups IS
    'Ownership journal for Sandbox rootfs snapshots created by Sandpi; snapshot bytes and metering remain authoritative in Sandbox0.';

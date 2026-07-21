import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_SECONDS,
  DEFAULT_ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_COUNT,
  ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_OPTIONS,
  ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_OPTIONS,
  isEnvironmentWorkspaceBackupIntervalSeconds,
  isEnvironmentWorkspaceBackupRetentionCount,
} from "./environment-workspace-backup";

test("keeps automatic Workspace backups opt-in with bounded presets", () => {
  assert.equal(DEFAULT_ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_SECONDS, 0);
  assert.equal(DEFAULT_ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_COUNT, 7);
  assert.deepEqual(
    ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_OPTIONS.map(({ seconds }) => seconds),
    [0, 3_600, 21_600, 43_200, 86_400, 604_800],
  );
  assert.deepEqual(ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_OPTIONS, [
    1, 3, 7, 14, 30,
  ]);
  assert.equal(isEnvironmentWorkspaceBackupIntervalSeconds(86_400), true);
  assert.equal(isEnvironmentWorkspaceBackupIntervalSeconds(60), false);
  assert.equal(isEnvironmentWorkspaceBackupRetentionCount(14), true);
  assert.equal(isEnvironmentWorkspaceBackupRetentionCount(2), false);
});

export const ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_OPTIONS = [
  { seconds: 0, label: "Off" },
  { seconds: 60 * 60, label: "Every hour" },
  { seconds: 6 * 60 * 60, label: "Every 6 hours" },
  { seconds: 12 * 60 * 60, label: "Every 12 hours" },
  { seconds: 24 * 60 * 60, label: "Daily" },
  { seconds: 7 * 24 * 60 * 60, label: "Weekly" },
] as const;

export const ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_OPTIONS = [
  1, 3, 7, 14, 30,
] as const;

export const DEFAULT_ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_SECONDS = 0;
export const DEFAULT_ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_COUNT = 7;

export function isEnvironmentWorkspaceBackupIntervalSeconds(
  value: number,
): boolean {
  return ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_OPTIONS.some(
    (option) => option.seconds === value,
  );
}

export function isEnvironmentWorkspaceBackupRetentionCount(
  value: number,
): boolean {
  return ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_OPTIONS.some(
    (option) => option === value,
  );
}

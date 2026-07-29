const PLAYWRIGHT_DEFAULT_PROFILE_PATH =
  /^\/workspace\/\.cache\/ms-playwright\/daemon\/[a-f0-9]{16}\/ud-default-chrome-for-testing$/;
const PLAYWRIGHT_PROFILE_IN_USE =
  /Browser is already in use for ([^,\r\n]+)/;

export interface PlaywrightCliResult {
  exitCode?: number;
  stderr: string;
}

export const PLAYWRIGHT_STALE_PROFILE_LOCK_RECOVERY_SCRIPT = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const profilePath = process.argv[1];
const lockNames = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

try {
  if (
    !fs.lstatSync(profilePath).isDirectory() ||
    fs.realpathSync.native(profilePath) !== profilePath
  ) {
    process.exit(10);
  }

  const lockPath = path.join(profilePath, "SingletonLock");
  let lockTarget;
  try {
    lockTarget = fs.readlinkSync(lockPath);
  } catch (error) {
    if (error && error.code === "ENOENT") process.exit(0);
    throw error;
  }

  const lockMatch = /^(.*)-([1-9]\d*)$/.exec(lockTarget);
  if (!lockMatch) process.exit(11);
  const lockHost = lockMatch[1];
  const lockPid = Number(lockMatch[2]);
  if (lockHost === os.hostname()) {
    try {
      process.kill(lockPid, 0);
    } catch (error) {
      if (error && error.code === "EPERM") process.exit(12);
      if (!error || error.code !== "ESRCH") throw error;
    }
    try {
      const command = fs
        .readFileSync("/proc/" + lockPid + "/cmdline", "utf8")
        .split("\0");
      if (command.includes("--user-data-dir=" + profilePath)) {
        process.exit(12);
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") process.exit(12);
    }
  }

  const staleLocks = [];
  for (const name of lockNames) {
    const candidate = path.join(profilePath, name);
    try {
      if (!fs.lstatSync(candidate).isSymbolicLink()) process.exit(13);
      staleLocks.push(candidate);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  if (fs.readlinkSync(lockPath) !== lockTarget) process.exit(14);
  for (const candidate of staleLocks) fs.unlinkSync(candidate);
} catch {
  process.exit(15);
}
`;

export function playwrightProfilePathFromInUseError(stderr: string) {
  const profilePath = PLAYWRIGHT_PROFILE_IN_USE.exec(stderr)?.[1];
  return profilePath && PLAYWRIGHT_DEFAULT_PROFILE_PATH.test(profilePath)
    ? profilePath
    : undefined;
}

export function playwrightStaleProfileLockRecoveryCommand(
  profilePath: string,
) {
  if (!PLAYWRIGHT_DEFAULT_PROFILE_PATH.test(profilePath)) return undefined;
  return [
    "node",
    "-e",
    PLAYWRIGHT_STALE_PROFILE_LOCK_RECOVERY_SCRIPT,
    profilePath,
  ];
}

export function isPlaywrightBrowserNotOpen(result: PlaywrightCliResult) {
  return /Browser ['"]?default['"]? is not open/i.test(result.stderr);
}

export function isPlaywrightBrowserDependencyUnavailable(
  result: PlaywrightCliResult,
) {
  return (
    result.exitCode === 127 ||
    /(?:playwright-cli|spawn playwright-cli).*(?:command )?not found|spawn playwright-cli ENOENT|executable doesn't exist at|Executable doesn't exist/i.test(
      result.stderr,
    )
  );
}

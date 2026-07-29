import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, lstat, readlink, symlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isPlaywrightBrowserDependencyUnavailable,
  isPlaywrightBrowserNotOpen,
  PLAYWRIGHT_STALE_PROFILE_LOCK_RECOVERY_SCRIPT,
  playwrightProfilePathFromInUseError,
  playwrightStaleProfileLockRecoveryCommand,
} from "./playwright-browser-recovery";

const profilePath =
  "/workspace/.cache/ms-playwright/daemon/8af22c44f40455cc/ud-default-chrome-for-testing";

test("accepts only the default Playwright profile from an in-use error", () => {
  assert.equal(
    playwrightProfilePathFromInUseError(
      `Error: Browser is already in use for ${profilePath}, use --isolated`,
    ),
    profilePath,
  );
  assert.equal(
    playwrightProfilePathFromInUseError(
      "Browser is already in use for /workspace/private, use --isolated",
    ),
    undefined,
  );
  assert.equal(
    playwrightStaleProfileLockRecoveryCommand("/workspace/private"),
    undefined,
  );
  assert.deepEqual(
    playwrightStaleProfileLockRecoveryCommand(profilePath)?.slice(0, 2),
    ["node", "-e"],
  );
});

test("recognizes a stopped browser separately from missing dependencies", () => {
  assert.equal(
    isPlaywrightBrowserNotOpen({
      exitCode: 1,
      stderr: "Error: Browser 'default' is not open.",
    }),
    true,
  );
  assert.equal(
    isPlaywrightBrowserDependencyUnavailable({
      exitCode: 127,
      stderr: "playwright-cli: command not found",
    }),
    true,
  );
  assert.equal(
    isPlaywrightBrowserDependencyUnavailable({
      exitCode: 1,
      stderr:
        "Failed to launch chromium because executable doesn't exist at /opt/ms-playwright/chromium/chrome",
    }),
    true,
  );
  assert.equal(
    isPlaywrightBrowserDependencyUnavailable({
      exitCode: 1,
      stderr: "Browser is already in use for a profile",
    }),
    false,
  );
});

test("removes only stale Chromium singleton symlinks", async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "sandpi-browser-profile-"));
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(profile, { recursive: true, force: true }),
    );
  });
  const locks = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  await Promise.all(
    locks.map((name) =>
      symlink(
        name === "SingletonLock" ? "retired-sandbox-271" : `stale-${name}`,
        path.join(profile, name),
      ),
    ),
  );

  const recovered = spawnSync(
    process.execPath,
    ["-e", PLAYWRIGHT_STALE_PROFILE_LOCK_RECOVERY_SCRIPT, profile],
    { encoding: "utf8" },
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  for (const name of locks) {
    await assert.rejects(lstat(path.join(profile, name)), {
      code: "ENOENT",
    });
  }

  const browser = spawn(
    process.execPath,
    [
      "-e",
      "setInterval(() => undefined, 60_000)",
      "--",
      `--user-data-dir=${profile}`,
    ],
    { stdio: "ignore" },
  );
  context.after(() => {
    browser.kill();
  });
  await new Promise<void>((resolve, reject) => {
    browser.once("spawn", resolve);
    browser.once("error", reject);
  });
  assert.ok(browser.pid);
  await Promise.all(
    locks.map((name) =>
      symlink(
        name === "SingletonLock"
          ? `${hostname()}-${browser.pid}`
          : `live-${name}`,
        path.join(profile, name),
      ),
    ),
  );
  const refused = spawnSync(
    process.execPath,
    ["-e", PLAYWRIGHT_STALE_PROFILE_LOCK_RECOVERY_SCRIPT, profile],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 12, refused.stderr);
  assert.equal(
    await readlink(path.join(profile, "SingletonLock")),
    `${hostname()}-${browser.pid}`,
  );

  const browserExited = new Promise<void>((resolve) =>
    browser.once("exit", () => resolve()),
  );
  browser.kill();
  await browserExited;
  const reusedPidLock = `${hostname()}-${process.pid}`;
  await import("node:fs/promises").then(({ unlink }) =>
    unlink(path.join(profile, "SingletonLock")),
  );
  await symlink(reusedPidLock, path.join(profile, "SingletonLock"));
  const recoveredReusedPid = spawnSync(
    process.execPath,
    ["-e", PLAYWRIGHT_STALE_PROFILE_LOCK_RECOVERY_SCRIPT, profile],
    { encoding: "utf8" },
  );
  assert.equal(recoveredReusedPid.status, 0, recoveredReusedPid.stderr);
  for (const name of locks) {
    await assert.rejects(lstat(path.join(profile, name)), {
      code: "ENOENT",
    });
  }
});

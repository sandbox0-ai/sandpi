/**
 * Keeps agent-authored Playwright CLI commands inside the page attachment
 * selected by Sandpi. Browser ownership and control remain in the official CLI.
 */
export const PLAYWRIGHT_SESSION_WRAPPER_SOURCE = String.raw`#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const sessionName = process.env.PLAYWRIGHT_CLI_SESSION || "";
const realCli = process.env.SANDPI_PLAYWRIGHT_CLI_REAL || "";
const lockRoot =
  process.env.SANDPI_PLAYWRIGHT_LOCK_ROOT ||
  "/workspace/.sandpi/browser/locks";
const fixedSession = /^sandpi-[a-f0-9]{32}$/.test(sessionName);
const knownCommands = new Set([
  "open",
  "attach",
  "close",
  "detach",
  "goto",
  "type",
  "click",
  "dblclick",
  "fill",
  "drag",
  "drop",
  "hover",
  "select",
  "upload",
  "check",
  "uncheck",
  "snapshot",
  "find",
  "eval",
  "dialog-accept",
  "dialog-dismiss",
  "resize",
  "go-back",
  "go-forward",
  "reload",
  "press",
  "keydown",
  "keyup",
  "mousemove",
  "mousedown",
  "mouseup",
  "mousewheel",
  "screenshot",
  "pdf",
  "tab-list",
  "tab-new",
  "tab-close",
  "tab-select",
  "state-load",
  "state-save",
  "cookie-list",
  "cookie-get",
  "cookie-set",
  "cookie-delete",
  "cookie-clear",
  "localstorage-list",
  "localstorage-get",
  "localstorage-set",
  "localstorage-delete",
  "localstorage-clear",
  "sessionstorage-list",
  "sessionstorage-get",
  "sessionstorage-set",
  "sessionstorage-delete",
  "sessionstorage-clear",
  "route",
  "route-list",
  "unroute",
  "network-state-set",
  "console",
  "requests",
  "request",
  "request-headers",
  "request-body",
  "response-headers",
  "response-body",
  "run-code",
  "tracing-start",
  "tracing-stop",
  "video-start",
  "video-stop",
  "video-chapter",
  "video-show-actions",
  "video-hide-actions",
  "show",
  "pause-at",
  "resume",
  "step-over",
  "generate-locator",
  "highlight",
  "list",
  "close-all",
  "kill-all",
  "delete-data",
  "install",
  "install-browser",
]);

function fail(message) {
  process.stderr.write("playwright-cli: " + message + "\n");
  process.exit(1);
}

if (!realCli) fail("Sandpi could not resolve the official Playwright CLI.");
if (!fixedSession) {
  const result = childProcess.spawnSync(realCli, args, { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}

function explicitSession(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("-s=")) return value.slice(3);
    if (value.startsWith("--s=")) return value.slice(4);
    if (value.startsWith("--session=")) return value.slice(10);
    if (value === "-s" || value === "--s" || value === "--session")
      return argv[index + 1];
  }
  return undefined;
}

const requestedSession = explicitSession(args);
if (requestedSession && requestedSession !== sessionName) {
  fail("this Sandpi Session cannot control another Browser page.");
}

function withoutSessionArgs(argv) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (
      value.startsWith("-s=") ||
      value.startsWith("--s=") ||
      value.startsWith("--session=")
    ) {
      continue;
    }
    if (value === "-s" || value === "--s" || value === "--session") {
      index += 1;
      continue;
    }
    result.push(value);
  }
  return result;
}

const scopedArgs = withoutSessionArgs(args);
const commandIndex = scopedArgs.findIndex((value) => !value.startsWith("-"));
if (commandIndex === -1) {
  const diagnosticOnly = scopedArgs.every((value) =>
    ["--help", "-h", "--version", "-v", "-V"].includes(value),
  );
  if (!diagnosticOnly) {
    fail("the Playwright CLI command is missing.");
  }
  const result = childProcess.spawnSync(realCli, scopedArgs, {
    stdio: "inherit",
  });
  process.exit(result.status === null ? 1 : result.status);
}

const command = scopedArgs[commandIndex];
if (!knownCommands.has(command)) {
  fail(
    "this Playwright CLI command is not supported by Sandpi's fixed Browser page.",
  );
}
const blockedCommands = new Set([
  "attach",
  "detach",
  "tab-list",
  "tab-new",
  "tab-close",
  "tab-select",
  "list",
  "close-all",
  "kill-all",
  "delete-data",
  "show",
  "install-browser",
]);
if (blockedCommands.has(command)) {
  fail(
    "Sandpi assigns one fixed Browser page to this Session; tab and browser-session commands are unavailable.",
  );
}

function run(cliArgs, capture) {
  const result = childProcess.spawnSync(realCli, cliArgs, {
    encoding: capture ? "utf8" : undefined,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: capture ? "pipe" : "inherit",
  });
  return result;
}

function requireSuccess(result, operation) {
  if (result.status === 0) return;
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  fail(operation + " failed.");
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function acquireLock(name) {
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(lockRoot, name + ".lock");
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
      fs.closeSync(descriptor);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (!processIsAlive(owner.pid)) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  fail("timed out waiting for the fixed Browser page.");
}

function ensureAttachment() {
  const release = acquireLock("environment");
  try {
    const owner = run(["-s=default", "tab-list"], true);
    if (owner.status !== 0) {
      requireSuccess(
        run(
          [
            "-s=default",
            "open",
            "about:blank",
            "--browser",
            "chromium",
            "--persistent",
          ],
          true,
        ),
        "starting the shared Environment Browser",
      );
    }

    const attached = run(["-s=" + sessionName, "tab-list"], true);
    if (attached.status === 0) return;
    requireSuccess(
      run(["-s=" + sessionName, "attach", "default"], true),
      "attaching the Session Browser page",
    );
    requireSuccess(
      run(["-s=" + sessionName, "tab-new", "about:blank"], true),
      "creating the Session Browser page",
    );
  } finally {
    release();
  }
}

const releaseSession = acquireLock(sessionName);
try {
  ensureAttachment();
  let finalArgs = scopedArgs;
  if (command === "open") {
    const candidate = scopedArgs[commandIndex + 1];
    const url = candidate && !candidate.startsWith("-") ? candidate : "about:blank";
    finalArgs = [
      ...scopedArgs.slice(0, commandIndex),
      "goto",
      url,
    ];
  } else if (command === "close") {
    finalArgs = [
      ...scopedArgs.slice(0, commandIndex),
      "goto",
      "about:blank",
    ];
  }
  const result = run(["-s=" + sessionName, ...finalArgs], false);
  process.exitCode = result.status === null ? 1 : result.status;
} finally {
  releaseSession();
}
`;

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PLAYWRIGHT_SESSION_WRAPPER_SOURCE } from "./playwright-session-wrapper";

test("session wrapper scopes commands and removes multi-tab lifecycle controls", () => {
  assert.match(
    PLAYWRIGHT_SESSION_WRAPPER_SOURCE,
    /\^sandpi-\[a-f0-9\]\{32\}\$/,
  );
  assert.match(
    PLAYWRIGHT_SESSION_WRAPPER_SOURCE,
    /\["-s=" \+ sessionName, "attach", "default"\]/,
  );
  assert.match(
    PLAYWRIGHT_SESSION_WRAPPER_SOURCE,
    /\["-s=" \+ sessionName, "tab-new", "about:blank"\]/,
  );
  assert.match(PLAYWRIGHT_SESSION_WRAPPER_SOURCE, /blockedCommands/);
  assert.match(
    PLAYWRIGHT_SESSION_WRAPPER_SOURCE,
    /command === "open"[\s\S]+?"goto"/,
  );
  assert.match(
    PLAYWRIGHT_SESSION_WRAPPER_SOURCE,
    /command === "close"[\s\S]+?"about:blank"/,
  );
  assert.ok(!PLAYWRIGHT_SESSION_WRAPPER_SOURCE.includes("eval("));
});

test("session wrapper attaches once and navigates without opening another browser", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sandpi-browser-wrapper-"));
  const wrapperPath = path.join(directory, "playwright-cli");
  const fakeCliPath = path.join(directory, "official-playwright-cli");
  const statePath = path.join(directory, "state.json");
  const logPath = path.join(directory, "commands.jsonl");
  const sessionName = `sandpi-${"b".repeat(32)}`;
  const otherSessionName = `sandpi-${"c".repeat(32)}`;
  const fakeCli = String.raw`#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.TEST_PLAYWRIGHT_STATE;
const logPath = process.env.TEST_PLAYWRIGHT_LOG;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { owner: false, attached: {} };
fs.appendFileSync(logPath, JSON.stringify(args) + "\n");
const session =
  args.find((value) => value.startsWith("-s="))?.slice(3) || "default";
const command = args.find((value) =>
  ["tab-list", "open", "attach", "tab-new", "goto"].includes(value),
);
if (command === "tab-list") {
  const available = session === "default" ? state.owner : state.attached[session];
  if (!available) {
    process.stderr.write("Error: Browser '" + session + "' is not open.\n");
    process.exit(1);
  }
} else if (command === "open" && session === "default") {
  state.owner = true;
} else if (command === "attach") {
  state.attached[session] = true;
}
fs.writeFileSync(statePath, JSON.stringify(state));
`;

  try {
    writeFileSync(wrapperPath, PLAYWRIGHT_SESSION_WRAPPER_SOURCE, {
      mode: 0o700,
    });
    writeFileSync(fakeCliPath, fakeCli, { mode: 0o700 });
    const env = {
      ...process.env,
      PLAYWRIGHT_CLI_SESSION: sessionName,
      SANDPI_PLAYWRIGHT_CLI_REAL: fakeCliPath,
      SANDPI_PLAYWRIGHT_LOCK_ROOT: path.join(directory, "locks"),
      TEST_PLAYWRIGHT_STATE: statePath,
      TEST_PLAYWRIGHT_LOG: logPath,
    };

    const first = spawnSync(wrapperPath, ["open", "http://localhost:3000/"], {
      env,
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(
      readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        ["-s=default", "tab-list"],
        [
          "-s=default",
          "open",
          "about:blank",
          "--browser",
          "chromium",
          "--persistent",
        ],
        [`-s=${sessionName}`, "tab-list"],
        [`-s=${sessionName}`, "attach", "default"],
        [`-s=${sessionName}`, "tab-new", "about:blank"],
        [`-s=${sessionName}`, "goto", "http://localhost:3000/"],
      ],
    );

    const second = spawnSync(wrapperPath, ["open", "http://localhost:4000/"], {
      env,
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr);
    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      commands.filter((command) => command.includes("open")).length,
      1,
    );
    assert.deepEqual(commands.at(-1), [
      `-s=${sessionName}`,
      "goto",
      "http://localhost:4000/",
    ]);

    const blockedTab = spawnSync(wrapperPath, ["tab-new", "about:blank"], {
      env,
      encoding: "utf8",
    });
    assert.equal(blockedTab.status, 1);
    assert.match(blockedTab.stderr, /one fixed Browser page/);
    const crossSession = spawnSync(
      wrapperPath,
      [`-s=${otherSessionName}`, "goto", "about:blank"],
      { env, encoding: "utf8" },
    );
    assert.equal(crossSession.status, 1);
    assert.match(crossSession.stderr, /cannot control another Browser page/);
    const unknownCommand = spawnSync(wrapperPath, ["future-tab-command"], {
      env,
      encoding: "utf8",
    });
    assert.equal(unknownCommand.status, 1);
    assert.match(unknownCommand.stderr, /not supported/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

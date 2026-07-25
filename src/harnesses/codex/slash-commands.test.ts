import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_SLASH_COMMANDS,
  codexSlashCommandCompletion,
  codexSlashMenuCommands,
  parseCodexSlashInvocation,
} from "./slash-commands";

test("never exposes resume or side-thread commands in Sandpi", () => {
  const names = new Set<string>(
    CODEX_SLASH_COMMANDS.map((command) => command.name),
  );
  assert.equal(names.has("resume"), false);
  assert.equal(names.has("side"), false);
  assert.equal(names.has("btw"), false);
});

test("filters commands by Sandpi composer context and query", () => {
  assert.deepEqual(
    codexSlashMenuCommands("/fo", "session").map((command) => command.name),
    ["fork"],
  );
  assert.deepEqual(
    codexSlashMenuCommands("/fo", "new-session").map(
      (command) => command.name,
    ),
    [],
  );
  assert.equal(
    codexSlashMenuCommands("/fork ", "session").length,
    0,
  );
});

test("hides unsafe native mutations while a Turn is running", () => {
  const runningNames = codexSlashMenuCommands(
    "/",
    "session",
    true,
  ).map((command) => command.name);
  assert.equal(runningNames.includes("fork"), false);
  assert.equal(runningNames.includes("compact"), false);
  assert.equal(runningNames.includes("review"), false);
  assert.equal(runningNames.includes("new"), true);
  assert.equal(runningNames.includes("status"), true);
});

test("parses arguments and rejects unavailable or unknown commands", () => {
  assert.deepEqual(parseCodexSlashInvocation("/rename Release work", "session"), {
    kind: "command",
    command: CODEX_SLASH_COMMANDS.find(
      (command) => command.name === "rename",
    ),
    arguments: "Release work",
  });
  assert.equal(
    parseCodexSlashInvocation("/rename", "session").kind,
    "missing-arguments",
  );
  assert.equal(
    parseCodexSlashInvocation("/fork", "new-session").kind,
    "unavailable",
  );
  assert.deepEqual(parseCodexSlashInvocation("/resume", "session"), {
    kind: "unknown",
    name: "resume",
  });
});

test("completes argument commands without executing them", () => {
  const rename = CODEX_SLASH_COMMANDS.find(
    (command) => command.name === "rename",
  );
  const status = CODEX_SLASH_COMMANDS.find(
    (command) => command.name === "status",
  );
  assert.ok(rename);
  assert.ok(status);
  assert.equal(codexSlashCommandCompletion(rename), "/rename ");
  assert.equal(codexSlashCommandCompletion(status), "/status");
});

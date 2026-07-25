import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_SLASH_COMMANDS,
  codexSlashCommandCompletion,
  codexSlashMenuCommands,
  parseCodexSlashInvocation,
} from "./slash-commands";

test("omits commands represented by Sandpi navigation or composer controls", () => {
  const names = new Set<string>(
    CODEX_SLASH_COMMANDS.map((command) => command.name),
  );
  assert.equal(names.has("resume"), false);
  assert.equal(names.has("side"), false);
  assert.equal(names.has("btw"), false);
  assert.equal(names.has("fast"), false);
  assert.equal(names.has("status"), false);
});

test("maps Codex agent command spellings to the native Agent Threads intent", () => {
  const agentCommands = CODEX_SLASH_COMMANDS.filter(
    (command) => command.intent === "agents.open",
  );
  assert.deepEqual(
    agentCommands.map((command) => command.name),
    ["agent", "subagents"],
  );
  assert.equal(
    agentCommands.every(
      (command) => !command.description.en.toLowerCase().includes("activity"),
    ),
    true,
  );
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
  const runningNames = new Set<string>(
    codexSlashMenuCommands(
      "/",
      "session",
      true,
    ).map((command) => command.name),
  );
  assert.equal(runningNames.has("fork"), false);
  assert.equal(runningNames.has("compact"), false);
  assert.equal(runningNames.has("review"), false);
  assert.equal(runningNames.has("new"), true);
  assert.equal(runningNames.has("status"), false);
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
  const model = CODEX_SLASH_COMMANDS.find(
    (command) => command.name === "model",
  );
  assert.ok(rename);
  assert.ok(model);
  assert.equal(codexSlashCommandCompletion(rename), "/rename ");
  assert.equal(codexSlashCommandCompletion(model), "/model");
});

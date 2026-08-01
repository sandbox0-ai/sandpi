import assert from "node:assert/strict";
import test from "node:test";

import {
  codexMcpServerConfigurationSchema,
  codexSkillPutSchema,
} from "./api-schemas";

test("validates one complete Codex skill replacement", () => {
  const parsed = codexSkillPutSchema.parse({
    files: [
      {
        path: "SKILL.md",
        contentBase64: Buffer.from("---\nname: release\n---\n").toString(
          "base64",
        ),
      },
      {
        path: "scripts/release.sh",
        contentBase64: Buffer.from("#!/bin/sh\n").toString("base64"),
        executable: true,
      },
    ],
  });

  assert.equal(parsed.enabled, true);
  assert.equal(parsed.files[0]?.executable, false);
  assert.equal(parsed.files[1]?.executable, true);
});

test("rejects unsafe, duplicate and incomplete Codex skill replacements", () => {
  for (const files of [
    [
      { path: "../SKILL.md", contentBase64: "" },
    ],
    [
      { path: "SKILL.md", contentBase64: "" },
      { path: "SKILL.md", contentBase64: "" },
    ],
    [
      { path: "README.md", contentBase64: "" },
    ],
    [
      { path: "SKILL.md", contentBase64: "not base64" },
    ],
    [
      { path: "SKILL.md", contentBase64: "AB==" },
    ],
  ]) {
    assert.equal(codexSkillPutSchema.safeParse({ files }).success, false);
  }
});

test("normalizes typed MCP definitions without accepting URL credentials", () => {
  assert.deepEqual(
    codexMcpServerConfigurationSchema.parse({
      transport: "stdio",
      command: "npx",
    }),
    {
      transport: "stdio",
      command: "npx",
      args: [],
      enabled: true,
      required: false,
    },
  );
  assert.equal(
    codexMcpServerConfigurationSchema.safeParse({
      transport: "streamable-http",
      url: "https://token@example.test/mcp",
    }).success,
    false,
  );
  assert.equal(
    codexMcpServerConfigurationSchema.safeParse({
      transport: "streamable-http",
      url: "file:///tmp/mcp.sock",
    }).success,
    false,
  );
});

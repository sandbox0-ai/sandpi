import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_MCP_PRESET_CATEGORIES,
  CODEX_MCP_PRESETS,
  codexMcpInputFromPreset,
} from "@/harnesses/codex/mcp-catalog";

test("keeps the MCP catalog split into three populated categories", () => {
  assert.deepEqual(
    CODEX_MCP_PRESET_CATEGORIES.map((category) => category.id),
    ["aggregators", "remote", "local"],
  );

  for (const category of CODEX_MCP_PRESET_CATEGORIES) {
    assert.ok(
      CODEX_MCP_PRESETS.some((preset) => preset.category === category.id),
      `${category.id} should contain at least one preset`,
    );
  }
});

test("keeps MCP preset identities and native definitions valid", () => {
  const ids = new Set<string>();
  const names = new Set<string>();

  for (const preset of CODEX_MCP_PRESETS) {
    assert.equal(ids.has(preset.id), false, `duplicate preset id: ${preset.id}`);
    assert.equal(
      names.has(preset.name),
      false,
      `duplicate MCP server name: ${preset.name}`,
    );
    assert.match(preset.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.doesNotThrow(() => new URL(preset.docsUrl));
    ids.add(preset.id);
    names.add(preset.name);

    if (preset.category !== "local") {
      assert.equal(preset.transport, "streamable-http");
      assert.equal(preset.command, undefined);
      assert.deepEqual(preset.args, undefined);
      const url = new URL(preset.url);
      assert.equal(url.protocol, "https:");
      assert.notEqual(url.hostname, "example.com");
    } else {
      assert.equal(preset.transport, "stdio");
      assert.ok(preset.command);
      assert.ok(preset.args?.length);
      assert.equal(preset.url, undefined);
    }
  }
});

test("uses the official OOMOL SaaS MCP endpoint for OpenConnector", () => {
  const preset = CODEX_MCP_PRESETS.find(
    (candidate) => candidate.id === "openconnector",
  );
  assert.ok(preset);
  assert.equal(preset.transport, "streamable-http");
  assert.equal(preset.url, "https://connector.oomol.com/v1/mcp");
});

test("builds isolated Codex server inputs from presets", () => {
  const preset = CODEX_MCP_PRESETS.find(
    (candidate) => candidate.id === "playwright",
  );
  assert.ok(preset);

  const first = codexMcpInputFromPreset(preset);
  const second = codexMcpInputFromPreset(preset);
  assert.notStrictEqual(first.args, second.args);
  assert.notStrictEqual(first.enabledTools, second.enabledTools);
  assert.notStrictEqual(first.disabledTools, second.disabledTools);

  first.args.push("--isolated");
  first.enabledTools.push("browser_navigate");
  assert.deepEqual(second.args, [
    "-y",
    "@playwright/mcp@latest",
    "--headless",
    "--no-sandbox",
  ]);
  assert.deepEqual(second.enabledTools, []);
  assert.deepEqual(preset.args, [
    "-y",
    "@playwright/mcp@latest",
    "--headless",
    "--no-sandbox",
  ]);
});

test("keeps the local MCP shortcut commands sandbox-ready", () => {
  const input = (id: string) => {
    const preset = CODEX_MCP_PRESETS.find((candidate) => candidate.id === id);
    assert.ok(preset);
    return codexMcpInputFromPreset(preset);
  };

  assert.deepEqual(input("playwright"), {
    transport: "stdio",
    command: "npx",
    args: [
      "-y",
      "@playwright/mcp@latest",
      "--headless",
      "--no-sandbox",
    ],
    url: undefined,
    enabled: true,
    required: false,
    startupTimeoutSec: 120,
    toolTimeoutSec: 120,
    defaultToolsApprovalMode: "prompt",
    enabledTools: [],
    disabledTools: [],
  });
  assert.deepEqual(input("filesystem").args, [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    "/workspace",
  ]);
  assert.deepEqual(input("sequential-thinking").args, [
    "-y",
    "@modelcontextprotocol/server-sequential-thinking",
  ]);
});

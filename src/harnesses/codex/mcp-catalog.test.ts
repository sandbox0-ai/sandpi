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
      assert.deepEqual(preset.network.endpointDomains, [url.hostname]);
    } else {
      assert.equal(preset.transport, "stdio");
      assert.ok(preset.command);
      assert.ok(preset.args?.length);
      assert.equal(preset.url, undefined);
    }

    if (preset.auth.requirement === "none") {
      assert.deepEqual(preset.auth.methods, []);
    } else {
      assert.ok(preset.auth.methods.length > 0);
    }
    assert.ok(preset.network.endpointDomains.length > 0);
  }
});

test("uses the official OOMOL SaaS MCP endpoint for OpenConnector", () => {
  const preset = CODEX_MCP_PRESETS.find(
    (candidate) => candidate.id === "openconnector",
  );
  assert.ok(preset);
  assert.equal(preset.transport, "streamable-http");
  assert.equal(preset.url, "https://connector.oomol.com/v1/mcp");
  assert.equal(preset.auth.requirement, "required");
  assert.deepEqual(preset.auth.methods, ["bearer"]);
  assert.equal(preset.auth.headerName, "Authorization");
});

test("uses the current Composio Connect endpoint and consumer key header", () => {
  const preset = CODEX_MCP_PRESETS.find(
    (candidate) => candidate.id === "composio-connect",
  );
  assert.ok(preset);
  assert.equal(preset.url, "https://connect.composio.dev/mcp");
  assert.equal(preset.auth.requirement, "required");
  assert.deepEqual(preset.auth.methods, ["header", "oauth"]);
  assert.equal(preset.auth.headerName, "x-consumer-api-key");
  assert.equal(preset.auth.valueTemplate, "{{ .token }}");
});

test("keeps the GitHub Copilot endpoint PAT-only", () => {
  const preset = CODEX_MCP_PRESETS.find(
    (candidate) => candidate.id === "github",
  );
  assert.ok(preset);
  assert.equal(preset.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(preset.connectionLabel, "PAT");
  assert.equal(preset.auth.requirement, "required");
  assert.deepEqual(preset.auth.methods, ["bearer"]);
  assert.equal(preset.auth.methods.includes("oauth"), false);
});

test("marks public and optional-key remote endpoints explicitly", () => {
  const preset = (id: string) => {
    const result = CODEX_MCP_PRESETS.find((candidate) => candidate.id === id);
    assert.ok(result);
    return result;
  };

  assert.deepEqual(preset("microsoft-learn").auth, {
    requirement: "none",
    methods: [],
  });
  assert.deepEqual(preset("context7").auth, {
    requirement: "optional",
    methods: ["header"],
    headerName: "CONTEXT7_API_KEY",
    valueTemplate: "{{ .token }}",
  });
});

test("builds isolated Codex server inputs from presets", () => {
  const preset = CODEX_MCP_PRESETS.find(
    (candidate) => candidate.id === "playwright",
  );
  assert.ok(preset);

  const first = codexMcpInputFromPreset(preset);
  const second = codexMcpInputFromPreset(preset);
  assert.notStrictEqual(first.args, second.args);

  first.args.push("--isolated");
  assert.deepEqual(second.args, [
    "-y",
    "@playwright/mcp@0.0.78",
    "--headless",
    "--no-sandbox",
  ]);
  assert.deepEqual(preset.args, [
    "-y",
    "@playwright/mcp@0.0.78",
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
      "@playwright/mcp@0.0.78",
      "--headless",
      "--no-sandbox",
    ],
    url: undefined,
    enabled: true,
    required: false,
    startupTimeoutSec: 120,
    toolTimeoutSec: 120,
    defaultToolsApprovalMode: "prompt",
    scopes: undefined,
  });
  assert.deepEqual(input("filesystem").args, [
    "-y",
    "@modelcontextprotocol/server-filesystem@2026.7.10",
    "/workspace",
  ]);
  assert.deepEqual(input("sequential-thinking").args, [
    "-y",
    "@modelcontextprotocol/server-sequential-thinking@2026.7.4",
  ]);
});

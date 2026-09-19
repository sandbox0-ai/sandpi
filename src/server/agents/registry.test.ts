import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ENVIRONMENT_AGENT_IDS } from "@/lib/types";

import {
  AGENT_ADAPTERS,
  agentSessionIdempotencyKey,
  agentSessionName,
} from "./registry";

test("registers every v2 Environment agent exactly once", () => {
  assert.deepEqual(Object.keys(AGENT_ADAPTERS).sort(), [
    ...ENVIRONMENT_AGENT_IDS,
  ].sort());

  for (const agentId of ENVIRONMENT_AGENT_IDS) {
    const adapter = AGENT_ADAPTERS[agentId];
    assert.equal(adapter.id, agentId);
    assert.ok(adapter.command.length > 0);
    assert.equal(adapter.runtimeRecovery, "restart");
    assert.equal(adapter.capabilities.structuredAutomation, false);
  }
});

test("scopes native agent sessions to the Environment and agent", () => {
  assert.equal(agentSessionName("claude-code"), "sandpi-agent-claude-code");
  assert.equal(
    agentSessionIdempotencyKey("env-1", "pi"),
    "sandpi-agent-pi-env-1",
  );
});

test("keeps managed credentials outside the persistent RootFS", () => {
  for (const adapter of Object.values(AGENT_ADAPTERS)) {
    assert.ok(
      adapter.credentialProjection.ephemeralPath?.startsWith("/dev/shm/"),
    );
    assert.ok(
      !adapter.persistentStatePaths.includes(
        adapter.credentialProjection.ephemeralPath ?? "",
      ),
    );
  }
});


test("Codex self-updates survive relaunch without replacing the template executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandpi-codex-update-"));
  const run = promisify(execFile);
  try {
    const templateBin = join(root, "template-bin");
    const prefix = join(root, "persistent npm");
    const fixture = join(root, "update-package");
    await mkdir(templateBin);
    await mkdir(fixture);
    const templateExecutable = join(templateBin, "codex");
    await writeFile(templateExecutable, "#!/bin/sh\nprintf template-version\n");
    await chmod(templateExecutable, 0o755);
    await writeFile(join(fixture, "package.json"), JSON.stringify({
      name: "sandpi-test-codex-update",
      version: "2.0.0",
      bin: { codex: "codex.js" },
    }));
    await writeFile(join(fixture, "codex.js"),
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({ version: "updated-version", args: process.argv.slice(2) }));\n',
    );
    await chmod(join(fixture, "codex.js"), 0o755);
    const adapter = AGENT_ADAPTERS.codex;
    const env = {
      ...process.env,
      ...adapter.environment,
      HOME: root,
      CODEX_HOME: join(root, "codex-home"),
      npm_config_prefix: prefix,
      npm_config_cache: join(root, "npm-cache"),
      PATH: `${templateBin}:${process.env.PATH}`,
    };
    const [command, ...args] = adapter.command;
    const launch = () => run(command, [...args, "argument with spaces"], { env, cwd: root });
    assert.equal((await launch()).stdout, "template-version");

    // Exercise npm's real global bin-link behavior offline, in a temporary
    // prefix. Like the native updater, npm inherits the agent environment.
    await run("npm", ["install", "--global", "--offline", "--ignore-scripts",
      "--no-audit", "--no-fund", fixture], { env, cwd: root });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = JSON.parse((await launch()).stdout);
      assert.equal(result.version, "updated-version");
      assert.ok(result.args.includes("--dangerously-bypass-approvals-and-sandbox"));
      assert.equal(result.args.at(-1), "argument with spaces");
    }
    assert.equal((await run(templateExecutable)).stdout, "template-version");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

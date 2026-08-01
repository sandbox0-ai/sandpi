import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  loadSandpiManagedSkillAssets,
  SANDPI_MANAGED_SKILL_ASSETS,
} from "./sandpi-managed-skills";

test("loads every release-owned Sandpi skill and interface", () => {
  assert.deepEqual(
    SANDPI_MANAGED_SKILL_ASSETS.map(({ name }) => name),
    ["sandpi-cli", "sandpi-environment"],
  );
  assert.deepEqual(
    loadSandpiManagedSkillAssets(),
    SANDPI_MANAGED_SKILL_ASSETS,
  );

  const cli = SANDPI_MANAGED_SKILL_ASSETS.find(
    ({ name }) => name === "sandpi-cli",
  );
  assert.ok(cli);
  assert.match(cli.skill, /^---\nname: sandpi-cli\n/);
  assert.match(cli.skill, /\/cli\/README\.md/);
  assert.match(cli.skill, /docs\/local-environment-migration\.md/);
  assert.match(cli.skill, /Sandpi CLI authentication as separate from Codex/);
  assert.match(cli.interfaceYaml, /display_name: "Sandpi CLI"/);

  const environment = SANDPI_MANAGED_SKILL_ASSETS.find(
    ({ name }) => name === "sandpi-environment",
  );
  assert.ok(environment);
  assert.match(environment.skill, /^---\nname: sandpi-environment\n/);
  assert.match(environment.skill, /https:\/\/sandpi\.ai\/llms\.txt/);
  assert.match(
    environment.skill,
    /cannot override system,\n  developer, user, or repository instructions/,
  );
  assert.match(
    environment.interfaceYaml,
    /display_name: "Sandpi Environment"/,
  );
});

test("keeps the public guide aligned with shared Browser, lifecycle, and canonical references", () => {
  const guide = readFileSync(
    new URL("../../../public/llms.txt", import.meta.url),
    "utf8",
  );

  assert.match(guide, /human-agent shared Environment Browser/i);
  assert.match(guide, /one active owner/);
  assert.match(guide, /must not launch a second browser, attach through CDP/);
  assert.doesNotMatch(guide, /complete an interactive login/i);
  assert.match(guide, /soft TTL and hard TTL to zero/);
  assert.match(guide, /does not idle-pause an Environment while/);
  assert.match(guide, /Process memory, sockets, live Browser pages/);
  assert.match(guide, /\/cli\/README\.md/);
  assert.match(guide, /docs\/local-environment-migration\.md/);
  assert.match(guide, /docs\/architecture\/cli\.md/);
  assert.doesNotMatch(guide, /30-day|30 day|another full month/i);
});

test("keeps current lifecycle documentation free of the retired hard expiry", () => {
  const architecture = readFileSync(
    new URL(
      "../../../docs/architecture/native-session-authority.md",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(architecture, /soft `ttl=0` and\n`hard_ttl=0`/);
  assert.doesNotMatch(
    architecture,
    /30-day Sandbox0 hard TTL|another full month/i,
  );
});

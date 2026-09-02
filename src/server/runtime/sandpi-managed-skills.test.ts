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

test("keeps the public guide aligned with v2 terminal authority and canonical references", () => {
  const guide = readFileSync(
    new URL("../../../public/llms.txt", import.meta.url),
    "utf8",
  );

  assert.match(guide, /## Native terminal/);
  assert.match(guide, /Sandpi renders the procd PTY/);
  assert.match(guide, /Only one browser tab holds the writable terminal controller lease/);
  assert.match(guide, /`ttyd` is installed as a pinned diagnostic/);
  assert.match(guide, /## Playwright CLI/);
  assert.match(guide, /provides its version-matched upstream Agent Skill/);
  assert.match(
    guide,
    /neither an Environment Browser nor an application\s+Preview tab/,
  );
  assert.match(guide, /browser executable must be\s+provisioned separately/);
  assert.match(guide, /soft TTL and hard TTL are zero/);
  assert.match(guide, /live PTY process/);
  assert.match(guide, /\/cli\/README\.md/);
  assert.match(guide, /docs\/local-environment-migration\.md/);
  assert.match(guide, /docs\/architecture\/cli\.md/);
  assert.match(guide, /docs\/architecture\/native-agent-terminal-authority\.md/);
  assert.doesNotMatch(guide, /30-day|30 day|another full month/i);
});

test("keeps current lifecycle documentation free of the retired hard expiry", () => {
  const architecture = readFileSync(
    new URL(
      "../../../docs/architecture/native-agent-terminal-authority.md",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(architecture, /Sandbox0 pause\/resume preserves a committed RootFS generation/);
  assert.doesNotMatch(
    architecture,
    /30-day Sandbox0 hard TTL|another full month/i,
  );
});

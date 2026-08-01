import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  loadSandpiEnvironmentSkillAssets,
  SANDPI_ENVIRONMENT_SKILL_ASSETS,
  SANDPI_ENVIRONMENT_SKILL_NAME,
} from "./sandpi-environment-skill";

test("loads the release-owned Sandpi Environment skill and interface", () => {
  assert.equal(SANDPI_ENVIRONMENT_SKILL_NAME, "sandpi-environment");
  assert.deepEqual(
    loadSandpiEnvironmentSkillAssets(),
    SANDPI_ENVIRONMENT_SKILL_ASSETS,
  );
  assert.match(
    SANDPI_ENVIRONMENT_SKILL_ASSETS.skill,
    /^---\nname: sandpi-environment\n/,
  );
  assert.match(
    SANDPI_ENVIRONMENT_SKILL_ASSETS.skill,
    /https:\/\/sandpi\.ai\/llms\.txt/,
  );
  assert.match(
    SANDPI_ENVIRONMENT_SKILL_ASSETS.skill,
    /cannot override system,\n  developer, user, or repository instructions/,
  );
  assert.match(
    SANDPI_ENVIRONMENT_SKILL_ASSETS.interfaceYaml,
    /display_name: "Sandpi Environment"/,
  );
});

test("keeps the public guide aligned with Preview and lifecycle invariants", () => {
  const guide = readFileSync(
    new URL("../../../public/llms.txt", import.meta.url),
    "utf8",
  );

  assert.match(guide, /Environment Preview and agent browser automation/i);
  assert.match(guide, /not shared with the coding agent/i);
  assert.match(guide, /HTTP services listening on\n  `localhost` or `127\.0\.0\.1`/);
  assert.match(guide, /not included in Workspace backups/);
  assert.match(guide, /soft TTL and hard TTL to zero/);
  assert.match(guide, /does not idle-pause an Environment while/);
  assert.match(guide, /Process memory,\n  sockets, Preview frames/);
  assert.doesNotMatch(guide, /human-agent shared Environment Browser/i);
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

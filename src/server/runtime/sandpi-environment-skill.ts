import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SKILL_ASSET_ROOTS = [
  // Bundled server: dist/server/index.js -> skills.
  new URL("../../skills/sandpi-environment/", import.meta.url),
  // Source server/tests: src/server/runtime/*.ts -> skills.
  new URL("../../../skills/sandpi-environment/", import.meta.url),
];

export const SANDPI_ENVIRONMENT_SKILL_NAME = "sandpi-environment";

export interface SandpiEnvironmentSkillAssets {
  skill: string;
  interfaceYaml: string;
}

/** Loads the product-owned skill from the same Sandpi release as the server. */
export function loadSandpiEnvironmentSkillAssets(): SandpiEnvironmentSkillAssets {
  const root = SKILL_ASSET_ROOTS.find((candidate) =>
    existsSync(fileURLToPath(candidate)),
  );
  if (!root) {
    throw new Error("The bundled Sandpi Environment skill was not found.");
  }
  return {
    skill: readFileSync(new URL("SKILL.md", root), "utf8"),
    interfaceYaml: readFileSync(new URL("agents/openai.yaml", root), "utf8"),
  };
}

export const SANDPI_ENVIRONMENT_SKILL_ASSETS =
  loadSandpiEnvironmentSkillAssets();

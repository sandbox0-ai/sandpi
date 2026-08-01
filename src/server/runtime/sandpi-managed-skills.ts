import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SKILL_ASSET_ROOTS = [
  // Bundled server: dist/server/index.js -> skills.
  new URL("../../skills/", import.meta.url),
  // Source server/tests: src/server/runtime/*.ts -> skills.
  new URL("../../../skills/", import.meta.url),
];
const MANAGED_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SandpiManagedSkillAssets {
  name: string;
  skill: string;
  interfaceYaml: string;
}

/** Loads every product-owned skill from the same Sandpi release as the server. */
export function loadSandpiManagedSkillAssets(): SandpiManagedSkillAssets[] {
  const root = SKILL_ASSET_ROOTS.find((candidate) =>
    existsSync(fileURLToPath(candidate)),
  );
  if (!root) {
    throw new Error("The bundled Sandpi managed skills were not found.");
  }

  const names = readdirSync(fileURLToPath(root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error("The bundled Sandpi managed skills are empty.");
  }

  return names.map((name) => {
    if (!MANAGED_SKILL_NAME.test(name)) {
      throw new Error(`Invalid bundled Sandpi skill name: ${name}`);
    }
    const skillUrl = new URL(`${name}/SKILL.md`, root);
    const interfaceUrl = new URL(`${name}/agents/openai.yaml`, root);
    if (
      !existsSync(fileURLToPath(skillUrl)) ||
      !existsSync(fileURLToPath(interfaceUrl))
    ) {
      throw new Error(`Bundled Sandpi skill ${name} is incomplete.`);
    }
    const skill = readFileSync(skillUrl, "utf8");
    if (!skill.startsWith(`---\nname: ${name}\n`)) {
      throw new Error(`Bundled Sandpi skill ${name} has mismatched metadata.`);
    }
    return {
      name,
      skill,
      interfaceYaml: readFileSync(interfaceUrl, "utf8"),
    };
  });
}

export const SANDPI_MANAGED_SKILL_ASSETS = loadSandpiManagedSkillAssets();

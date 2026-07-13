#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "@/server/config";
import { migrateDatabase } from "@/server/db/migrate";
import { createDatabasePool } from "@/server/db/pool";
import {
  codexCredentialAssociatedData,
  validateCodexCredentialJson,
} from "@/server/harnesses/codex/auth-service";
import { CodexAuthStore } from "@/server/harnesses/codex/auth-store";
import { SecretBox } from "@/server/secrets";

const MAX_CODEX_AUTH_BYTES = 4 * 1024 * 1024;

interface ImportOptions {
  environmentId: string;
  filePath: string;
}

export function parseImportOptions(argv: readonly string[]): ImportOptions {
  let environmentId: string | undefined;
  let filePath = path.join(os.homedir(), ".codex", "auth.json");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--environment") {
      environmentId = argv[++index];
    } else if (argument === "--file") {
      filePath = argv[++index] ?? "";
    } else if (argument === "--help" || argument === "-h") {
      throw new Error(usage());
    } else {
      throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    }
  }
  if (!environmentId) {
    throw new Error(`--environment is required.\n\n${usage()}`);
  }
  if (!filePath) throw new Error("--file must not be empty.");
  return {
    environmentId,
    filePath: filePath.startsWith("~/")
      ? path.join(os.homedir(), filePath.slice(2))
      : path.resolve(filePath),
  };
}

async function importCodexAuth(options: ImportOptions) {
  const config = loadConfig();
  if (!config.secretKey) {
    throw new Error("SANDPI_SECRET_KEY is required to import Codex credentials.");
  }
  const authBytes = await readFile(options.filePath);
  if (authBytes.byteLength === 0 || authBytes.byteLength > MAX_CODEX_AUTH_BYTES) {
    throw new Error("Codex auth.json must be between 1 byte and 4 MiB.");
  }
  const authJson = authBytes.toString("utf8");
  validateCodexCredentialJson(authJson);

  const pool = createDatabasePool({ connectionString: config.databaseUrl });
  try {
    await migrateDatabase(pool);
    const encrypted = new SecretBox(config.secretKey).encrypt(
      authJson,
      codexCredentialAssociatedData(options.environmentId),
    );
    const credential = await new CodexAuthStore(pool).importCredential({
      environmentId: options.environmentId,
      encrypted,
      metadata: {
        type: "imported-native-auth-json",
        account: "Imported Codex account",
        importedAt: new Date().toISOString(),
      },
    });
    process.stdout.write(
      `Imported Codex Credential Source ${credential.sourceId} revision ${credential.revision} for ${options.environmentId}.\n`,
    );
  } finally {
    await pool.end();
  }
}

function usage() {
  return [
    "Import a local native Codex auth cache into one Sandpi Environment.",
    "",
    "Usage:",
    "  sandpi-import-codex-auth --environment <id> [--file ~/.codex/auth.json]",
    "",
    "The command is deployment-side only and never exposes auth.json over HTTP.",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await importCodexAuth(parseImportOptions(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";

const MIGRATION_FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.sql$/;
const DEFAULT_MIGRATION_URLS = [
  // Bundled server: dist/server/index.js -> db/migrations.
  new URL("../../db/migrations/", import.meta.url),
  // Source server/tests: src/server/db/migrate.ts -> db/migrations.
  new URL("../../../db/migrations/", import.meta.url),
];

export interface Migration {
  version: string;
  fileName: string;
  checksum: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export function migrationVersion(fileName: string): string | undefined {
  return MIGRATION_FILE_PATTERN.exec(fileName)?.[1];
}

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function loadMigrations(
  migrationsDirectory: string | URL = defaultMigrationsDirectory(),
): Promise<Migration[]> {
  const directory =
    migrationsDirectory instanceof URL
      ? fileURLToPath(migrationsDirectory)
      : migrationsDirectory;
  const fileNames = (await readdir(directory))
    .filter((fileName) => migrationVersion(fileName) !== undefined)
    .sort((left, right) => left.localeCompare(right));
  const seenVersions = new Set<string>();

  return Promise.all(
    fileNames.map(async (fileName) => {
      const version = migrationVersion(fileName);
      if (!version) {
        throw new Error(`Invalid migration file name: ${fileName}`);
      }
      if (seenVersions.has(version)) {
        throw new Error(`Duplicate migration version: ${version}`);
      }
      seenVersions.add(version);

      const sql = await readFile(new URL(fileName, directoryUrl(directory)), "utf8");
      return {
        version,
        fileName,
        checksum: migrationChecksum(sql),
        sql,
      };
    }),
  );
}

function defaultMigrationsDirectory(): URL {
  const configured = process.env.SANDPI_MIGRATIONS_DIR;
  if (configured) return new URL(`file://${configured.replace(/\/$/, "")}/`);
  const found = DEFAULT_MIGRATION_URLS.find((candidate) =>
    existsSync(fileURLToPath(candidate)),
  );
  if (!found) {
    throw new Error(
      "Sandpi database migrations were not found; set SANDPI_MIGRATIONS_DIR.",
    );
  }
  return found;
}

function directoryUrl(directory: string): URL {
  const normalized = directory.endsWith("/") ? directory : `${directory}/`;
  return new URL(`file://${normalized}`);
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Applies pending migrations atomically while serializing concurrent runners. */
export async function migrateDatabase(
  pool: Pick<Pool, "connect">,
  migrations: readonly Migration[] | undefined = undefined,
): Promise<MigrationResult> {
  const pendingMigrations = migrations ?? (await loadMigrations());
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [728487217, 1]);
    await ensureMigrationTable(client);

    const result = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    const appliedChecksums = new Map(
      result.rows.map((row) => [row.version, row.checksum.trim()]),
    );
    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of pendingMigrations) {
      const existingChecksum = appliedChecksums.get(migration.version);
      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.version} was modified after it was applied.`,
          );
        }
        alreadyApplied.push(migration.version);
        continue;
      }

      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      );
      applied.push(migration.version);
    }

    await client.query("COMMIT");
    return { applied, alreadyApplied };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://sandpi@127.0.0.1:55432/sandpi",
  });
  try {
    const result = await migrateDatabase(pool);
    process.stdout.write(
      `Sandpi database migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already current.\n`,
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

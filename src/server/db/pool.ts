import { Pool, type PoolConfig } from "pg";

const DEFAULT_APPLICATION_NAME = "sandpi-server";

export function requireDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to connect to Sandpi PostgreSQL.");
  }

  return databaseUrl;
}

/**
 * Creates the process-wide PostgreSQL pool. Callers may inject a complete pg
 * configuration for tests or embedding; otherwise the deployment-owned
 * DATABASE_URL is used.
 */
export function createDatabasePool(config?: PoolConfig): Pool {
  if (config) {
    return new Pool({
      application_name: DEFAULT_APPLICATION_NAME,
      ...config,
    });
  }

  return new Pool({
    application_name: DEFAULT_APPLICATION_NAME,
    connectionString: requireDatabaseUrl(),
  });
}

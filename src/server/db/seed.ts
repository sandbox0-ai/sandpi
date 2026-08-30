import type { Pool } from "pg";

export interface CommunitySeedOptions {
  admin?: Partial<CommunitySeed["admin"]>;
  environment?: Partial<CommunitySeed["environment"]>;
}

export interface CommunitySeed {
  admin: {
    id: string;
    email: string;
    name: string;
    avatarInitials: string;
    identityProvider: string;
    identitySubject: string;
  };
  environment: {
    id: string;
    name: string;
    description: string;
    color: string;
    harness: string;
  };
}

export const COMMUNITY_DEFAULT_SEED = {
  admin: {
    id: "user-admin",
    email: "admin@sandpi.local",
    name: "Administrator",
    avatarInitials: "AD",
    identityProvider: "builtin",
    identitySubject: "admin",
  },
  environment: {
    id: "env-default",
    name: "Development",
    description: "The shared starting point for coding sessions.",
    color: "#151515",
    harness: "codex",
  },
} as const;

export function buildCommunitySeed(
  options: CommunitySeedOptions = {},
): CommunitySeed {
  return {
    admin: { ...COMMUNITY_DEFAULT_SEED.admin, ...options.admin },
    environment: {
      ...COMMUNITY_DEFAULT_SEED.environment,
      ...options.environment,
    },
  };
}

/**
 * Seeds the self-hosted administrator and their initial Environment without
 * overwriting later user edits. Each insert is independently idempotent so an
 * interrupted startup can safely retry the whole transaction.
 */
export async function seedCommunityDefaults(
  pool: Pick<Pool, "connect">,
  options: CommunitySeedOptions = {},
): Promise<CommunitySeed> {
  const seed = buildCommunitySeed(options);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO users (
          id, email, name, avatar_initials, identity_provider, identity_subject
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        seed.admin.id,
        seed.admin.email,
        seed.admin.name,
        seed.admin.avatarInitials,
        seed.admin.identityProvider,
        seed.admin.identitySubject,
      ],
    );
    await client.query(
      `
        INSERT INTO user_preferences (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
      `,
      [seed.admin.id],
    );
    await client.query(
      `
        INSERT INTO environments (
          id, created_by_user_id, name, description, color, status,
          revision, template_id, rootfs_snapshot_id,
          credential_revision, harness, harness_metadata, network_policy,
          metadata, display_order
        ) VALUES (
          $1, $2, $3, $4, $5, 'updating', 1, 'coding-agent', NULL, 0, $6,
          $7::JSONB, $8::JSONB, $9::JSONB, 0
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        seed.environment.id,
        seed.admin.id,
        seed.environment.name,
        seed.environment.description,
        seed.environment.color,
        seed.environment.harness,
        JSON.stringify({ label: "Codex", status: "not-connected" }),
        JSON.stringify({
          mode: "allow-all",
          domainExceptions: [],
        }),
        JSON.stringify({
          managedBy: "sandpi",
          purpose: "community-default",
        }),
      ],
    );
    await client.query("COMMIT");
    return seed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

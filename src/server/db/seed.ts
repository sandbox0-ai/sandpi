import type { Pool } from "pg";

export interface CommunitySeedOptions {
  now?: Date;
  admin?: Partial<CommunitySeed["admin"]>;
  team?: Partial<CommunitySeed["team"]>;
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
  team: {
    id: string;
    name: string;
    slug: string;
    color: string;
    billingAccountId: string;
    billingEmail: string;
  };
  membership: {
    id: string;
    planAssignmentId: string;
  };
  environment: {
    id: string;
    name: string;
    description: string;
    color: string;
    harness: string;
  };
  periodStartsAt: Date;
  periodEndsAt: Date;
  weeklyQuotaResetsAt: Date;
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
  team: {
    id: "team-default",
    name: "Sandpi",
    slug: "sandpi",
    color: "#315c4b",
    billingAccountId: "billing-default",
    billingEmail: "admin@sandpi.local",
  },
  membership: {
    id: "membership-admin-default",
    planAssignmentId: "plan-admin-default",
  },
  environment: {
    id: "env-default",
    name: "Development",
    description: "The shared starting point for coding sessions.",
    color: "#151515",
    harness: "codex",
  },
} as const;

function addUtcMonths(value: Date, months: number): Date {
  const result = new Date(value);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function buildCommunitySeed(
  options: CommunitySeedOptions = {},
): CommunitySeed {
  const periodStartsAt = new Date(options.now ?? new Date());
  if (Number.isNaN(periodStartsAt.getTime())) {
    throw new Error("The community seed timestamp must be a valid Date.");
  }

  return {
    admin: { ...COMMUNITY_DEFAULT_SEED.admin, ...options.admin },
    team: { ...COMMUNITY_DEFAULT_SEED.team, ...options.team },
    membership: { ...COMMUNITY_DEFAULT_SEED.membership },
    environment: {
      ...COMMUNITY_DEFAULT_SEED.environment,
      ...options.environment,
    },
    periodStartsAt,
    periodEndsAt: addUtcMonths(periodStartsAt, 1),
    weeklyQuotaResetsAt: addUtcDays(periodStartsAt, 7),
  };
}

/**
 * Seeds the self-hosted identity and tenant without overwriting later user
 * edits. Each insert is independently idempotent so interrupted startup can
 * safely retry the whole seed transaction.
 */
export async function seedCommunityDefaults(
  pool: Pick<Pool, "connect">,
  options: CommunitySeedOptions = {},
): Promise<CommunitySeed> {
  const seed = buildCommunitySeed(options);
  const client = await pool.connect();
  const planQuotas = {
    weeklyExecution: {
      used: 0,
      limit: 600,
      unit: "minute",
      window: "weekly",
      resetsAt: seed.weeklyQuotaResetsAt.toISOString(),
    },
    concurrentSessions: { used: 0, limit: 1, unit: "session" },
    snapshotStorage: { used: 0, limit: 5, unit: "gibibyte" },
  };

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
        INSERT INTO teams (
          id, name, slug, color, billing_account_id, billing_status,
          billing_email, billing_period_starts_at, billing_period_ends_at
        ) VALUES ($1, $2, $3, $4, $5, 'deployment-managed', $6, $7, $8)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        seed.team.id,
        seed.team.name,
        seed.team.slug,
        seed.team.color,
        seed.team.billingAccountId,
        seed.team.billingEmail,
        seed.periodStartsAt,
        seed.periodEndsAt,
      ],
    );
    await client.query(
      `
        INSERT INTO team_memberships (
          id, team_id, user_id, role, status, plan_assignment_id, plan_id,
          plan_status, plan_period_starts_at, plan_period_ends_at,
          plan_quotas, joined_at
        ) VALUES (
          $1, $2, $3, 'owner', 'active', $4, 'free', 'active',
          $5, $6, $7::JSONB, $5
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        seed.membership.id,
        seed.team.id,
        seed.admin.id,
        seed.membership.planAssignmentId,
        seed.periodStartsAt,
        seed.periodEndsAt,
        JSON.stringify(planQuotas),
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
          id, team_id, created_by_user_id, name, description, color, status,
          revision, template_id, rootfs_snapshot_id, workspace_volume_id,
          credential_revision, harness, harness_metadata, network_policy,
          functions, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 'updating', 1, 'coding-agent', NULL, NULL, 0, $7,
          $8::JSONB, $9::JSONB, '[]'::JSONB, $10::JSONB
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        seed.environment.id,
        seed.team.id,
        seed.admin.id,
        seed.environment.name,
        seed.environment.description,
        seed.environment.color,
        seed.environment.harness,
        JSON.stringify({ label: "Codex", status: "not-connected" }),
        JSON.stringify({
          mode: "allow-all",
          allowedDomains: [],
          logDeniedRequests: true,
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

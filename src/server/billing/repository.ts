import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  SandpiPlanId,
  SandpiSubscriptionStatus,
} from "@/lib/billing";

export interface BillingAccountRecord {
  userId: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface SubscriptionRecord {
  userId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  planId: "plus" | "pro";
  status: SandpiSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodStartsAt?: Date;
  currentPeriodEndsAt?: Date;
  quotaAnchorAt?: Date;
  graceEndsAt?: Date;
  pendingPlanId?: "plus" | "pro";
  pendingPriceId?: string;
  pendingEffectiveAt?: Date;
}

export interface UsageWindowImport {
  windowId: string;
  sandboxId: string;
  windowType: string;
  windowStartsAt: Date;
  windowEndsAt: Date;
  value: number;
  unit: string;
  recordedAt: Date;
}

export interface UsageTotals {
  confirmedMiBMilliseconds: number;
  projectedMiBMilliseconds: number;
}

export interface EnvironmentEntitlementPosition {
  userId: string;
  position: number;
  environmentCount: number;
}

export interface RunningEnvironmentCandidate
  extends EnvironmentEntitlementPosition {
  environmentId: string;
  sandboxId: string;
}

export type WebhookEventClaim =
  | { status: "claimed"; attempt: number }
  | { status: "processed" }
  | { status: "busy" };

interface AccountRow extends QueryResultRow {
  id: string;
  email: string;
  name: string;
  created_at: Date;
}

interface SubscriptionRow extends QueryResultRow {
  user_id: string;
  stripe_subscription_id: string;
  stripe_price_id: string;
  plan_id: "plus" | "pro";
  status: SandpiSubscriptionStatus;
  cancel_at_period_end: boolean;
  current_period_starts_at: Date | null;
  current_period_ends_at: Date | null;
  quota_anchor_at: Date | null;
  grace_ends_at: Date | null;
  pending_plan_id: "plus" | "pro" | null;
  pending_price_id: string | null;
  pending_effective_at: Date | null;
}

export class BillingRepository {
  constructor(private readonly pool: Pool) {}

  async account(userId: string): Promise<BillingAccountRecord | undefined> {
    const result = await this.pool.query<AccountRow>(
      `SELECT id, email, name, created_at
       FROM users
       WHERE id = $1 AND status = 'active'`,
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          userId: row.id,
          email: row.email,
          name: row.name,
          createdAt: row.created_at,
        }
      : undefined;
  }

  async stripeCustomerId(userId: string) {
    const result = await this.pool.query<{ stripe_customer_id: string }>(
      "SELECT stripe_customer_id FROM stripe_customers WHERE user_id = $1",
      [userId],
    );
    return result.rows[0]?.stripe_customer_id;
  }

  async userIdForStripeCustomer(stripeCustomerId: string) {
    const result = await this.pool.query<{ user_id: string }>(
      "SELECT user_id FROM stripe_customers WHERE stripe_customer_id = $1",
      [stripeCustomerId],
    );
    return result.rows[0]?.user_id;
  }

  async saveStripeCustomer(userId: string, stripeCustomerId: string) {
    await this.pool.query(
      `INSERT INTO stripe_customers (user_id, stripe_customer_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
       SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
      [userId, stripeCustomerId],
    );
  }

  async subscription(userId: string): Promise<SubscriptionRecord | undefined> {
    const result = await this.pool.query<SubscriptionRow>(
      "SELECT * FROM user_subscriptions WHERE user_id = $1",
      [userId],
    );
    return subscriptionFromRow(result.rows[0]);
  }

  async upsertSubscription(input: SubscriptionRecord) {
    await this.pool.query(
      `INSERT INTO user_subscriptions (
         user_id,
         stripe_subscription_id,
         stripe_price_id,
         plan_id,
         status,
         cancel_at_period_end,
         current_period_starts_at,
         current_period_ends_at,
         quota_anchor_at,
         grace_ends_at,
         pending_plan_id,
         pending_price_id,
         pending_effective_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       )
       ON CONFLICT (user_id) DO UPDATE
       SET stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           stripe_price_id = EXCLUDED.stripe_price_id,
           plan_id = EXCLUDED.plan_id,
           status = EXCLUDED.status,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           current_period_starts_at = EXCLUDED.current_period_starts_at,
           current_period_ends_at = EXCLUDED.current_period_ends_at,
           quota_anchor_at = COALESCE(
             user_subscriptions.quota_anchor_at,
             EXCLUDED.quota_anchor_at
           ),
           grace_ends_at = EXCLUDED.grace_ends_at,
           pending_plan_id = EXCLUDED.pending_plan_id,
           pending_price_id = EXCLUDED.pending_price_id,
           pending_effective_at = EXCLUDED.pending_effective_at`,
      [
        input.userId,
        input.stripeSubscriptionId,
        input.stripePriceId,
        input.planId,
        input.status,
        input.cancelAtPeriodEnd,
        input.currentPeriodStartsAt ?? null,
        input.currentPeriodEndsAt ?? null,
        input.quotaAnchorAt ?? null,
        input.graceEndsAt ?? null,
        input.pendingPlanId ?? null,
        input.pendingPriceId ?? null,
        input.pendingEffectiveAt ?? null,
      ],
    );
  }

  async environmentCount(userId: string) {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count
       FROM environments
       WHERE created_by_user_id = $1 AND status <> 'archived'`,
      [userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async environmentEntitlementPosition(
    environmentId: string,
  ): Promise<EnvironmentEntitlementPosition | undefined> {
    const result = await this.pool.query<{
      user_id: string;
      position: string;
      environment_count: string;
    }>(
      `WITH ranked AS (
         SELECT
           id,
           created_by_user_id AS user_id,
           ROW_NUMBER() OVER (
             PARTITION BY created_by_user_id
             ORDER BY created_at, id
           ) AS position,
           COUNT(*) OVER (
             PARTITION BY created_by_user_id
           ) AS environment_count
         FROM environments
         WHERE status <> 'archived'
       )
       SELECT user_id, position::TEXT, environment_count::TEXT
       FROM ranked
       WHERE id = $1`,
      [environmentId],
    );
    const row = result.rows[0];
    return row
      ? {
          userId: row.user_id,
          position: Number(row.position),
          environmentCount: Number(row.environment_count),
        }
      : undefined;
  }

  async usageTotals(
    userId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<UsageTotals> {
    const [confirmed, projected] = await Promise.all([
      this.pool.query<{ value: string }>(
        `SELECT COALESCE(
           FLOOR(SUM(
             CASE
               WHEN window_ends_at = window_starts_at THEN value::NUMERIC
               ELSE value::NUMERIC
                 * EXTRACT(EPOCH FROM (
                     LEAST(window_ends_at, $3)
                     - GREATEST(window_starts_at, $2)
                   ))
                 / NULLIF(
                     EXTRACT(EPOCH FROM (window_ends_at - window_starts_at)),
                     0
                   )
             END
           )),
           0
         )::TEXT AS value
         FROM sandbox_usage_windows
         WHERE user_id = $1
           AND unit = 'mib_milliseconds'
           AND window_starts_at < $3
           AND window_ends_at > $2`,
        [userId, startsAt, endsAt],
      ),
      this.pool.query<{ value: string }>(
        `SELECT COALESCE(
           FLOOR(SUM(
             memory_mib::NUMERIC
             * EXTRACT(EPOCH FROM (
                 LEAST(COALESCE(ended_at, NOW()), $3)
                 - GREATEST(started_at, $2)
               ))
             * 1000
           )),
           0
         )::TEXT AS value
         FROM sandbox_runtime_segments
         WHERE user_id = $1
           AND started_at < $3
           AND COALESCE(ended_at, NOW()) > $2`,
        [userId, startsAt, endsAt],
      ),
    ]);
    return {
      confirmedMiBMilliseconds: Number(confirmed.rows[0]?.value ?? 0),
      projectedMiBMilliseconds: Number(projected.rows[0]?.value ?? 0),
    };
  }

  async usageCursor(source: string) {
    const result = await this.pool.query<{ cursor: string }>(
      "SELECT cursor FROM usage_import_cursors WHERE source = $1",
      [source],
    );
    return result.rows[0]?.cursor ?? "";
  }

  async importUsageWindows(
    source: string,
    nextCursor: string,
    windows: readonly UsageWindowImport[],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const window of windows) {
        await client.query(
          `INSERT INTO sandbox_usage_windows (
             window_id,
             user_id,
             environment_id,
             sandbox_id,
             window_type,
             window_starts_at,
             window_ends_at,
             value,
             unit,
             recorded_at
           )
           SELECT
             $1,
             attribution.user_id,
             attribution.environment_id,
             attribution.sandbox_id,
             $3,
             $4,
             $5,
             $6,
             $7,
             $8
           FROM sandbox_usage_attributions attribution
           WHERE attribution.sandbox_id = $2
           ON CONFLICT (window_id) DO NOTHING`,
          [
            window.windowId,
            window.sandboxId,
            window.windowType,
            window.windowStartsAt,
            window.windowEndsAt,
            window.value,
            window.unit,
            window.recordedAt,
          ],
        );
      }
      await client.query(
        `INSERT INTO usage_import_cursors (source, cursor)
         VALUES ($1, $2)
         ON CONFLICT (source) DO UPDATE
         SET cursor = EXCLUDED.cursor, updated_at = NOW()`,
        [source, nextCursor],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async runningEnvironmentCandidates(): Promise<RunningEnvironmentCandidate[]> {
    const result = await this.pool.query<{
      environment_id: string;
      sandbox_id: string;
      user_id: string;
      position: string;
      environment_count: string;
    }>(
      `WITH ranked AS (
         SELECT
           id,
           created_by_user_id AS user_id,
           ROW_NUMBER() OVER (
             PARTITION BY created_by_user_id
             ORDER BY created_at, id
           ) AS position,
           COUNT(*) OVER (
             PARTITION BY created_by_user_id
           ) AS environment_count
         FROM environments
         WHERE status <> 'archived'
       )
       SELECT
         ranked.id AS environment_id,
         runtime.sandbox_id,
         ranked.user_id,
         ranked.position::TEXT,
         ranked.environment_count::TEXT
       FROM ranked
       JOIN environment_runtime runtime
         ON runtime.environment_id = ranked.id
       WHERE runtime.sandbox_id IS NOT NULL
         AND runtime.desired_state <> 'terminated'
       ORDER BY ranked.user_id, ranked.position`,
    );
    return result.rows.map((row) => ({
      environmentId: row.environment_id,
      sandboxId: row.sandbox_id,
      userId: row.user_id,
      position: Number(row.position),
      environmentCount: Number(row.environment_count),
    }));
  }

  async recordWebhookEvent(input: {
    id: string;
    type: string;
    payload: object;
  }): Promise<WebhookEventClaim> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`sandpi:stripe-webhook:${input.id}`],
      );
      await client.query(
        `INSERT INTO stripe_webhook_events (
           stripe_event_id, event_type, payload
         ) VALUES ($1, $2, $3::JSONB)
         ON CONFLICT (stripe_event_id) DO NOTHING`,
        [input.id, input.type, JSON.stringify(input.payload)],
      );
      const claimed = await client.query<{ attempts: number }>(
        `UPDATE stripe_webhook_events
         SET attempts = attempts + 1,
             processing_started_at = NOW(),
             processing_error = NULL
         WHERE stripe_event_id = $1
           AND processed_at IS NULL
           AND (
             processing_started_at IS NULL
             OR processing_started_at < NOW() - INTERVAL '5 minutes'
           )
         RETURNING attempts`,
        [input.id],
      );
      let claim: WebhookEventClaim;
      const attempt = claimed.rows[0]?.attempts;
      if (attempt != null) {
        claim = { status: "claimed", attempt };
      } else {
        const state = await client.query<{ processed: boolean }>(
          `SELECT processed_at IS NOT NULL AS processed
           FROM stripe_webhook_events
           WHERE stripe_event_id = $1`,
          [input.id],
        );
        claim = state.rows[0]?.processed
          ? { status: "processed" }
          : { status: "busy" };
      }
      await client.query("COMMIT");
      return claim;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeWebhookEvent(eventId: string, attempt: number) {
    await this.pool.query(
      `UPDATE stripe_webhook_events
       SET processed_at = NOW(), processing_started_at = NULL,
           processing_error = NULL
       WHERE stripe_event_id = $1
         AND attempts = $2
         AND processed_at IS NULL`,
      [eventId, attempt],
    );
  }

  async failWebhookEvent(eventId: string, attempt: number, error: string) {
    await this.pool.query(
      `UPDATE stripe_webhook_events
       SET processing_started_at = NULL, processing_error = $2
       WHERE stripe_event_id = $1
         AND attempts = $3
         AND processed_at IS NULL`,
      [eventId, error.slice(0, 4_000), attempt],
    );
  }

  async withClient<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }
}

function subscriptionFromRow(
  row: SubscriptionRow | undefined,
): SubscriptionRecord | undefined {
  return row
    ? {
        userId: row.user_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        stripePriceId: row.stripe_price_id,
        planId: row.plan_id,
        status: row.status,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        currentPeriodStartsAt: row.current_period_starts_at ?? undefined,
        currentPeriodEndsAt: row.current_period_ends_at ?? undefined,
        quotaAnchorAt: row.quota_anchor_at ?? undefined,
        graceEndsAt: row.grace_ends_at ?? undefined,
        pendingPlanId: row.pending_plan_id ?? undefined,
        pendingPriceId: row.pending_price_id ?? undefined,
        pendingEffectiveAt: row.pending_effective_at ?? undefined,
      }
    : undefined;
}

export function paidPlanId(value: SandpiPlanId): value is "plus" | "pro" {
  return value === "plus" || value === "pro";
}

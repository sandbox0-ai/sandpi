-- Existing Environments were created while Sandpi treated them as creator-only.
-- Preserve that privacy during upgrade, then make Team visibility the default
-- for every Environment created after this migration.
ALTER TABLE environments
    ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('team', 'private'));

ALTER TABLE environments
    ALTER COLUMN visibility SET DEFAULT 'team';

COMMENT ON COLUMN environments.visibility IS
    'Team Environments are available to every active Team member; private Environments are available only to their creator.';

-- A Session carries a denormalized Team id for tenant-scoped indexes. Enforce
-- that it can never disagree with the owning Environment.
ALTER TABLE environments
    ADD CONSTRAINT environments_id_team_unique UNIQUE (id, team_id);

-- Environment ownership is authoritative. Repair any legacy denormalized Team
-- drift before installing the invariant.
UPDATE sessions session
SET team_id = environment.team_id
FROM environments environment
WHERE environment.id = session.environment_id
  AND session.team_id <> environment.team_id;

ALTER TABLE sessions
    ADD CONSTRAINT sessions_environment_team_fk
        FOREIGN KEY (environment_id, team_id)
        REFERENCES environments (id, team_id)
        ON DELETE RESTRICT;

-- Plans and quotas belong to the Team. During migration, retain the highest
-- active Membership Plan in each Team so an existing multi-member Team is not
-- silently downgraded. Membership usage was only a UI projection, so the
-- selected Plan projection becomes the initial Team projection.
ALTER TABLE teams
    ADD COLUMN plan_id TEXT,
    ADD COLUMN plan_status TEXT,
    ADD COLUMN plan_quotas JSONB;

WITH ranked_plan AS (
    SELECT DISTINCT ON (membership.team_id)
        membership.team_id,
        membership.plan_id,
        membership.plan_status,
        membership.plan_quotas
    FROM team_memberships membership
    ORDER BY
        membership.team_id,
        CASE membership.status WHEN 'active' THEN 0 ELSE 1 END,
        CASE membership.plan_status WHEN 'active' THEN 0 ELSE 1 END,
        CASE membership.plan_id WHEN 'max' THEN 0 WHEN 'pro' THEN 1 ELSE 2 END,
        CASE membership.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
        membership.joined_at,
        membership.id
)
UPDATE teams team
SET plan_id = ranked_plan.plan_id,
    plan_status = ranked_plan.plan_status,
    plan_quotas = ranked_plan.plan_quotas
FROM ranked_plan
WHERE ranked_plan.team_id = team.id;

UPDATE teams
SET plan_id = COALESCE(plan_id, 'free'),
    plan_status = COALESCE(plan_status, 'active'),
    plan_quotas = COALESCE(
        plan_quotas,
        '{
          "weeklyExecution": {
            "used": 0,
            "limit": 600,
            "unit": "minute",
            "window": "weekly",
            "resetsAt": "1970-01-01T00:00:00Z"
          },
          "concurrentSessions": {
            "used": 0,
            "limit": 1,
            "unit": "session"
          },
          "snapshotStorage": {
            "used": 0,
            "limit": 5,
            "unit": "gibibyte"
          }
        }'::JSONB
    );

ALTER TABLE teams
    ALTER COLUMN plan_id SET NOT NULL,
    ALTER COLUMN plan_id SET DEFAULT 'free',
    ALTER COLUMN plan_status SET NOT NULL,
    ALTER COLUMN plan_status SET DEFAULT 'active',
    ALTER COLUMN plan_quotas SET NOT NULL,
    ADD CONSTRAINT teams_plan_id_check
        CHECK (plan_id IN ('free', 'pro', 'max')),
    ADD CONSTRAINT teams_plan_status_check
        CHECK (plan_status IN ('active', 'pending', 'suspended')),
    ADD CONSTRAINT teams_plan_quotas_object_check
        CHECK (jsonb_typeof(plan_quotas) = 'object');

COMMENT ON COLUMN teams.plan_id IS
    'The Sandpi Plan belongs to the Team, never to an individual Membership.';
COMMENT ON COLUMN teams.plan_quotas IS
    'Current Team-wide usage projection and effective quota limits for the Team Plan.';

ALTER TABLE team_memberships
    DROP COLUMN plan_assignment_id,
    DROP COLUMN plan_id,
    DROP COLUMN plan_status,
    DROP COLUMN plan_period_starts_at,
    DROP COLUMN plan_period_ends_at,
    DROP COLUMN plan_quotas;

COMMENT ON TABLE team_memberships IS
    'Memberships grant Team access and roles. Plans and quotas belong to teams.';

-- Sandpi resources are user-owned. Existing shared Environments remain with
-- their original creator; legacy rows without a creator are assigned to the
-- first active owner/admin/member of their former tenant.
WITH ranked_environment_owners AS (
    SELECT
        environment.id AS environment_id,
        membership.user_id,
        ROW_NUMBER() OVER (
            PARTITION BY environment.id
            ORDER BY
                CASE membership.status WHEN 'active' THEN 0 ELSE 1 END,
                CASE membership.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                membership.joined_at,
                membership.id
        ) AS rank
    FROM environments environment
    JOIN team_memberships membership
      ON membership.team_id = environment.team_id
    WHERE environment.created_by_user_id IS NULL
)
UPDATE environments environment
SET created_by_user_id = owner.user_id
FROM ranked_environment_owners owner
WHERE owner.environment_id = environment.id
  AND owner.rank = 1;

DO $ownership$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM environments
        WHERE created_by_user_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Cannot migrate an Environment without a creator or legacy membership';
    END IF;
END;
$ownership$;

UPDATE sessions session
SET created_by_user_id = environment.created_by_user_id
FROM environments environment
WHERE environment.id = session.environment_id
  AND session.created_by_user_id IS NULL;

ALTER TABLE sessions
    DROP CONSTRAINT IF EXISTS sessions_environment_team_fk;
ALTER TABLE environments
    DROP CONSTRAINT IF EXISTS environments_id_team_unique;

DROP INDEX IF EXISTS environments_team_status_idx;
DROP INDEX IF EXISTS sessions_team_status_idx;

ALTER TABLE environments
    DROP CONSTRAINT environments_created_by_user_id_fkey,
    ALTER COLUMN created_by_user_id SET NOT NULL,
    ADD CONSTRAINT environments_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id)
        REFERENCES users (id)
        ON DELETE RESTRICT,
    DROP COLUMN visibility,
    DROP COLUMN team_id;

CREATE INDEX environments_owner_status_idx
    ON environments (created_by_user_id, status, updated_at DESC);

ALTER TABLE sessions
    DROP CONSTRAINT sessions_created_by_user_id_fkey,
    ALTER COLUMN created_by_user_id SET NOT NULL,
    ADD CONSTRAINT sessions_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id)
        REFERENCES users (id)
        ON DELETE RESTRICT,
    DROP COLUMN team_id;

CREATE INDEX sessions_creator_status_idx
    ON sessions (created_by_user_id, status, updated_at DESC);

ALTER TABLE auth_sessions
    DROP COLUMN active_team_id;

WITH ranked_tenant_owners AS (
    SELECT
        membership.team_id,
        membership.user_id,
        ROW_NUMBER() OVER (
            PARTITION BY membership.team_id
            ORDER BY
                CASE membership.status WHEN 'active' THEN 0 ELSE 1 END,
                CASE membership.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                membership.joined_at,
                membership.id
        ) AS rank
    FROM team_memberships membership
)
UPDATE idempotency_keys key
SET user_id = owner.user_id
FROM ranked_tenant_owners owner
WHERE key.team_id = owner.team_id
  AND key.user_id IS NULL
  AND owner.rank = 1;

DO $idempotency_ownership$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM idempotency_keys
        WHERE user_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Cannot migrate an idempotency key without a user';
    END IF;
END;
$idempotency_ownership$;

ALTER TABLE idempotency_keys
    DROP CONSTRAINT idempotency_keys_user_id_fkey,
    ALTER COLUMN user_id SET NOT NULL,
    ADD CONSTRAINT idempotency_keys_user_id_fkey
        FOREIGN KEY (user_id)
        REFERENCES users (id)
        ON DELETE CASCADE,
    DROP COLUMN team_id,
    ADD CONSTRAINT idempotency_keys_user_operation_key_unique
        UNIQUE (user_id, operation, key_hash);

ALTER TABLE outbox
    ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

WITH ranked_tenant_owners AS (
    SELECT
        membership.team_id,
        membership.user_id,
        ROW_NUMBER() OVER (
            PARTITION BY membership.team_id
            ORDER BY
                CASE membership.status WHEN 'active' THEN 0 ELSE 1 END,
                CASE membership.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                membership.joined_at,
                membership.id
        ) AS rank
    FROM team_memberships membership
)
UPDATE outbox event
SET user_id = owner.user_id
FROM ranked_tenant_owners owner
WHERE event.team_id = owner.team_id
  AND owner.rank = 1;

ALTER TABLE outbox
    DROP COLUMN team_id;

DROP TABLE team_memberships;
DROP TABLE teams;

COMMENT ON COLUMN environments.created_by_user_id IS
    'The user who owns and is authorized to access this Environment.';
COMMENT ON COLUMN sessions.created_by_user_id IS
    'The user who created this Session inside their Environment.';

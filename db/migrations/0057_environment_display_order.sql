ALTER TABLE environments
    ADD COLUMN display_order INTEGER;

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY created_by_user_id
               ORDER BY created_at, id
           ) - 1 AS display_order
    FROM environments
)
UPDATE environments environment
SET display_order = ranked.display_order
FROM ranked
WHERE ranked.id = environment.id;

ALTER TABLE environments
    ALTER COLUMN display_order SET NOT NULL;

CREATE INDEX environments_owner_display_order_idx
    ON environments (created_by_user_id, display_order, id)
    WHERE status <> 'archived';

COMMENT ON COLUMN environments.display_order IS
    'Zero-based user-controlled ordering among Environments owned by the same user.';

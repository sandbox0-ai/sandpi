ALTER TABLE user_preferences
    ALTER COLUMN time_zone SET DEFAULT 'auto';

-- UTC was the implicit value before users could choose a global time zone. Move
-- those existing defaults to client-local display; UTC remains selectable later.
UPDATE user_preferences
SET time_zone = 'auto'
WHERE time_zone = 'UTC';

COMMENT ON COLUMN user_preferences.time_zone IS
    'Global display time zone. auto delegates to the current client time zone.';

ALTER TABLE user_preferences
    DROP COLUMN IF EXISTS notify_session_completed,
    DROP COLUMN IF EXISTS notify_needs_attention;

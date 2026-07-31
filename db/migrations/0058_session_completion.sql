ALTER TABLE sessions
    ADD COLUMN completed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN sessions.completed IS
    'User-managed completion state, independent from archival and native harness runtime status.';

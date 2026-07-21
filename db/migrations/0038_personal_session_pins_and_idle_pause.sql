-- Pinning is a personal navigation preference. Preserve each legacy global
-- pin for the Session creator, then remove the shared Session state.
CREATE TABLE session_pins (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, user_id)
);

INSERT INTO session_pins (session_id, user_id)
SELECT session.id, session.created_by_user_id
FROM sessions session
WHERE session.pinned = TRUE
  AND session.created_by_user_id IS NOT NULL
ON CONFLICT (session_id, user_id) DO NOTHING;

DROP INDEX sessions_environment_list_idx;

ALTER TABLE sessions
    DROP COLUMN pinned;

CREATE INDEX sessions_environment_list_idx
    ON sessions (environment_id, archived, updated_at DESC);

COMMENT ON TABLE session_pins IS
    'Per-user Session pins. A pin affects only the user who created this row.';

-- The Environment owns its Sandbox idle-pause policy. Zero disables automatic
-- pause; the upper bound matches the product Sandbox hard TTL.
ALTER TABLE environments
    ADD COLUMN idle_pause_timeout_seconds INTEGER NOT NULL DEFAULT 1800
        CHECK (
            idle_pause_timeout_seconds >= 0
            AND idle_pause_timeout_seconds <= 2592000
        );

COMMENT ON COLUMN environments.idle_pause_timeout_seconds IS
    'Seconds after the latest runtime activity before Sandpi pauses the Sandbox; zero disables automatic pause.';

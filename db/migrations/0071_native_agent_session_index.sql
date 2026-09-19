-- Navigation metadata only; native history remains on the Environment RootFS.
CREATE TABLE environment_native_session_indexes (
    environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
    harness TEXT NOT NULL,
    sessions JSONB NOT NULL DEFAULT '[]',
    partial BOOLEAN NOT NULL DEFAULT FALSE,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE environment_runtime
    ADD COLUMN agent_launch_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN agent_native_session_id TEXT,
    ADD COLUMN agent_resume_path TEXT;

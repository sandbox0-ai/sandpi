ALTER TABLE session_runtime
    ADD COLUMN history_revision BIGINT NOT NULL DEFAULT 0
        CHECK (history_revision >= 0);

COMMENT ON COLUMN session_runtime.history_revision IS
    'Monotonic visible-history branch revision. Clients replace their native harness timeline when this changes.';

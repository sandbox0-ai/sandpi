ALTER TABLE harness_events
    ADD COLUMN supervisor_sequence BIGINT,
    ADD COLUMN record_index INTEGER,
    ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'notification'
        CHECK (message_kind IN ('notification', 'response', 'request'));

ALTER TABLE harness_events
    DROP CONSTRAINT harness_events_session_id_sequence_key;

ALTER TABLE harness_events
    ADD CONSTRAINT harness_events_supervisor_record_unique
        UNIQUE (session_id, supervisor_sequence, record_index);

ALTER TABLE harness_events
    ADD CONSTRAINT harness_events_supervisor_sequence_nonnegative
        CHECK (supervisor_sequence IS NULL OR supervisor_sequence >= 0),
    ADD CONSTRAINT harness_events_record_index_nonnegative
        CHECK (record_index IS NULL OR record_index >= 0);

CREATE UNIQUE INDEX harness_events_session_sequence_unique_idx
    ON harness_events (session_id, sequence);

COMMENT ON COLUMN harness_events.supervisor_sequence IS
    'Replay identity from the Sandbox0 Supervisor event journal.';
COMMENT ON COLUMN harness_events.record_index IS
    'Zero-based JSONL record index within one Supervisor output event.';

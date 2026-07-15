ALTER TABLE harness_events
    ADD COLUMN supervisor_session_id TEXT;

UPDATE harness_events event
SET supervisor_session_id = runtime.supervisor_session_id
FROM session_runtime runtime
WHERE runtime.session_id = event.session_id
  AND event.supervisor_sequence IS NOT NULL;

ALTER TABLE harness_events
    DROP CONSTRAINT harness_events_supervisor_record_unique;

ALTER TABLE harness_events
    ADD CONSTRAINT harness_events_supervisor_record_unique
        UNIQUE (
            session_id,
            supervisor_session_id,
            supervisor_sequence,
            record_index
        );

COMMENT ON COLUMN harness_events.supervisor_session_id IS
    'Supervisor journal epoch. A replacement Supervisor restarts its event sequence at zero.';

ALTER TABLE session_runtime
    ADD COLUMN reasoning_effort TEXT;

ALTER TABLE session_runtime
    ADD CONSTRAINT session_runtime_reasoning_effort_nonempty
    CHECK (
        reasoning_effort IS NULL
        OR (
            LENGTH(BTRIM(reasoning_effort)) BETWEEN 1 AND 100
            AND reasoning_effort = BTRIM(reasoning_effort)
        )
    );

COMMENT ON COLUMN session_runtime.reasoning_effort IS
    'Last Codex-native reasoning effort selected for the Session control projection.';

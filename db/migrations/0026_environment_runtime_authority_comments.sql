-- Protocol initialization is process-local. Correct the initial column
-- descriptions without rewriting the already-applied schema migration.

COMMENT ON COLUMN environment_runtime.attempt_id IS
    'Last Sandbox0 Supervisor attempt whose ephemeral credential was materialized by Sandpi.';
COMMENT ON COLUMN environment_runtime.runtime_generation IS
    'Last Sandbox0 runtime generation whose ephemeral credential was materialized by Sandpi.';

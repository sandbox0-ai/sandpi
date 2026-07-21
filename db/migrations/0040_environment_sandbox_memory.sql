-- Store one portable integer resource contract and translate it to Sandbox0's
-- quantity string only at the runtime adapter boundary.
ALTER TABLE environments
    ADD COLUMN sandbox_memory_mib INTEGER NOT NULL DEFAULT 2048
        CHECK (
            sandbox_memory_mib >= 128
            AND sandbox_memory_mib <= 8192
        );

COMMENT ON COLUMN environments.sandbox_memory_mib IS
    'Desired Sandbox memory limit in MiB; applied at claim time and to the existing Environment Sandbox.';


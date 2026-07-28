-- Runtime configuration is durable desired state. API writes advance the
-- desired generation; a background reconciler applies it to Sandbox0 and only
-- then advances the applied generation.
ALTER TABLE environments
    ADD COLUMN runtime_config_generation BIGINT NOT NULL DEFAULT 1
        CHECK (runtime_config_generation > 0);

ALTER TABLE environment_runtime
    ADD COLUMN applied_runtime_config_generation BIGINT NOT NULL DEFAULT 0
        CHECK (applied_runtime_config_generation >= 0),
    ADD COLUMN applied_sandbox_memory_mib INTEGER
        CHECK (
            applied_sandbox_memory_mib IS NULL
            OR (
                applied_sandbox_memory_mib >= 128
                AND applied_sandbox_memory_mib <= 8192
            )
        ),
    ADD COLUMN runtime_config_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (runtime_config_attempt_count >= 0),
    ADD COLUMN runtime_config_retry_at TIMESTAMPTZ,
    ADD COLUMN runtime_config_error TEXT;

-- Existing allocated runtimes predate generations, so their current
-- Environment configuration is already applied. Unallocated runtimes remain
-- pending and will record the generation used by provisioning.
UPDATE environment_runtime runtime
SET applied_runtime_config_generation = environment.runtime_config_generation,
    applied_sandbox_memory_mib = environment.sandbox_memory_mib
FROM environments environment
WHERE environment.id = runtime.environment_id
  AND runtime.sandbox_id IS NOT NULL;

ALTER TABLE environment_runtime
    ADD CONSTRAINT environment_runtime_running_memory_applied
    CHECK (
        observed_state <> 'running'
        OR sandbox_id IS NULL
        OR applied_sandbox_memory_mib IS NOT NULL
    );

CREATE INDEX environment_runtime_config_retry_idx
    ON environment_runtime (runtime_config_retry_at, environment_id)
    WHERE sandbox_id IS NOT NULL
      AND desired_state <> 'terminated';

COMMENT ON COLUMN environments.runtime_config_generation IS
    'Monotonic desired Sandbox memory and network-policy generation.';
COMMENT ON COLUMN environment_runtime.applied_runtime_config_generation IS
    'Latest complete desired runtime-config generation confirmed by Sandbox0.';
COMMENT ON COLUMN environment_runtime.applied_sandbox_memory_mib IS
    'Memory last confirmed on Sandbox0; drives Sandpi local quota projection.';
COMMENT ON COLUMN environment_runtime.runtime_config_retry_at IS
    'Durable backoff deadline for the next runtime-config reconciliation.';

-- Desired memory must not affect quota admission until Sandbox0 confirms the
-- corresponding live allocation.
DROP TRIGGER IF EXISTS environments_project_memory_usage ON environments;
DROP FUNCTION IF EXISTS project_sandbox_memory_usage();

CREATE OR REPLACE FUNCTION project_sandbox_runtime_usage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    owner_id TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.sandbox_id IS NOT NULL AND OLD.observed_state = 'running' THEN
            UPDATE sandbox_runtime_segments
            SET ended_at = GREATEST(NOW(), started_at)
            WHERE sandbox_id = OLD.sandbox_id
              AND ended_at IS NULL;
        END IF;
        IF OLD.sandbox_id IS NOT NULL THEN
            UPDATE sandbox_usage_attributions
            SET released_at = COALESCE(released_at, NOW())
            WHERE sandbox_id = OLD.sandbox_id;
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.sandbox_id IS NOT NULL
       AND OLD.observed_state = 'running'
       AND (
           NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id
           OR NEW.observed_state <> 'running'
       )
    THEN
        UPDATE sandbox_runtime_segments
        SET ended_at = GREATEST(NOW(), started_at)
        WHERE sandbox_id = OLD.sandbox_id
          AND ended_at IS NULL;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.sandbox_id IS NOT NULL
       AND NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id
    THEN
        UPDATE sandbox_usage_attributions
        SET released_at = COALESCE(released_at, NOW())
        WHERE sandbox_id = OLD.sandbox_id;
    END IF;

    IF NEW.sandbox_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT created_by_user_id
    INTO owner_id
    FROM environments
    WHERE id = NEW.environment_id;

    INSERT INTO sandbox_usage_attributions (
        sandbox_id,
        user_id,
        environment_id
    )
    VALUES (NEW.sandbox_id, owner_id, NEW.environment_id)
    ON CONFLICT (sandbox_id) DO UPDATE
    SET environment_id = EXCLUDED.environment_id,
        released_at = NULL
    WHERE sandbox_usage_attributions.user_id = EXCLUDED.user_id;

    IF NEW.observed_state = 'running'
       AND (
           TG_OP = 'INSERT'
           OR OLD.sandbox_id IS DISTINCT FROM NEW.sandbox_id
           OR OLD.observed_state <> 'running'
       )
    THEN
        INSERT INTO sandbox_runtime_segments (
            sandbox_id,
            user_id,
            environment_id,
            memory_mib,
            started_at
        )
        VALUES (
            NEW.sandbox_id,
            owner_id,
            NEW.environment_id,
            NEW.applied_sandbox_memory_mib,
            NOW()
        )
        ON CONFLICT (sandbox_id) WHERE ended_at IS NULL DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION project_applied_sandbox_memory_usage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    owner_id TEXT;
BEGIN
    IF OLD.applied_sandbox_memory_mib IS NOT DISTINCT FROM
       NEW.applied_sandbox_memory_mib
       OR OLD.sandbox_id IS NULL
       OR NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id
       OR OLD.observed_state <> 'running'
       OR NEW.observed_state <> 'running'
    THEN
        RETURN NEW;
    END IF;

    SELECT created_by_user_id
    INTO owner_id
    FROM environments
    WHERE id = NEW.environment_id;

    UPDATE sandbox_runtime_segments
    SET ended_at = GREATEST(NOW(), started_at)
    WHERE sandbox_id = NEW.sandbox_id
      AND ended_at IS NULL;

    INSERT INTO sandbox_runtime_segments (
        sandbox_id,
        user_id,
        environment_id,
        memory_mib,
        started_at
    )
    VALUES (
        NEW.sandbox_id,
        owner_id,
        NEW.environment_id,
        NEW.applied_sandbox_memory_mib,
        NOW()
    );

    RETURN NEW;
END;
$$;

CREATE TRIGGER environment_runtime_project_applied_memory_usage
    AFTER UPDATE OF applied_sandbox_memory_mib ON environment_runtime
    FOR EACH ROW
    EXECUTE FUNCTION project_applied_sandbox_memory_usage();

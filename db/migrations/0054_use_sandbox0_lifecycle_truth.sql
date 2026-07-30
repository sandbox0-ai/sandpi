-- Sandbox0 owns observed Sandbox lifecycle state. Sandpi keeps only product
-- intent, runtime fencing coordinates and records of pause actions it issued.

DROP TRIGGER IF EXISTS environment_runtime_project_usage_upsert
    ON environment_runtime;
DROP TRIGGER IF EXISTS environment_runtime_project_usage_delete
    ON environment_runtime;
DROP FUNCTION IF EXISTS project_sandbox_runtime_usage();

DROP TRIGGER IF EXISTS environments_project_memory_usage ON environments;
DROP FUNCTION IF EXISTS project_sandbox_memory_usage();

-- Legacy local lifecycle projections cannot be extended accurately after the
-- observed-state cache is removed. Sandbox0 usage windows remain usage truth.
UPDATE sandbox_runtime_segments
SET ended_at = GREATEST(NOW(), started_at)
WHERE ended_at IS NULL;

CREATE FUNCTION sync_sandbox_usage_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    owner_id TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.sandbox_id IS NOT NULL THEN
            UPDATE sandbox_usage_attributions
            SET released_at = COALESCE(released_at, NOW())
            WHERE sandbox_id = OLD.sandbox_id;
        END IF;
        RETURN OLD;
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

    RETURN NEW;
END;
$$;

CREATE TRIGGER environment_runtime_sync_usage_attribution_upsert
    AFTER INSERT OR UPDATE OF sandbox_id
    ON environment_runtime
    FOR EACH ROW
    EXECUTE FUNCTION sync_sandbox_usage_attribution();

CREATE TRIGGER environment_runtime_sync_usage_attribution_delete
    BEFORE DELETE ON environment_runtime
    FOR EACH ROW
    EXECUTE FUNCTION sync_sandbox_usage_attribution();

ALTER TABLE environment_runtime DROP COLUMN observed_state;

COMMENT ON COLUMN environment_runtime.desired_state IS
    'Sandpi product intent only; current Sandbox lifecycle is read from Sandbox0.';
COMMENT ON COLUMN environment_runtime.paused_at IS
    'Timestamp of the latest successful pause action issued by Sandpi, not current Sandbox lifecycle state.';
COMMENT ON TABLE sandbox_runtime_segments IS
    'Closed legacy Sandpi lifecycle projections retained only for historical accounting; Sandbox0 usage windows are usage truth.';

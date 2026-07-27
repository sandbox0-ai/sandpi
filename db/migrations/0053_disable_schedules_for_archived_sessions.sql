-- A fixed-Session Schedule must not keep producing failed occurrences after
-- its target is archived. Unarchiving does not silently re-enable Automation.

CREATE FUNCTION disable_environment_schedules_for_archived_session()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE environment_schedules
    SET enabled = FALSE,
        next_run_at = NULL,
        last_error = 'The target Session was archived.',
        revision = revision + 1
    WHERE target_kind = 'session'
      AND target_session_id = NEW.id
      AND deleted_at IS NULL;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_disable_environment_schedules_on_archive
    BEFORE UPDATE OF archived ON sessions
    FOR EACH ROW
    WHEN (NEW.archived = TRUE AND OLD.archived = FALSE)
    EXECUTE FUNCTION disable_environment_schedules_for_archived_session();

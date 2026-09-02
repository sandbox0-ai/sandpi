-- Native TUI v2 does not execute product Sessions through Codex app-server.
-- Preserve their native Session identity and history for audit/read-only use,
-- but make every in-flight v1 projection terminal before the v2 server runs.

UPDATE sessions
SET status = 'failed',
    unread = TRUE,
    metadata = metadata || jsonb_build_object(
        'nativeTuiV2Migration', jsonb_build_object(
            'retiredAt', NOW(),
            'reason', 'legacy-app-server-retired'
        )
    )
WHERE status IN ('provisioning', 'running')
   OR EXISTS (
       SELECT 1
       FROM session_runtime runtime
       WHERE runtime.session_id = sessions.id
         AND (
             runtime.active_native_turn_id IS NOT NULL
             OR runtime.pending_turn_phase IS NOT NULL
         )
   );

UPDATE session_runtime runtime
SET active_native_turn_id = NULL,
    pending_turn_request_id = NULL,
    pending_turn_client_message_id = NULL,
    pending_turn_stable_input_id = NULL,
    pending_turn_phase = NULL,
    pending_turn_native_turn_id = NULL,
    pending_turn_started_at = NULL,
    active_turn_attempt_id = NULL,
    active_turn_runtime_generation = NULL,
    pending_turn_attempt_id = NULL,
    pending_turn_runtime_generation = NULL,
    interrupt_requested_native_turn_id = NULL,
    recovery_source_native_turn_id = NULL,
    recovery_prompt_version = NULL,
    recovery_attempt_count = 0,
    runtime_error_code = 'native_tui_v2_legacy_session_retired',
    version = version + 1
FROM sessions session
WHERE runtime.session_id = session.id
  AND session.metadata #>> '{nativeTuiV2Migration,reason}' =
      'legacy-app-server-retired';

COMMENT ON TABLE sessions IS
    'Read-only v1 coding Session history retained after native TUI v2 retired app-server execution.';

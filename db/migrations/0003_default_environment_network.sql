UPDATE environments
SET network_policy = '{"mode":"allow-all","allowedDomains":[],"logDeniedRequests":true}'::JSONB
WHERE id = 'env-default'
  AND workspace_volume_id IS NULL
  AND status IN ('updating', 'error')
  AND network_policy = '{"mode":"restricted","allowedDomains":[],"logDeniedRequests":true}'::JSONB;

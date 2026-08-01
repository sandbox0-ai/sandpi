-- Provider installation and account lifecycle do not belong in a per-Webhook
-- protocol selector. Preserve legacy definitions and history, but stop their
-- ingress before the misleading provider field is removed.

UPDATE environment_webhooks
SET enabled = FALSE,
    last_error = 'The built-in ' || provider ||
        ' adapter was removed. Rotate the secret and configure this definition as a generic Webhook before enabling it.',
    revision = revision + 1
WHERE provider <> 'custom'
  AND deleted_at IS NULL;

ALTER TABLE environment_webhooks
    DROP COLUMN provider;

ALTER TABLE environment_webhook_deliveries
    RENAME COLUMN provider_delivery_id TO source_delivery_id;

DO $$
DECLARE
    delivery_unique_constraint TEXT;
BEGIN
    SELECT constraint_row.conname
    INTO delivery_unique_constraint
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'environment_webhook_deliveries'::REGCLASS
      AND constraint_row.contype = 'u'
      AND pg_get_constraintdef(constraint_row.oid) LIKE
          '%(webhook_id, source_delivery_id)%';

    IF delivery_unique_constraint IS NOT NULL THEN
        EXECUTE FORMAT(
            'ALTER TABLE environment_webhook_deliveries RENAME CONSTRAINT %I TO environment_webhook_deliveries_source_delivery_key',
            delivery_unique_constraint
        );
    END IF;
END $$;

COMMENT ON TABLE environment_webhooks IS
    'Environment-owned generic Webhook Automation definitions and encrypted bearer secrets.';
COMMENT ON COLUMN environment_webhook_deliveries.source_delivery_id IS
    'Sender-provided idempotency key or a bounded retry-window body digest.';

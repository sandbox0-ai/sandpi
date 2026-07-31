ALTER TABLE user_subscriptions
    DROP CONSTRAINT user_subscriptions_plan_id_check,
    ADD CONSTRAINT user_subscriptions_plan_id_check
        CHECK (plan_id IN ('plus', 'pro', 'ultra')),
    DROP CONSTRAINT user_subscriptions_pending_plan_id_check,
    ADD CONSTRAINT user_subscriptions_pending_plan_id_check
        CHECK (pending_plan_id IN ('plus', 'pro', 'ultra'));

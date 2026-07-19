-- Sandbox0 exposes two fallback modes. Preserve the effective behavior of
-- existing policies while replacing Sandpi's synthetic restricted mode and
-- ignored audit flag with one mode-relative domain exception list.

UPDATE environments
SET network_policy = jsonb_build_object(
    'mode',
    CASE
        WHEN network_policy->>'mode' = 'allow-all' THEN 'allow-all'
        ELSE 'block-all'
    END,
    'domainExceptions',
    CASE
        -- allowedDomains never affected allow-all, so retaining them as deny
        -- exceptions would silently change the existing runtime policy.
        WHEN network_policy->>'mode' = 'allow-all' THEN '[]'::JSONB
        WHEN jsonb_typeof(network_policy->'allowedDomains') = 'array'
            THEN network_policy->'allowedDomains'
        ELSE '[]'::JSONB
    END
);

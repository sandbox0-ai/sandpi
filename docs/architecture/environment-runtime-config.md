# Durable Environment runtime configuration

Sandbox memory and network policy are asynchronous desired state. The
Environment `PUT` endpoint persists the complete desired configuration and
advances `environments.runtime_config_generation` in one short PostgreSQL
transaction. It does not keep the browser request open while Sandbox0 changes
the live Sandbox.

The Environment lifecycle reconciler scans generations that have not been
applied. A per-Environment lifecycle advisory lock serializes each attempt with
pause, resume, recovery, backup restore and deletion. Under that lock, the
reconciler:

1. reads one immutable desired generation;
2. reapplies its complete network policy, including current egress credential
   rules;
3. applies its memory limit;
4. records the confirmed memory and advances
   `applied_runtime_config_generation` only if that generation is still
   current.

Both Sandbox0 operations are idempotent. If Sandpi exits after either external
call, the unacknowledged generation stays pending and another replica can
reapply it. Failures retain the desired configuration, expose a `failed`
runtime-config status, and retry with durable exponential backoff. A newer
update clears the previous failure and supersedes the older generation.

The API exposes desired and applied generations separately:

- `applied`: Sandbox0 confirmed the current generation;
- `applying`: desired state is durable but has not been confirmed yet;
- `failed`: the last attempt failed and will be retried automatically.

The desired `sandbox_memory_mib` is not used for Sandpi's local quota projection.
`environment_runtime.applied_sandbox_memory_mib` changes only after a successful
Sandbox0 update and is the trigger for rotating `sandbox_runtime_segments`.
Sandbox0 remains the usage-truth producer; these segments remain only the
timely local admission projection described in
[Billing and usage](./billing-and-usage.md).

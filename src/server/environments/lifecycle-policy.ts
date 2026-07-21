/** Product-owned lifecycle policy for every Environment Sandbox. */
export const ENVIRONMENT_LIFECYCLE_POLICY_VERSION = 2;

/** Sandbox0 hard TTL is expressed in seconds. Thirty days is one product month. */
export const ENVIRONMENT_SANDBOX_HARD_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Default Environment idle-pause timeout. Each Environment may override it. */
export const DEFAULT_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS = 30 * 60;

/** Failed pause requests remain durable and are retried without a hot loop. */
export const ENVIRONMENT_PAUSE_RETRY_DELAY_MS = 60 * 1_000;

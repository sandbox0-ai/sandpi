/** Product-owned lifecycle policy for every Environment Sandbox. */
export const ENVIRONMENT_LIFECYCLE_POLICY_VERSION = 2;

/** Sandbox0 hard TTL is expressed in seconds. Thirty days is one product month. */
export const ENVIRONMENT_SANDBOX_HARD_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Pause compute after the latest native Turn has been complete for this long. */
export const ENVIRONMENT_IDLE_PAUSE_DELAY_MS = 30 * 60 * 1_000;

/** Failed pause requests remain durable and are retried without a hot loop. */
export const ENVIRONMENT_PAUSE_RETRY_DELAY_MS = 60 * 1_000;

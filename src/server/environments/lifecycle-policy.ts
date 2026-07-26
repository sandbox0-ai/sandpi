export { DEFAULT_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS } from "@/lib/environment-lifecycle";

/** Product-owned lifecycle policy for every Environment Sandbox. */
export const ENVIRONMENT_LIFECYCLE_POLICY_VERSION = 3;

/** Failed pause requests remain durable and are retried without a hot loop. */
export const ENVIRONMENT_PAUSE_RETRY_DELAY_MS = 60 * 1_000;

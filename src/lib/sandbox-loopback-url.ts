const SANDBOX_LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * Identifies URLs that resolve inside a Sandbox rather than on the user's
 * device. Until Sandpi exposes a dedicated Preview surface, these links stay
 * inert so they cannot accidentally navigate to a service on the local host.
 */
export function sandboxLoopbackUrl(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  const candidate =
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(
      trimmed,
    )
      ? `http://${trimmed}`
      : trimmed;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !SANDBOX_LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    return undefined;
  }
  return url.toString();
}

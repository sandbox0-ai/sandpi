const SANDBOX_LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * Returns an HTTP URL that intentionally resolves inside the Environment
 * browser, not on the Sandpi user's device.
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

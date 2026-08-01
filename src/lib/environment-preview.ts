const SANDBOX_PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1"]);

export interface SandboxPreviewTarget {
  url: string;
  hostname: "localhost" | "127.0.0.1";
  port: number;
  pathname: string;
  search: string;
  hash: string;
}

/**
 * Normalizes an HTTP address that resolves inside the Environment Sandbox.
 * Preview intentionally excludes remote hosts, credentials, HTTPS and IPv6.
 */
export function sandboxPreviewTarget(
  value: string | undefined,
): SandboxPreviewTarget | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const candidate = /^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#]|$)/i.test(
    trimmed,
  )
    ? `http://${trimmed}`
    : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "http:" ||
    !SANDBOX_PREVIEW_HOSTS.has(hostname) ||
    parsed.username ||
    parsed.password
  ) {
    return undefined;
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }

  return {
    url: parsed.toString(),
    hostname: hostname as SandboxPreviewTarget["hostname"],
    port,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

export function sandboxPreviewUrl(value: string | undefined) {
  return sandboxPreviewTarget(value)?.url;
}

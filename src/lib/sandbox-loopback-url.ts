const SANDBOX_LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

export interface SandboxLoopbackTarget {
  url: string;
  protocol: "http" | "https";
  port: number;
  path: string;
}

export interface SandboxLoopbackMatch {
  start: number;
  end: number;
  text: string;
  url: string;
}

const TRAILING_PROSE_PUNCTUATION = /[),.;:!?}\]，。；：！？）】]$/;

/** Identifies and normalizes a URL that resolves inside the selected Sandbox. */
export function sandboxLoopbackTarget(
  value: string | undefined,
): SandboxLoopbackTarget | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const decodedIpv6Literal = trimmed.replace(
    /^(https?:\/\/)%5B::1%5D(?=[:/?#]|$)/i,
    "$1[::1]",
  );
  const candidate =
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(
      decodedIpv6Literal,
    )
      ? `http://${decodedIpv6Literal}`
      : decodedIpv6Literal;
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
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return {
    url: url.toString(),
    protocol: url.protocol === "https:" ? "https" : "http",
    port,
    path: `${url.pathname}${url.search}${url.hash}`,
  };
}

export function sandboxLoopbackUrl(value: string | undefined) {
  return sandboxLoopbackTarget(value)?.url;
}

/** Finds explicit-port loopback URLs in prose without matching URL substrings. */
export function sandboxLoopbackMatches(value: string): SandboxLoopbackMatch[] {
  const pattern =
    /(^|[^A-Za-z0-9_./:@-])((?:localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}(?![0-9A-Za-z_-])(?:[/?#][^\s<>"'`]*)?)/gi;
  const matches: SandboxLoopbackMatch[] = [];

  for (const match of value.matchAll(pattern)) {
    const prefix = match[1] ?? "";
    let text = match[2] ?? "";
    while (TRAILING_PROSE_PUNCTUATION.test(text)) {
      text = text.slice(0, -1);
    }
    const url = sandboxLoopbackUrl(text);
    if (!text || !url || match.index === undefined) continue;
    const start = match.index + prefix.length;
    matches.push({ start, end: start + text.length, text, url });
  }

  return matches;
}

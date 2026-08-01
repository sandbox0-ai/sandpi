import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

import type { AuthorizedPreviewSession } from "./preview-service";

const INTERNAL_REQUEST_HEADERS = new Set([
  "x-sandpi-preview-appservice",
  "x-sandpi-preview-proxy",
  "x-sandpi-preview-target-host",
  "x-sandpi-preview-target-port",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const FORWARDED_HEADERS = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);

export function previewUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  proxyHeaders: Record<string, string>,
  session: AuthorizedPreviewSession,
  previewOrigin: string,
  previewCookieName: string,
  websocket = false,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  const connectionHeaders = new Set(
    String(incoming.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      lower === "host" ||
      INTERNAL_REQUEST_HEADERS.has(lower) ||
      FORWARDED_HEADERS.has(lower) ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      connectionHeaders.has(lower) ||
      (websocket && lower.startsWith("sec-websocket-"))
    ) {
      continue;
    }
    headers[name] = value;
  }

  const cookie = withoutCookie(incoming.cookie, previewCookieName);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;

  const targetOrigin = environmentTargetOrigin(session);
  if (incoming.origin === previewOrigin) headers.origin = targetOrigin;
  const referer = incoming.referer;
  if (referer?.startsWith(`${previewOrigin}/`)) {
    headers.referer = `${targetOrigin}${referer.slice(previewOrigin.length)}`;
  }
  Object.assign(headers, proxyHeaders);
  return headers;
}

export function previewDownstreamHeaders(
  incoming: IncomingHttpHeaders,
  session: AuthorizedPreviewSession,
  previewOrigin: string,
  previewCookieName: string,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === "x-frame-options"
    ) {
      continue;
    }
    if (lower === "location" && typeof value === "string") {
      headers.location = previewRedirectLocation(
        value,
        session,
        previewOrigin,
      );
      continue;
    }
    if (lower === "set-cookie") {
      const cookies = (Array.isArray(value) ? value : [value]).flatMap(
        (cookie) => {
          const rewritten = rewritePreviewSetCookie(cookie, previewCookieName);
          return rewritten ? [rewritten] : [];
        },
      );
      if (cookies.length > 0) headers["set-cookie"] = cookies;
      continue;
    }
    if (lower === "content-security-policy" && typeof value === "string") {
      const rewritten = withoutFrameAncestors(value);
      if (rewritten) headers[name] = rewritten;
      continue;
    }
    const targetOrigin = environmentTargetOrigin(session);
    if (
      lower === "access-control-allow-origin" &&
      typeof value === "string" &&
      value === targetOrigin
    ) {
      headers[name] = previewOrigin;
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

export function previewRedirectLocation(
  location: string,
  session: AuthorizedPreviewSession,
  previewOrigin: string,
) {
  let target: URL;
  try {
    target = new URL(location, environmentTargetOrigin(session));
  } catch {
    return location;
  }
  if (
    target.protocol === "http:" &&
    target.hostname.toLowerCase() === session.targetHost &&
    Number(target.port || 80) === session.targetPort
  ) {
    return `${previewOrigin}${target.pathname}${target.search}${target.hash}`;
  }
  return location;
}

export function withoutCookie(value: string | undefined, name: string) {
  if (!value) return undefined;
  const kept = value
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie && cookie.split("=", 1)[0] !== name);
  return kept.length > 0 ? kept.join("; ") : undefined;
}

function rewritePreviewSetCookie(value: string, reservedName: string) {
  const name = value.split("=", 1)[0]?.trim();
  if (!name || name === reservedName) return undefined;
  return value.replace(/;\s*domain=[^;]*/gi, "");
}

function withoutFrameAncestors(value: string) {
  return value
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors(?:\s|$)/i.test(directive))
    .join("; ");
}

function environmentTargetOrigin(session: AuthorizedPreviewSession) {
  const port = session.targetPort === 80 ? "" : `:${session.targetPort}`;
  return `http://${session.targetHost}${port}`;
}

const configuredApiBase = process.env.NEXT_PUBLIC_SANDPI_API_URL?.trim();

/**
 * Sandpi clients talk only to the Sandpi server. Sandbox0 and harness credentials
 * never cross this boundary into the browser.
 */
const API_BASE = configuredApiBase
  ? configuredApiBase.replace(/\/+$/, "")
  : "";

export interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    loginUrl?: string;
    details?: unknown;
  };
  code?: string;
  message?: string;
  loginUrl?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly loginUrl?: string;
  readonly details?: unknown;
  readonly body?: unknown;

  constructor(
    message: string,
    options: {
      status: number;
      code?: string;
      loginUrl?: string;
      details?: unknown;
      body?: unknown;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.loginUrl = options.loginUrl;
    this.details = options.details;
    this.body = options.body;
  }
}

function isAbsoluteUrl(value: string) {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

/** Resolve a Sandpi HTTP endpoint against the deployment-level API base. */
export function apiUrl(path: string) {
  if (isAbsoluteUrl(path)) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 304) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return text || undefined;
}

function apiError(response: Response, body: unknown) {
  const errorBody =
    body && typeof body === "object" ? (body as ApiErrorBody) : undefined;
  const nestedError = errorBody?.error;
  const message =
    nestedError?.message ??
    errorBody?.message ??
    (typeof body === "string" ? body : undefined) ??
    `Sandpi API request failed with status ${response.status}.`;

  return new ApiError(message, {
    status: response.status,
    code: nestedError?.code ?? errorBody?.code,
    loginUrl:
      nestedError?.loginUrl ??
      errorBody?.loginUrl ??
      response.headers.get("location") ??
      undefined,
    details: nestedError?.details,
    body,
  });
}

/**
 * Fetch JSON from the Sandpi server with browser credentials. Callers receive
 * structured errors so each surface can decide whether to offer login in place
 * or redirect an unauthenticated user.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }
  if (
    init.body !== undefined &&
    !(init.body instanceof FormData) &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: init.credentials ?? "include",
    headers,
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw apiError(response, body);
  }

  return body as T;
}

export type ConditionalApiResult<T> =
  | { notModified: true; etag?: string }
  | { notModified: false; data: T; etag?: string };

/** Perform a credentialed conditional GET without treating HTTP 304 as an error. */
export async function apiFetchConditional<T>(
  path: string,
  etag?: string,
  init: Omit<RequestInit, "body" | "method"> = {},
): Promise<ConditionalApiResult<T>> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }
  if (etag) {
    headers.set("if-none-match", etag);
  }

  const response = await fetch(apiUrl(path), {
    ...init,
    method: "GET",
    credentials: init.credentials ?? "include",
    headers,
  });
  const responseEtag = response.headers.get("etag") ?? undefined;
  if (response.status === 304) {
    return { notModified: true, etag: responseEtag ?? etag };
  }

  const body = await readResponseBody(response);
  if (!response.ok) {
    throw apiError(response, body);
  }
  return {
    notModified: false,
    data: body as T,
    etag: responseEtag,
  };
}

/** Resolve a replayable Sandpi WebSocket endpoint using the same API base. */
export function apiWebSocketUrl(path: string) {
  if (/^wss?:\/\//i.test(path)) {
    return path;
  }

  const httpUrl = apiUrl(path);
  if (typeof window === "undefined" && !isAbsoluteUrl(httpUrl)) {
    throw new Error("A relative WebSocket URL can only be resolved in a browser.");
  }

  const url = new URL(
    httpUrl,
    typeof window === "undefined" ? undefined : window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

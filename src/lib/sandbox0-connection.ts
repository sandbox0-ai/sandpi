import type { Sandbox0ConnectionSummary } from "@/lib/types";

export class Sandbox0ConnectionInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "Sandbox0ConnectionInputError";
    this.code = code;
  }
}

export function normalizeSandbox0ApiHost(value: string): string {
  const input = value.trim();
  if (!input) {
    throw new Sandbox0ConnectionInputError(
      "api_host_required",
      "Enter the Sandbox0 API Host.",
    );
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Sandbox0ConnectionInputError(
      "api_host_invalid",
      "Use a complete http:// or https:// URL.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Sandbox0ConnectionInputError(
      "api_host_protocol_invalid",
      "The Sandbox0 API Host must use http:// or https://.",
    );
  }
  if (!url.hostname) {
    throw new Sandbox0ConnectionInputError(
      "api_host_invalid",
      "The Sandbox0 API Host must include a hostname.",
    );
  }
  if (url.username || url.password) {
    throw new Sandbox0ConnectionInputError(
      "api_host_credentials_forbidden",
      "Do not put credentials in the Sandbox0 API Host URL.",
    );
  }
  if (url.search || url.hash) {
    throw new Sandbox0ConnectionInputError(
      "api_host_suffix_forbidden",
      "The Sandbox0 API Host cannot contain a query string or fragment.",
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function requireSandbox0ApiKey(value: string): string {
  const apiKey = value.trim();
  if (!apiKey) {
    throw new Sandbox0ConnectionInputError(
      "api_key_required",
      "Enter a Sandbox0 API Key.",
    );
  }
  if (apiKey.length < 8) {
    throw new Sandbox0ConnectionInputError(
      "api_key_too_short",
      "The Sandbox0 API Key must contain at least 8 characters.",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(apiKey)) {
    throw new Sandbox0ConnectionInputError(
      "api_key_invalid",
      "The Sandbox0 API Key cannot contain control characters.",
    );
  }
  return apiKey;
}

export function sandbox0ApiKeyLast4(value: string): string {
  return value.slice(-4);
}

export function createSandbox0ConnectionSummary(input: {
  id: string;
  name: string;
  apiHost: string;
  apiKey: string;
}): Sandbox0ConnectionSummary {
  const name = input.name.trim();
  if (!name) {
    throw new Sandbox0ConnectionInputError(
      "connection_name_required",
      "Give the Sandbox0 connection a name.",
    );
  }
  const apiKey = requireSandbox0ApiKey(input.apiKey);

  return {
    id: input.id,
    name,
    apiHost: normalizeSandbox0ApiHost(input.apiHost),
    targetKind: "self-hosted",
    managedBy: "team",
    readOnly: false,
    status: "unverified",
    apiKeyConfigured: true,
    apiKeyLast4: sandbox0ApiKeyLast4(apiKey),
  };
}

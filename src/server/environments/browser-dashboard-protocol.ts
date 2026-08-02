import type { RawData } from "ws";

const MAX_BROWSER_DASHBOARD_CLIENT_MESSAGE_BYTES = 16 * 1024;
const MAX_BROWSER_DASHBOARD_IDENTIFIER_LENGTH = 512;

export type BrowserDashboardClientMessageDecision =
  | {
      action: "forward";
      method: "selectTab" | "setVisible";
    }
  | {
      action: "reject";
      method?: string;
      requestId?: number;
      reason: string;
    };

/**
 * Allows only the two Dashboard messages required to maintain a live,
 * read-only screencast. Every page mutation remains behind Take control.
 */
export class BrowserDashboardReadOnlyGate {
  private sourceSelected = false;

  inspect(
    data: RawData,
    isBinary: boolean,
  ): BrowserDashboardClientMessageDecision {
    if (isBinary) {
      return { action: "reject", reason: "binary_message" };
    }
    const body = rawDataBuffer(data);
    if (body.byteLength > MAX_BROWSER_DASHBOARD_CLIENT_MESSAGE_BYTES) {
      return { action: "reject", reason: "message_too_large" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      return { action: "reject", reason: "invalid_json" };
    }
    if (!isRecord(parsed)) {
      return { action: "reject", reason: "invalid_request" };
    }
    const requestId =
      Number.isSafeInteger(parsed.id) && Number(parsed.id) > 0
        ? Number(parsed.id)
        : undefined;
    const method =
      typeof parsed.method === "string" ? parsed.method : undefined;
    if (!requestId || !method || !isRecord(parsed.params)) {
      return {
        action: "reject",
        ...(method ? { method } : {}),
        ...(requestId ? { requestId } : {}),
        reason: "invalid_request",
      };
    }

    if (
      method === "setVisible" &&
      hasOnlyKeys(parsed.params, ["visible"]) &&
      typeof parsed.params.visible === "boolean"
    ) {
      return { action: "forward", method };
    }

    if (
      method === "selectTab" &&
      !this.sourceSelected &&
      hasOnlyKeys(parsed.params, ["browser", "context", "page"]) &&
      validIdentifier(parsed.params.browser) &&
      validIdentifier(parsed.params.context) &&
      validIdentifier(parsed.params.page)
    ) {
      this.sourceSelected = true;
      return { action: "forward", method };
    }

    return {
      action: "reject",
      method,
      requestId,
      reason: method === "selectTab" ? "source_already_selected" : "blocked",
    };
  }
}

export function browserDashboardRejectedResponse(
  decision: Extract<BrowserDashboardClientMessageDecision, { action: "reject" }>,
) {
  if (!decision.requestId) return undefined;
  return JSON.stringify({
    id: decision.requestId,
    error:
      "The Environment Browser is view-only. Take control before interacting with the page.",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function validIdentifier(value: unknown) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BROWSER_DASHBOARD_IDENTIFIER_LENGTH
  );
}

function rawDataBuffer(data: RawData) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError("Unsupported Dashboard WebSocket message type");
}

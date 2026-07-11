import assert from "node:assert/strict";
import test from "node:test";

import {
  createSandbox0ConnectionSummary,
  normalizeSandbox0ApiHost,
  requireSandbox0ApiKey,
  sandbox0ApiKeyLast4,
  Sandbox0ConnectionInputError,
} from "./sandbox0-connection";

test("normalizes public and private Sandbox0 API hosts", () => {
  assert.equal(
    normalizeSandbox0ApiHost(" https://api.sandbox0.ai/ "),
    "https://api.sandbox0.ai",
  );
  assert.equal(
    normalizeSandbox0ApiHost("http://sandbox0.internal:8080/control-plane/"),
    "http://sandbox0.internal:8080/control-plane",
  );
});

test("creates a browser-safe connection summary without returning the API key", () => {
  const secret = "s0_private_secret_92KQ";
  const summary = createSandbox0ConnectionSummary({
    id: "connection-private",
    name: "Private Sandbox0",
    apiHost: "https://sandbox0.internal/",
    apiKey: secret,
  });

  assert.equal(summary.apiHost, "https://sandbox0.internal");
  assert.equal(summary.targetKind, "self-hosted");
  assert.equal(summary.apiKeyLast4, "92KQ");
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test("rejects API hosts that could hide credentials or request suffixes", () => {
  for (const host of [
    "ftp://sandbox0.internal",
    "https://user:secret@sandbox0.internal",
    "https://sandbox0.internal?next=metadata",
    "https://sandbox0.internal#fragment",
  ]) {
    assert.throws(
      () => normalizeSandbox0ApiHost(host),
      Sandbox0ConnectionInputError,
    );
  }
});

test("keeps API keys out of summaries except for the final four characters", () => {
  const apiKey = requireSandbox0ApiKey("  s0_private_secret_92KQ  ");
  assert.equal(apiKey, "s0_private_secret_92KQ");
  assert.equal(sandbox0ApiKeyLast4(apiKey), "92KQ");
  assert.throws(() => requireSandbox0ApiKey("   "), Sandbox0ConnectionInputError);
  assert.throws(() => requireSandbox0ApiKey("short"), Sandbox0ConnectionInputError);
  assert.throws(
    () => requireSandbox0ApiKey("secret\nvalue"),
    Sandbox0ConnectionInputError,
  );
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  matchesCodeChallenge,
  nativeAuthCallbackUrl,
  safeNativeReturnTo,
} from "./native";

test("native auth callback is restricted to the Sandpi application scheme", () => {
  assert.equal(
    nativeAuthCallbackUrl(
      "native_12345678-1234-4123-8123-123456789abc",
      "c".repeat(43),
      "s".repeat(43),
    ).toString(),
    `sandpi://auth/callback?attempt_id=native_12345678-1234-4123-8123-123456789abc&code=${"c".repeat(43)}&state=${"s".repeat(43)}`,
  );
});

test("native auth accepts only a matching PKCE verifier", () => {
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  assert.equal(matchesCodeChallenge(verifier, challenge), true);
  assert.equal(matchesCodeChallenge("x".repeat(43), challenge), false);
});

test("native auth return locations remain on the deployment origin", () => {
  const publicUrl = new URL("https://sandpi.ai");
  assert.equal(
    safeNativeReturnTo(
      "https://sandpi.ai/?environment=env-one#composer",
      publicUrl,
    ),
    "/?environment=env-one#composer",
  );
  assert.equal(
    safeNativeReturnTo("https://attacker.example/session", publicUrl),
    "/",
  );
  assert.equal(safeNativeReturnTo("javascript:alert(1)", publicUrl), "/");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldApplyApiNoStore,
  staticWebCacheControl,
} from "./cache-policy";

test("protects sensitive API responses", () => {
  assert.equal(
    shouldApplyApiNoStore("/api/v1/environments/env-1/workspace-backups"),
    true,
  );
  assert.equal(
    shouldApplyApiNoStore("/api/v1/environments/env-1/metrics"),
    false,
  );
});

test("makes content-addressed Web assets immutable without pinning stable HTML or loaders", () => {
  assert.equal(
    staticWebCacheControl(
      "/srv/sandpi/out/_next/static/chunks/app/page-e6eaebb0b00a5032.js",
    ),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    staticWebCacheControl(
      "/srv/sandpi/out/monaco/vs/ts.worker-CMbG-7ft.js",
    ),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    staticWebCacheControl("/srv/sandpi/out/monaco/vs/loader.js"),
    "public, max-age=3600",
  );
  assert.equal(
    staticWebCacheControl("/srv/sandpi/out/index.html"),
    "private, no-cache",
  );
  assert.equal(
    staticWebCacheControl("/srv/sandpi/out/llms.txt"),
    "public, no-cache",
  );
});

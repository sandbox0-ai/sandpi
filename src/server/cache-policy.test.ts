import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldApplyApiNoStore,
  staticWebCacheControl,
} from "./cache-policy";

test("preserves explicit Browser asset caching while protecting control responses", () => {
  const browser =
    "/api/v1/environments/env-1/browser/assets/index-CyWAfh-p.js";
  assert.equal(shouldApplyApiNoStore(browser, true), false);
  assert.equal(shouldApplyApiNoStore(browser, false), true);
  assert.equal(
    shouldApplyApiNoStore(
      "/api/v1/environments/env-1/browser/session",
      false,
    ),
    true,
  );
  assert.equal(
    shouldApplyApiNoStore(
      "/api/v1/environments/env-1/workspace-backups",
      true,
    ),
    true,
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

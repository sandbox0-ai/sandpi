import assert from "node:assert/strict";
import test from "node:test";

import {
  isNativeTuiV2LegacyOperation,
  rejectNativeTuiV2LegacyOperation,
} from "./native-tui-v2";

test("keeps v1 app-server history readable but retires structured execution", () => {
  assert.equal(isNativeTuiV2LegacyOperation("GET", "/api/v1/sessions"), false);
  assert.equal(
    isNativeTuiV2LegacyOperation("GET", "/api/v1/sessions/session-one"),
    false,
  );
  assert.equal(
    isNativeTuiV2LegacyOperation(
      "GET",
      "/api/v1/sessions/session-one/events",
    ),
    true,
  );
  assert.equal(
    isNativeTuiV2LegacyOperation("POST", "/api/v1/sessions"),
    true,
  );
  assert.throws(
    () => rejectNativeTuiV2LegacyOperation("POST", "/api/v1/sessions"),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 410);
      assert.equal(
        (error as { code?: string }).code,
        "native_tui_structured_operation_unavailable",
      );
      return true;
    },
  );
});

test("disables v1 automation ingress while retaining read and cleanup", () => {
  assert.equal(
    isNativeTuiV2LegacyOperation(
      "POST",
      "/api/v1/environments/env-one/schedules",
    ),
    true,
  );
  assert.equal(
    isNativeTuiV2LegacyOperation(
      "GET",
      "/api/v1/environments/env-one/schedules",
    ),
    false,
  );
  assert.equal(
    isNativeTuiV2LegacyOperation(
      "DELETE",
      "/api/v1/environments/env-one/webhooks/hook-one",
    ),
    false,
  );
  assert.equal(
    isNativeTuiV2LegacyOperation(
      "POST",
      "/api/v1/webhooks/public-endpoint?token=secret",
    ),
    true,
  );
});

test("leaves native TUI and Environment lifecycle routes active", () => {
  assert.equal(
    isNativeTuiV2LegacyOperation(
      "GET",
      "/api/v1/environments/env-one/agent-terminal",
    ),
    false,
  );
  assert.equal(
    isNativeTuiV2LegacyOperation(
      "POST",
      "/api/v1/environments/env-one/forks",
    ),
    false,
  );
});

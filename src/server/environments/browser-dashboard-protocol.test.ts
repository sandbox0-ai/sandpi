import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserDashboardReadOnlyGate,
  browserDashboardRejectedResponse,
} from "./browser-dashboard-protocol";

function request(id: number, method: string, params: unknown) {
  return Buffer.from(JSON.stringify({ id, method, params }));
}

test("allows only read-only Dashboard lifecycle messages", () => {
  const gate = new BrowserDashboardReadOnlyGate();

  assert.deepEqual(
    gate.inspect(request(1, "setVisible", { visible: false }), false),
    { action: "forward", method: "setVisible" },
  );
  assert.deepEqual(
    gate.inspect(
      request(2, "selectTab", {
        browser: "browser-guid",
        context: "context-guid",
        page: "page-guid",
      }),
      false,
    ),
    { action: "forward", method: "selectTab" },
  );
  assert.deepEqual(
    gate.inspect(request(3, "setVisible", { visible: true }), false),
    { action: "forward", method: "setVisible" },
  );
});

test("rejects all Dashboard page mutations", () => {
  for (const method of [
    "newTab",
    "closeTab",
    "closeSession",
    "navigate",
    "back",
    "forward",
    "reload",
    "mousemove",
    "mousedown",
    "mouseup",
    "wheel",
    "keydown",
    "keyup",
    "screenshot",
    "startRecording",
    "stopRecording",
    "submitAnnotation",
  ]) {
    const decision = new BrowserDashboardReadOnlyGate().inspect(
      request(9, method, {}),
      false,
    );
    assert.deepEqual(decision, {
      action: "reject",
      method,
      requestId: 9,
      reason: "blocked",
    });
    if (decision.action !== "reject") assert.fail("mutation was forwarded");
    assert.match(
      browserDashboardRejectedResponse(decision) ?? "",
      /view-only/,
    );
  }
});

test("allows the hidden adapter to select a source only once", () => {
  const gate = new BrowserDashboardReadOnlyGate();
  const first = request(1, "selectTab", {
    browser: "browser-guid",
    context: "context-guid",
    page: "page-one",
  });
  const second = request(2, "selectTab", {
    browser: "browser-guid",
    context: "context-guid",
    page: "page-two",
  });

  assert.equal(gate.inspect(first, false).action, "forward");
  assert.deepEqual(gate.inspect(second, false), {
    action: "reject",
    method: "selectTab",
    requestId: 2,
    reason: "source_already_selected",
  });
});

test("rejects malformed, oversized and binary Dashboard messages", () => {
  const gate = new BrowserDashboardReadOnlyGate();

  assert.deepEqual(gate.inspect(Buffer.from("not json"), false), {
    action: "reject",
    reason: "invalid_json",
  });
  assert.deepEqual(gate.inspect(Buffer.from("binary"), true), {
    action: "reject",
    reason: "binary_message",
  });
  assert.deepEqual(
    gate.inspect(request(1, "setVisible", { visible: true, extra: true }), false),
    {
      action: "reject",
      method: "setVisible",
      requestId: 1,
      reason: "blocked",
    },
  );
  assert.deepEqual(
    gate.inspect(Buffer.alloc(16 * 1024 + 1, 1), false),
    { action: "reject", reason: "message_too_large" },
  );
});

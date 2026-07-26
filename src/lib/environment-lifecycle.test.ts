import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS,
  idlePauseTimeoutSecondsFromMinutesInput,
  MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS,
} from "./environment-lifecycle";

test("new Environments default to a fifteen-minute idle pause", () => {
  assert.equal(DEFAULT_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS, 15 * 60);
});

test("parses editable whole-minute idle pause values", () => {
  assert.equal(idlePauseTimeoutSecondsFromMinutesInput(""), undefined);
  assert.equal(idlePauseTimeoutSecondsFromMinutesInput("15"), 15 * 60);
  assert.equal(idlePauseTimeoutSecondsFromMinutesInput("0"), 0);
  assert.equal(
    idlePauseTimeoutSecondsFromMinutesInput(
      String(MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS / 60),
    ),
    MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS,
  );
  assert.equal(idlePauseTimeoutSecondsFromMinutesInput("1.5"), undefined);
  assert.equal(idlePauseTimeoutSecondsFromMinutesInput("-1"), undefined);
  assert.equal(
    idlePauseTimeoutSecondsFromMinutesInput(
      String(MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS / 60 + 1),
    ),
    undefined,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  terminalEnvironmentNeedsUpdate,
  terminalEnvironmentUpdate,
  terminalSessionEnvironment,
} from "./terminal-environment";

test("provides a usable fallback for an unconfigured Vi-compatible editor", () => {
  assert.deepEqual(terminalSessionEnvironment(), {
    HOME: "/workspace",
    TERM: "xterm-256color",
    EXINIT: "set esckeys",
  });
  assert.equal(terminalEnvironmentNeedsUpdate(undefined), true);
});

test("preserves explicit editor and unrelated terminal environment settings", () => {
  const environment = terminalSessionEnvironment({
    COLORTERM: "truecolor",
    EXINIT: "source /workspace/.exrc",
    HOME: "/tmp/old-home",
    TERM: "dumb",
  });

  assert.deepEqual(environment, {
    COLORTERM: "truecolor",
    EXINIT: "source /workspace/.exrc",
    HOME: "/workspace",
    TERM: "xterm-256color",
  });
  assert.equal(terminalEnvironmentNeedsUpdate(environment), false);
});

test("defers environment migration until the existing shell has stopped", () => {
  const legacyEnvironment = {
    HOME: "/workspace",
    TERM: "xterm-256color",
  };

  assert.equal(
    terminalEnvironmentUpdate(legacyEnvironment, false),
    undefined,
  );
  assert.deepEqual(terminalEnvironmentUpdate(legacyEnvironment, true), {
    HOME: "/workspace",
    TERM: "xterm-256color",
    EXINIT: "set esckeys",
  });
});

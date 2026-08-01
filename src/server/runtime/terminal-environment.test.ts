import assert from "node:assert/strict";
import test from "node:test";

import {
  terminalCommandUpdate,
  terminalEnvironmentNeedsUpdate,
  terminalEnvironmentUpdate,
  terminalSessionCommand,
  terminalSessionEnvironment,
} from "./terminal-environment";

test("provides a usable fallback for an unconfigured Vi-compatible editor", () => {
  const environment = terminalSessionEnvironment();

  assert.equal(environment.HOME, "/workspace");
  assert.equal(environment.TERM, "xterm-256color");
  assert.equal(environment.EXINIT, "set esckeys");
  assert.match(environment.SANDPI_TERMINAL_BASH_INIT, /PS1='# '/);
  assert.equal(terminalEnvironmentNeedsUpdate(undefined), true);
});

test("loads user shell configuration after the compact Bash fallback", () => {
  const init = terminalSessionEnvironment().SANDPI_TERMINAL_BASH_INIT;
  const fallback = init.indexOf("PS1='# '");

  assert.ok(fallback >= 0);
  assert.ok(init.indexOf('$HOME/.bash_profile') > fallback);
  assert.ok(init.indexOf('$HOME/.bash_login') > fallback);
  assert.ok(init.indexOf('$HOME/.profile') > fallback);
  assert.ok(init.indexOf('$HOME/.bashrc') > fallback);
  assert.doesNotMatch(init, /ZDOTDIR|--no-rcs/);
});

test("uses the managed Bash bootstrap without disabling user rc files", () => {
  const command = terminalSessionCommand();

  assert.deepEqual(command.slice(0, 2), ["/bin/bash", "-c"]);
  assert.match(command[2] ?? "", /SANDPI_TERMINAL_BASH_INIT/);
  assert.match(command[2] ?? "", /--noprofile --rcfile \/dev\/fd\/3 -i/);
  assert.equal(terminalCommandUpdate(command, true), undefined);
  assert.equal(terminalCommandUpdate(["/bin/bash", "-l"], false), undefined);
  assert.deepEqual(
    terminalCommandUpdate(["/bin/bash", "-l"], true),
    command,
  );
});

test("preserves explicit editor and unrelated terminal environment settings", () => {
  const environment = terminalSessionEnvironment({
    COLORTERM: "truecolor",
    EXINIT: "source /workspace/.exrc",
    HOME: "/tmp/old-home",
    SANDPI_TERMINAL_BASH_INIT: "stale bootstrap",
    TERM: "dumb",
  });

  assert.equal(environment.COLORTERM, "truecolor");
  assert.equal(environment.EXINIT, "source /workspace/.exrc");
  assert.equal(environment.HOME, "/workspace");
  assert.equal(environment.TERM, "xterm-256color");
  assert.notEqual(
    environment.SANDPI_TERMINAL_BASH_INIT,
    "stale bootstrap",
  );
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
  const update = terminalEnvironmentUpdate(legacyEnvironment, true);
  assert.equal(update?.HOME, "/workspace");
  assert.equal(update?.TERM, "xterm-256color");
  assert.equal(update?.EXINIT, "set esckeys");
  assert.match(update?.SANDPI_TERMINAL_BASH_INIT ?? "", /PS1='# '/);
});

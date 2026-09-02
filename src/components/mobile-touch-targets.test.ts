import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function css(name: string) {
  return readFile(new URL(name, import.meta.url), "utf8");
}

test("native terminal mobile controls keep a 44px touch target", async () => {
  const [globals, guest, terminal, sidebar, tips] = await Promise.all([
    css("../app/globals.css"),
    css("./guest-sandpi-app.module.css"),
    css("./agent-terminal-workspace.module.css"),
    css("./environment-sidebar.module.css"),
    css("./sidebar-tips.module.css"),
  ]);

  assert.match(
    globals,
    /\.icon-button\.sidebar-close-button,\s*\.icon-button\.mobile-menu-button\s*\{[^}]*width: 44px;[^}]*height: 44px;/,
  );
  assert.match(
    globals,
    /\.terminal-v2-settings \.settings-nav button,[^{]*\{[^}]*min-height: 44px;/,
  );
  assert.match(
    guest,
    /\.touchActions button\s*\{[^}]*min-height: 44px;/,
  );
  assert.match(
    guest,
    /\.helpButton\s*\{[^}]*width: 44px;[^}]*height: 44px;/,
  );
  assert.match(
    terminal,
    /\.menuButton,\s*\.header button,\s*\.viewerNotice button,\s*\.connectionNotice button\s*\{[^}]*min-width: 44px;[^}]*min-height: 44px;/,
  );
  assert.match(
    terminal,
    /\.virtualKeys button,\s*\.actions button\s*\{[^}]*min-height: 44px;/,
  );
  assert.match(
    sidebar,
    /\.row\s*\{[^}]*grid-template-columns: 44px minmax\(0, 1fr\) 44px;/,
  );
  assert.match(
    tips,
    /\.iconButton\s*\{[^}]*width: 44px;[^}]*height: 44px;/,
  );
});

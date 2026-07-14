import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import type { ApiEnvelope } from "../src/lib/api-client";
import type {
  SandpiBootstrap,
  WorkspaceIdeFile,
  WorkspaceIdeSnapshot,
} from "../src/lib/types";

async function pageBlocksUnload(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    return !window.dispatchEvent(event) && event.defaultPrevented;
  });
}

async function activeWorkspace(request: APIRequestContext) {
  const response = await request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
  const session = bootstrap.data.sessions.find((candidate) => !candidate.archived);
  const environment = bootstrap.data.environments.find(
    (candidate) => candidate.id === session?.environmentId,
  );
  return session && environment ? { environment, session } : null;
}

test("loads the live workspace and Environment credential surface", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  const newSessionHeading = page.getByRole("heading", {
    name: "What should Codex work on?",
  });
  if (!(await newSessionHeading.isVisible())) {
    await page
      .getByRole("button", { name: "New session in Development" })
      .click();
  }
  await expect(
    newSessionHeading,
  ).toBeVisible();
  await expect(page.getByText("Development", { exact: true }).first()).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(page.getByRole("img", { name: "pixel.png" })).toBeVisible();

  await page.getByRole("button", { name: "Development settings" }).last().click();
  await page.getByRole("button", { name: /Coding agent/ }).click();
  await expect(
    page.locator(".credential-row").getByText(/Connected|Not connected/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^(Connect|Re-authenticate) Codex$/ }),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("serves shared Preferences and Team layouts", async ({ page }) => {
  await page.goto("/preferences");
  await expect(page).toHaveURL(/\/preferences\/?$/);
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
  await expect(page.getByText("Environment and coding agent settings live with each Environment.")).toBeVisible();

  await page.goto("/team");
  await expect(page).toHaveURL(/\/team\/?$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Sandpi", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Sandpi control plane", { exact: true })).toBeVisible();
});

test("warns before unloading an open Session chat only", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);

  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await expect(page.locator("#conversation")).toBeVisible();
  await expect.poll(() => pageBlocksUnload(page)).toBe(true);

  await page
    .getByRole("button", { name: `New session in ${environment.name}` })
    .click();
  await expect(
    page.getByRole("heading", { name: "What should Codex work on?" }),
  ).toBeVisible();
  await expect.poll(() => pageBlocksUnload(page)).toBe(false);
});

test("shows a matching skeleton while each Inspector tab loads", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/api/v1/sessions/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/\/(ide|audit|metrics)$/.test(path)) {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    await route.continue();
  });

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await page.getByRole("button", { name: "Open inspector" }).click();
  const tabs = page.getByRole("navigation", { name: "Inspector views" });

  for (const [tab, label] of [
    ["files", "Files"],
    ["audit", "Audit"],
    ["metrics", "Metrics"],
  ] as const) {
    if (tab !== "files") await tabs.getByRole("button", { name: label }).click();
    const skeleton = page.locator(`.inspector-skeleton-${tab}`);
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toContainText(`Loading ${label.toLowerCase()}…`);
    await expect(skeleton).toBeHidden();
  }

  const rangeRequest = page.waitForRequest((candidate) => {
    const url = new URL(candidate.url());
    return (
      url.pathname.endsWith(`/sessions/${session.id}/metrics`) &&
      url.searchParams.get("rangeSeconds") === "21600"
    );
  });
  const metricsRange = page.getByRole("combobox", {
    name: "Metrics time range",
  });
  await metricsRange.selectOption("21600");
  await rangeRequest;
  await expect(page.locator(".inspector-skeleton-metrics")).toBeVisible();
  await expect(page.locator(".inspector-skeleton-metrics")).toBeHidden();
  await expect(page.getByText("Last 6 hours", { exact: true })).toBeVisible();

  const modelPicker = page.getByRole("combobox", {
    name: `Select ${environment.codingAgent.label} model`,
  });
  await expect(modelPicker).toBeEnabled();
  await expect.poll(() => modelPicker.locator("option").count()).toBeGreaterThan(0);
  const firstNativeModel = await modelPicker.locator("option").first().getAttribute("value");
  expect(firstNativeModel).toBeTruthy();
  await modelPicker.selectOption(firstNativeModel ?? "");
  await expect(modelPicker).toHaveValue(firstNativeModel ?? "");
  expect(browserErrors).toEqual([]);
});

test("renders the dedicated live Web IDE with Git state and changed lines", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const now = Date.now() / 1_000;
  const snapshot: WorkspaceIdeSnapshot = {
    refreshedAt: now,
    files: [
      {
        id: "workspace",
        name: "workspace",
        path: "/workspace",
        kind: "folder",
        children: [
          {
            id: "src",
            name: "src",
            path: "/workspace/src",
            kind: "folder",
            children: [
              {
                id: "demo",
                name: "demo.ts",
                path: "/workspace/src/demo.ts",
                kind: "file",
                language: "TypeScript",
                size: "83 B",
                modifiedAt: now,
              },
            ],
          },
        ],
      },
    ],
    git: {
      isRepository: true,
      root: "/workspace",
      branch: "feature/live-ide",
      head: "abc123",
      upstream: "origin/feature/live-ide",
      ahead: 1,
      behind: 0,
      files: [
        {
          path: "/workspace/src/demo.ts",
          relativePath: "src/demo.ts",
          kind: "modified",
          indexStatus: ".",
          worktreeStatus: "M",
          staged: false,
          unstaged: true,
        },
      ],
    },
  };
  const file: WorkspaceIdeFile = {
    path: "/workspace/src/demo.ts",
    name: "demo.ts",
    encoding: "base64",
    content: Buffer.from(
      [
        "export function status() {",
        '  const transport = "websocket";',
        '  return "live";',
        "}",
        "",
      ].join("\n"),
    ).toString("base64"),
    kind: "text",
    size: "83 B",
    modifiedAt: now,
    git: snapshot.git.files[0],
    lineChanges: [
      {
        line: 2,
        kind: "modified",
        staged: false,
        unstaged: true,
      },
      { line: 3, kind: "added", staged: false, unstaged: true },
    ],
  };
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/api/v1/sessions/**/ide/file?*", async (route) => {
    await route.fulfill({ json: { data: file } });
  });
  await page.route("**/api/v1/sessions/**/ide", async (route) => {
    await route.fulfill({ json: { data: snapshot } });
  });

  await page.goto(
    `/ide/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await expect(
    page.getByRole("region", { name: "Sandpi Web IDE" }),
  ).toBeVisible();
  await expect(page.getByText("workspace", { exact: true })).toBeVisible();
  await expect(
    page.locator('button[title="/workspace/src/demo.ts"]'),
  ).toBeVisible();
  await expect(page.getByText('const transport = "websocket";')).toBeVisible();
  await expect(page.locator('[class*="line-modified"]')).toHaveCount(1);
  await expect(page.locator('[class*="line-added"]')).toHaveCount(1);
  await expect(page.getByText("feature/live-ide", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 uncommitted file.*↑1/)).toBeVisible();
  await expect.poll(() => pageBlocksUnload(page)).toBe(true);
  expect(browserErrors).toEqual([]);
});

test("restores a new-Session deep link and keeps overlays usable in dark mode", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "sandpi.preferences.v1",
      JSON.stringify({
        general: {
          language: "en",
          timeZone: "UTC",
          sendShortcut: "enter",
        },
        appearance: { theme: "dark", density: "comfortable" },
        notifications: { sessionCompleted: true, needsAttention: true },
      }),
    );
  });

  await page.goto("/?team=team-default&environment=env-default&new=1");
  await expect(
    page.getByRole("heading", { name: "What should Codex work on?" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "dark",
  );

  await page.getByRole("button", { name: "New environment" }).click();
  await expect(
    page.getByRole("dialog", { name: "New Environment" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /Search sessions/i }).click();
  await expect(
    page.getByPlaceholder("Search sessions or environments…"),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Development settings" }).last().click();
  await expect(
    page.getByRole("dialog", { name: "Development settings" }),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

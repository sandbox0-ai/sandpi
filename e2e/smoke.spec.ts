import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";

import type { ApiEnvelope } from "../src/lib/api-client";
import type {
  SandpiBootstrap,
  WorkspaceDirectoryListing,
  WorkspaceIdeFile,
  WorkspaceIdeSnapshot,
} from "../src/lib/types";
import {
  mockEnvironmentAudit,
  mockEnvironmentMetrics,
} from "../src/lib/mock-data";

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

test("requires an exact Environment name before permanent deletion", async ({
  page,
  request,
}) => {
  const response = await request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
  const environment = bootstrap.data.environments[0];
  test.skip(!environment, "An Environment is required for this check.");
  if (!environment) return;

  let deleteCalls = 0;
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}`,
    async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      deleteCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { id: environment.id } }),
      });
    },
  );

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  await page
    .getByRole("button", { name: `${environment.name} settings` })
    .last()
    .click();
  await page.getByRole("button", { name: "Delete Environment" }).click();

  const confirmation = page.getByLabel(
    `Type ${environment.name} to confirm`,
  );
  const deletePermanently = page.getByRole("button", {
    name: "Delete permanently",
  });
  await expect(deletePermanently).toBeDisabled();
  await confirmation.fill(`${environment.name} typo`);
  await expect(deletePermanently).toBeDisabled();
  await confirmation.fill(environment.name);
  await expect(deletePermanently).toBeEnabled();
  await deletePermanently.click();

  await expect(
    page.getByRole("dialog", { name: `${environment.name} settings` }),
  ).toBeHidden();
  await expect
    .poll(() => deleteCalls)
    .toBe(1);
  await expect(
    page.getByRole("button", { name: `${environment.name} settings` }),
  ).toHaveCount(0);
  if (bootstrap.data.environments.length === 1) {
    await expect(
      page.getByRole("heading", { name: "Create an Environment" }),
    ).toBeVisible();
  }
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

test("keeps the Codex live event response open between tool updates", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const eventPath = `/api/v1/sessions/${session.id}/events`;
  let eventRequests = 0;
  page.on("request", (browserRequest) => {
    if (new URL(browserRequest.url()).pathname === eventPath) {
      eventRequests += 1;
    }
  });

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await expect(page.locator("#conversation")).toBeVisible();
  await expect.poll(() => eventRequests).toBeGreaterThan(0);
  // React development mode may perform one immediate setup/cleanup probe. Let
  // that settle, then assert the response remains open instead of reconnecting
  // at the EventSource retry interval while Codex is between notifications.
  await page.waitForTimeout(500);
  const settledRequests = eventRequests;
  await page.waitForTimeout(2_500);
  expect(eventRequests).toBe(settledRequests);
});

test("reconciles agent-created files while the native volume watch is unavailable", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const now = Date.now() / 1_000;
  const livePath = "/workspace/live-agent-file.ts";
  let exposeLiveFile = false;
  let snapshotReads = 0;
  const liveFile: WorkspaceIdeFile = {
    path: livePath,
    name: "live-agent-file.ts",
    revision: `sha256:${"d".repeat(43)}`,
    encoding: "base64",
    content: Buffer.from("export const createdByAgent = true;\n").toString(
      "base64",
    ),
    kind: "text",
    editable: true,
    size: "36 B",
    modifiedAt: now,
    lineChanges: [],
  };

  await page.route("**/api/v1/environments/**/ide/file?*", async (route) => {
    await route.fulfill({ json: { data: liveFile } });
  });
  await page.route("**/api/v1/environments/**/ide", async (route) => {
    snapshotReads += 1;
    const snapshot: WorkspaceIdeSnapshot = {
      refreshedAt: now,
      files: [
        {
          id: "workspace",
          name: "workspace",
          path: "/workspace",
          kind: "folder",
          children: exposeLiveFile
            ? [
                {
                  id: "live-agent-file",
                  name: liveFile.name,
                  path: liveFile.path,
                  kind: "file",
                  language: "TypeScript",
                  size: liveFile.size,
                  modifiedAt: liveFile.modifiedAt,
                },
              ]
            : [],
        },
      ],
      git: { repositories: [] },
    };
    await route.fulfill({ json: { data: snapshot } });
  });
  await page.routeWebSocket(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/ide/events`,
    () => {
      // Deliberately leave the native watch open without a ready frame.
    },
  );

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await page.getByRole("button", { name: "Open inspector" }).click();
  await expect(page.locator(".ide-panel")).toBeVisible();
  await expect(page.locator(`button[title="${livePath}"]`)).toHaveCount(0);

  exposeLiveFile = true;
  await expect(page.locator(`button[title="${livePath}"]`)).toBeVisible({
    timeout: 7_000,
  });
  expect(snapshotReads).toBeGreaterThan(1);
});

test("replays only the last three terminal commands after reopen", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const terminalSessionId = "ses-terminal-e2e";
  const attemptId = "attempt-terminal-e2e";
  const connectionUrls: string[] = [];
  const history: Array<{ seq: number; data: string }> = [
    { seq: 1, data: "sandpi$ " },
  ];

  const sendOutput = (
    socket: { send(message: string): void },
    event: { seq: number; data: string },
  ) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: {
          seq: event.seq,
          attemptId,
          stream: "pty",
          type: "output",
          dataBase64: Buffer.from(event.data).toString("base64"),
        },
      }),
    );
  };

  await page.routeWebSocket(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/terminal`,
    (socket) => {
      connectionUrls.push(socket.url());
      const after = Number(new URL(socket.url()).searchParams.get("after") ?? 0);
      socket.send(
        JSON.stringify({
          type: "ready",
          sessionId: terminalSessionId,
          attemptId,
          replayAfter: after,
          replayUntil: history.at(-1)?.seq ?? after,
          replayReset: false,
        }),
      );
      history.filter((event) => event.seq > after).forEach((event) => {
        sendOutput(socket, event);
      });

      let input = "";
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as {
          type?: string;
          data?: string;
        };
        if (message.type !== "input" || !message.data) return;
        input += message.data;
        if (!/[\r\n]/.test(message.data)) return;
        const command = input.replace(/[\r\n]+$/g, "");
        input = "";
        const event = {
          seq: history.at(-1)!.seq + 1,
          data: `${command}\r\nresult:${command}\r\nsandpi$ `,
        };
        history.push(event);
        sendOutput(socket, event);
      });
    },
  );

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await page.getByRole("button", { name: "Terminal" }).click();
  const terminal = page.getByRole("region", {
    name: `Terminal for ${environment.name}`,
  });
  await expect(terminal).toBeVisible();
  await expect.poll(() => connectionUrls.length).toBe(1);

  const screen = terminal.locator(".xterm-rows");
  for (let command = 1; command <= 4; command += 1) {
    await terminal.getByRole("application").click();
    await page.keyboard.type(`command-${command}`);
    await page.keyboard.press("Enter");
    await expect(screen).toContainText(`result:command-${command}`);
  }

  await terminal.getByRole("button", { name: "Close terminal" }).click();
  await expect(terminal).toBeHidden();

  await page.getByRole("button", { name: "Terminal" }).click();
  await expect(terminal).toBeVisible();
  await expect.poll(() => connectionUrls.length).toBe(2);
  const replayUrl = new URL(connectionUrls[1]!);
  expect(replayUrl.searchParams.get("after")).toBe("2");
  expect(replayUrl.searchParams.get("terminalSessionId")).toBe(
    terminalSessionId,
  );
  await expect(screen).not.toContainText("result:command-1");
  for (let command = 2; command <= 4; command += 1) {
    await expect(screen).toContainText(`result:command-${command}`);
  }

  const storedReplay = await page.evaluate((storageKey) => {
    return JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
  }, `sandpi.terminal-replay.v2:${environment.id}`);
  expect(storedReplay).toMatchObject({
    terminalSessionId,
    lastSequence: 5,
    commandStartSequences: [2, 3, 4],
  });
});

test("does not answer historical terminal queries on the live PTY", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const messages: Array<{
    type?: string;
    data?: string;
    dataBase64?: string;
  }> = [];
  let terminalSocket: WebSocketRoute | undefined;

  await page.routeWebSocket(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/terminal`,
    (socket) => {
      terminalSocket = socket;
      socket.onMessage((raw) => {
        messages.push(JSON.parse(String(raw)));
      });
      socket.send(
        JSON.stringify({
          type: "ready",
          sessionId: "ses-terminal-query-e2e",
          attemptId: "attempt-terminal-query-e2e",
          replayAfter: 0,
          replayUntil: 1,
          replayReset: false,
        }),
      );
      socket.send(
        JSON.stringify({
          type: "event",
          event: {
            seq: 1,
            attemptId: "attempt-terminal-query-e2e",
            stream: "pty",
            type: "output",
            // DSR 5 asks the emulator to answer ESC [ 0 n. A historical
            // query must update the renderer without writing that answer to
            // the live shell that now owns the PTY.
            dataBase64: Buffer.from("\u001b[5nrestored screen").toString(
              "base64",
            ),
          },
        }),
      );
    },
  );

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await page.getByRole("button", { name: "Terminal" }).click();
  const terminal = page.getByRole("region", {
    name: `Terminal for ${environment.name}`,
  });
  await expect(terminal).toContainText("live");
  await expect(terminal.locator(".xterm-rows")).toContainText(
    "restored screen",
  );
  await page.waitForTimeout(100);
  expect(messages.filter((message) => message.type === "input")).toEqual([]);

  terminalSocket?.send(
    JSON.stringify({
      type: "event",
      event: {
        seq: 2,
        attemptId: "attempt-terminal-query-e2e",
        stream: "pty",
        type: "output",
        dataBase64: Buffer.from("\u001b[5n").toString("base64"),
      },
    }),
  );
  await expect
    .poll(() =>
      messages.some(
        (message) => message.type === "input" && message.data === "\u001b[0n",
      ),
    )
    .toBe(true);
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
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/\/(ide|audit|metrics)$/.test(path)) {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (path.endsWith("/ide")) {
      await route.fulfill({
        json: {
          data: {
            files: [],
            git: { repositories: [] },
            refreshedAt: Date.now() / 1_000,
          },
        },
      });
      return;
    }
    if (path.endsWith("/audit")) {
      await route.fulfill({ json: { data: mockEnvironmentAudit } });
      return;
    }
    if (path.endsWith("/metrics")) {
      await route.fulfill({ json: { data: mockEnvironmentMetrics } });
      return;
    }
    if (path.endsWith("/models")) {
      await route.fulfill({
        json: {
          data: {
            data: [
              {
                id: "e2e-native-codex-model",
                displayName: "E2E native Codex model",
                isDefault: true,
              },
            ],
          },
          meta: { availability: "available", source: "codex" },
        },
      });
      return;
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
      url.pathname.endsWith(`/environments/${environment.id}/metrics`) &&
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
  const { environment } = workspace;
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
          },
        ],
      },
    ],
    git: {
      repositories: [
        {
          root: "/workspace/src",
          branch: "feature/live-ide",
          head: "abc123",
          upstream: "origin/feature/live-ide",
          ahead: 1,
          behind: 0,
          files: [
            {
              path: "/workspace/src/demo.ts",
              relativePath: "demo.ts",
              kind: "modified",
              indexStatus: ".",
              worktreeStatus: "M",
              staged: false,
              unstaged: true,
            },
          ],
        },
      ],
    },
  };
  const file: WorkspaceIdeFile = {
    path: "/workspace/src/demo.ts",
    name: "demo.ts",
    revision: `sha256:${"a".repeat(43)}`,
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
    editable: true,
    size: "83 B",
    modifiedAt: now,
    git: snapshot.git.repositories[0]?.files[0],
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
    if (
      message.type() === "error" &&
      !message.text().includes("status of 409 (Conflict)")
    ) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  let savedContent = "";
  let directoryLoads = 0;
  let remoteFile = file;
  await page.route("**/api/v1/environments/**/files?*", async (route) => {
    const directoryPath = new URL(route.request().url()).searchParams.get("path");
    expect(directoryPath).toBe("/workspace/src");
    directoryLoads += 1;
    const listing: WorkspaceDirectoryListing = {
      path: "/workspace/src",
      refreshedAt: now,
      entries: [
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
    };
    await route.fulfill({ json: { data: listing } });
  });
  await page.route("**/api/v1/environments/**/ide/file?*", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as {
        content: string;
        baseRevision: string;
      };
      if (body.baseRevision !== remoteFile.revision) {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: "workspace_file_conflict",
              message: "The file changed after it was opened.",
              details: { currentRevision: remoteFile.revision },
            },
          },
        });
        return;
      }
      savedContent = Buffer.from(body.content, "base64").toString("utf8");
      remoteFile = {
        ...remoteFile,
        revision: `sha256:${"b".repeat(43)}`,
        content: body.content,
      };
      await route.fulfill({
        json: { data: remoteFile },
      });
      return;
    }
    await route.fulfill({ json: { data: remoteFile } });
  });
  await page.route("**/api/v1/environments/**/ide", async (route) => {
    await route.fulfill({ json: { data: snapshot } });
  });

  await page.goto(
    `/ide/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  await expect(
    page.getByRole("region", { name: "Sandpi Web IDE" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to Environment" }),
  ).toBeVisible();
  await expect(page.getByText(`sandpi / ${environment.name}`)).toBeVisible();
  await expect(page.getByText("workspace", { exact: true })).toBeVisible();
  await expect(
    page.locator('button[title="/workspace/src/demo.ts"]'),
  ).toHaveCount(0);
  const sourceFolder = page.locator('button[title="/workspace/src"]');
  await sourceFolder.click();
  await expect(
    page.locator('button[title="/workspace/src/demo.ts"]'),
  ).toBeVisible();
  await expect.poll(() => directoryLoads).toBe(1);
  await sourceFolder.click();
  await sourceFolder.click();
  await expect.poll(() => directoryLoads).toBe(1);
  await expect(page.getByText('const transport = "websocket";')).toBeVisible();
  await expect(page.locator(".sandpi-line-modified")).toHaveCount(1);
  await expect(page.locator(".sandpi-line-added")).toHaveCount(1);
  await expect(page.getByText("feature/live-ide", { exact: true })).toBeVisible();
  await expect(page.getByText("src · feature/live-ide", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 uncommitted file.*↑1/)).toBeVisible();
  const editor = page.locator(".monaco-editor").first();
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("export const editedInBrowser = true;\n");
  const save = page.getByRole("button", { name: /Save file/ });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => savedContent).toContain("editedInBrowser");
  await expect(save).toBeDisabled();

  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("// local draft\n");
  remoteFile = {
    ...remoteFile,
    revision: `sha256:${"c".repeat(43)}`,
    content: Buffer.from("export const externalChange = true;\n").toString("base64"),
  };
  await save.click();
  await expect(page.getByText("This file changed outside the editor.")).toBeVisible();
  await page.getByRole("button", { name: "Use latest" }).click();
  await expect(page.getByText("export const externalChange = true;")).toBeVisible();
  await expect(save).toBeDisabled();

  snapshot.git = { repositories: [] };
  remoteFile = { ...remoteFile, git: undefined, lineChanges: [] };
  await page.getByRole("button", { name: "Refresh Workspace" }).click();
  await expect(
    page.getByText("No Git repositories in this Workspace", { exact: true }),
  ).toBeVisible();
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

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
import type {
  CodexEventEnvelope,
  CodexNativeSnapshot,
} from "../src/harnesses/codex/types";
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

async function readyEnvironment(request: APIRequestContext) {
  const response = await request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
  return bootstrap.data.environments.find(
    (environment) => environment.status === "ready",
  );
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

test("prefills native MCP definitions from the three shortcut groups", async ({
  page,
  request,
}) => {
  const response = await request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
  const environment = bootstrap.data.environments[0];
  test.skip(!environment, "An Environment is required for this check.");
  if (!environment) return;

  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/mcp-servers`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            servers: [
              {
                name: "github",
                transport: "streamable-http",
                args: [],
                url: "https://api.githubcopilot.com/mcp/",
                enabled: true,
                required: false,
                enabledTools: [],
                disabledTools: [],
                managed: false,
                authStatus: "notLoggedIn",
                runtimeStatus: "authentication-required",
                toolCount: 0,
                resourceCount: 0,
              },
            ],
          },
        }),
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
  const settingsDialog = page.getByRole("dialog", {
    name: `${environment.name} settings`,
  });
  await settingsDialog.getByRole("button", { name: "MCP servers" }).click();

  await expect(
    settingsDialog.getByText("Aggregator services", { exact: true }),
  ).toBeVisible();
  await expect(
    settingsDialog.getByText("Third-party MCP servers", { exact: true }),
  ).toBeVisible();
  await expect(
    settingsDialog.getByText("Local MCP servers", { exact: true }),
  ).toBeVisible();
  await expect(
    settingsDialog.getByRole("button", { name: "GitHub is configured" }),
  ).toBeDisabled();

  await settingsDialog
    .getByRole("button", { name: "Configure OpenConnector" })
    .click();
  await expect(settingsDialog.getByLabel("Transport")).toHaveValue(
    "streamable-http",
  );
  await expect(settingsDialog.getByLabel("Server URL")).toHaveValue(
    "https://connector.oomol.com/v1/mcp",
  );
  await settingsDialog.getByRole("button", { name: "Cancel" }).click();

  await settingsDialog
    .getByRole("button", { name: "Configure Playwright" })
    .click();
  await expect(
    settingsDialog.getByText("Playwright", { exact: true }),
  ).toBeInViewport();
  await expect(
    settingsDialog.getByText(/Runs inside the Environment sandbox/),
  ).toBeInViewport();
  await expect(settingsDialog.getByLabel("Name")).toHaveValue("playwright");
  await expect(settingsDialog.getByLabel("Transport")).toHaveValue("stdio");
  await expect(settingsDialog.getByLabel("Command")).toHaveValue("npx");
  await expect(settingsDialog.getByLabel(/Arguments/)).toHaveValue(
    "-y\n@playwright/mcp@latest\n--headless\n--no-sandbox",
  );

  await settingsDialog.getByRole("button", { name: "Cancel" }).click();
  await settingsDialog
    .getByRole("button", { name: "Configure Context7" })
    .click();
  await expect(settingsDialog.getByLabel("Name")).toHaveValue("context7");
  await expect(settingsDialog.getByLabel("Transport")).toHaveValue(
    "streamable-http",
  );
  await expect(settingsDialog.getByLabel("Server URL")).toHaveValue(
    "https://mcp.context7.com/mcp",
  );
});

test("configures Sandbox0 network modes through safe domain exceptions", async ({
  page,
  request,
}) => {
  const environment = await readyEnvironment(request);
  test.skip(!environment, "A ready Environment is required for this check.");
  if (!environment) return;

  const browserErrors: string[] = [];
  let submittedNetworkPolicy: unknown;
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.route("**/api/v1/bootstrap**", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
    const routedEnvironment = body.data.environments.find(
      (candidate) => candidate.id === environment.id,
    );
    if (routedEnvironment) {
      routedEnvironment.networkPolicy = {
        mode: "block-all",
        domainExceptions: [],
      };
    }
    await route.fulfill({ response, json: body });
  });
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}`,
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON() as {
        networkPolicy: unknown;
      };
      submittedNetworkPolicy = body.networkPolicy;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            ...environment,
            ...body,
            revision: environment.revision + 1,
          },
        }),
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
  const settingsDialog = page.getByRole("dialog", {
    name: `${environment.name} settings`,
  });
  await settingsDialog.getByRole("button", { name: "Network" }).click();

  const blockByDefault = settingsDialog.getByRole("radio", {
    name: /Block by default/,
  });
  const allowByDefault = settingsDialog.getByRole("radio", {
    name: /Allow by default/,
  });
  await expect(blockByDefault).toBeChecked();
  await expect(
    settingsDialog.getByText("Allowed domains", { exact: true }),
  ).toBeVisible();
  await expect(
    settingsDialog.getByText(
      "No exceptions. All outbound destinations are blocked.",
    ),
  ).toBeVisible();
  await expect(settingsDialog.getByText("Restricted")).toHaveCount(0);
  await expect(settingsDialog.getByText("Log denied requests")).toHaveCount(0);

  const domainInput = settingsDialog.getByLabel("Domain to allow");
  await domainInput.fill("https://github.com");
  await settingsDialog.getByRole("button", { name: "Allow domain" }).click();
  await expect(
    settingsDialog.getByRole("alert").getByText(/without a URL, path, or port/),
  ).toBeVisible();

  await domainInput.fill("GitHub.COM.");
  await settingsDialog.getByRole("button", { name: "Allow domain" }).click();
  await expect(settingsDialog.getByText("github.com", { exact: true })).toBeVisible();

  await settingsDialog
    .getByText("Allow by default", { exact: true })
    .click();
  await expect(
    settingsDialog.getByRole("alert").getByText("Clear 1 allowed domain?"),
  ).toBeVisible();
  await settingsDialog
    .getByRole("button", { name: "Keep current mode" })
    .click();
  await expect(blockByDefault).toBeChecked();
  await expect(settingsDialog.getByText("github.com", { exact: true })).toBeVisible();

  await settingsDialog
    .getByText("Allow by default", { exact: true })
    .click();
  await settingsDialog
    .getByRole("button", { name: "Switch & clear domains" })
    .click();
  await expect(allowByDefault).toBeChecked();
  await expect(
    settingsDialog.getByText("Blocked domains", { exact: true }),
  ).toBeVisible();
  await expect(
    settingsDialog.getByText(
      "No exceptions. All outbound destinations are allowed.",
    ),
  ).toBeVisible();

  const blockedDomainInput = settingsDialog.getByLabel("Domain to block");
  await blockedDomainInput.fill("Telemetry.Example.dev");
  await settingsDialog.getByRole("button", { name: "Block domain" }).click();
  await expect(
    settingsDialog.getByText("telemetry.example.dev", { exact: true }),
  ).toBeVisible();
  await settingsDialog.getByRole("button", { name: "Save changes" }).click();

  await expect
    .poll(() => submittedNetworkPolicy)
    .toEqual({
      mode: "allow-all",
      domainExceptions: ["telemetry.example.dev"],
    });
  await expect(settingsDialog).toBeHidden();
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

test("shows a Sandbox0 credential failure instead of loading forever", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const message =
    "Sandbox0 rejected the deployment API key. Update SANDBOX0_API_KEY and restart Sandpi.";

  await page.route("**/api/v1/sessions/**/events", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: [
        "retry: 15000",
        "",
        "event: stream-error",
        `data: ${JSON.stringify({
          status: 401,
          code: "sandbox0_invalid_api_key",
          message,
          retryable: true,
        })}`,
        "",
        "",
      ].join("\n"),
    });
  });

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );

  await expect(page.getByRole("alert").getByText(message)).toBeVisible();
  await expect(page.getByText("Loading conversation…")).toBeHidden();
  await expect(page.getByText("Codex runtime unavailable")).toBeVisible();

  await page.getByRole("button", { name: "Open inspector" }).click();
  await page
    .getByRole("navigation", { name: "Inspector views" })
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  const activityView = page.getByLabel("Codex Session Activity", {
    exact: true,
  });
  await expect(activityView.getByRole("alert").getByText(message)).toBeVisible();
  await expect(activityView.getByText("Loading Codex activity…")).toBeHidden();
});

test("shows a fallback when the Codex EventSource handshake fails", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;

  await page.route("**/api/v1/sessions/**/events", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "authentication_required",
          message: "Sign in required.",
        },
      }),
    });
  });

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );

  await expect(
    page.getByRole("alert").getByText(
      "The Codex event stream could not be opened. Check the Sandpi server connection and deployment configuration.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Loading conversation…")).toBeHidden();
});

test("keeps Codex Session Activity native and Environment Audit separate", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const startedAt = Date.now() / 1_000 - 10;
  const nativeThreadId = "thread-e2e-native-activity";
  const nativeTurnId = "turn-e2e-native-activity";
  let auditRequests = 0;
  const auditCursors: string[] = [];
  let environmentUpdates = 0;
  let releaseAuditResponse!: () => void;
  const auditResponseGate = new Promise<void>((resolve) => {
    releaseAuditResponse = resolve;
  });
  const snapshot: CodexNativeSnapshot = {
    protocol: "codex-app-server",
    nativeSessionId: nativeThreadId,
    historyRevision: 7,
    modelId: "e2e-native-codex-model",
    sessionStatus: "waiting",
    forkableTurnIds: [nativeTurnId],
    activity: {
      source: "codex-rollout",
      availability: "available",
      error: null,
      records: [
        {
          kind: "rolloutToolCall",
          id: `rollout:${nativeTurnId}:custom:call-e2e-rollout-exec`,
          turnId: nativeTurnId,
          createdAt: startedAt + 1,
          completedAt: startedAt + 1.2,
          durationMs: 200,
          status: "completed",
          callId: "call-e2e-rollout-exec",
          callType: "custom_tool_call",
          name: "exec",
          namespace: null,
          nativeStatus: "completed",
          callPayload: {
            type: "custom_tool_call",
            call_id: "call-e2e-rollout-exec",
            name: "exec",
            input:
              'const r = await tools.exec_command({"cmd":"git status --short"});',
          },
          outputs: [{
            outputType: "custom_tool_call_output",
            createdAt: startedAt + 1.2,
            nativeStatus: null,
            payload: {
              type: "custom_tool_call_output",
              call_id: "call-e2e-rollout-exec",
              output: [
                {
                  type: "input_text",
                  text: "Script running with cell ID 6\nOutput:\nclean\n",
                },
              ],
            },
          }],
          codeModeTools: ["exec_command"],
          payloadTruncated: false,
        },
        {
          kind: "rolloutToolCall",
          id: `rollout:${nativeTurnId}:function:call-e2e-rollout-wait`,
          turnId: nativeTurnId,
          createdAt: startedAt + 2,
          completedAt: startedAt + 2.1,
          durationMs: 100,
          status: "completed",
          callId: "call-e2e-rollout-wait",
          callType: "function_call",
          name: "wait",
          namespace: null,
          nativeStatus: null,
          callPayload: {
            type: "function_call",
            call_id: "call-e2e-rollout-wait",
            name: "wait",
            arguments: '{"cell_id":"6"}',
          },
          outputs: [{
            outputType: "function_call_output",
            createdAt: startedAt + 2.1,
            nativeStatus: null,
            payload: {
              type: "function_call_output",
              call_id: "call-e2e-rollout-wait",
              output: "Script completed",
            },
          }],
          codeModeTools: [],
          payloadTruncated: false,
        },
      ],
    },
    thread: {
      id: nativeThreadId,
      createdAt: startedAt,
      updatedAt: startedAt + 5,
      status: { type: "idle" },
      turns: [
        {
          id: nativeTurnId,
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt,
          completedAt: startedAt + 5,
          durationMs: 5_000,
          items: [
            {
              type: "userMessage",
              id: "activity-e2e-user",
              clientId: null,
              content: [
                {
                  type: "text",
                  text: "Check the release and repository.",
                  text_elements: [],
                },
              ],
            },
            {
              type: "commandExecution",
              id: "activity-e2e-command",
              command: "git status --short",
              cwd: "/workspace",
              processId: null,
              source: "agent",
              status: "completed",
              commandActions: [
                { type: "unknown", command: "git status --short" },
              ],
              aggregatedOutput: "",
              exitCode: 0,
              durationMs: 40,
            },
            {
              type: "mcpToolCall",
              id: "activity-e2e-mcp",
              server: "github",
              tool: "get_release",
              status: "completed",
              arguments: { owner: "sandbox0-ai", repo: "sandpi" },
              appContext: {
                connectorId: "github",
                linkId: null,
                resourceUri: null,
                appName: "GitHub",
                templateId: null,
                actionName: "Get release",
              },
              pluginId: null,
              result: {
                content: [{ type: "text", text: "v1.2.3" }],
                structuredContent: { tag: "v1.2.3" },
                _meta: null,
              },
              error: null,
              durationMs: 180,
            },
            {
              type: "webSearch",
              id: "activity-e2e-web",
              query: "sandpi v1.2.3",
              action: {
                type: "openPage",
                url: "https://example.com/releases/v1.2.3",
              },
            },
            {
              type: "agentMessage",
              id: "activity-e2e-final",
              text: "The release is valid.",
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      ],
    },
  };
  const persistedActivity = snapshot.activity;
  const completedTurnNotification: CodexEventEnvelope = {
    harness: "codex",
    harnessVersion: "runtime",
    protocolVersion: "v2",
    sequence: 1,
    receivedAt: startedAt + 5,
    notification: {
      method: "turn/completed",
      params: {
        threadId: nativeThreadId,
        turn: snapshot.thread.turns[0]!,
      },
    },
  };
  snapshot.activity = {
    source: "codex-rollout",
    availability: "loading",
    records: [],
    error: null,
  };
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (browserRequest) => {
    const requestUrl = new URL(browserRequest.url());
    if (
      browserRequest.method() === "GET" &&
      requestUrl.pathname ===
        `/api/v1/environments/${encodeURIComponent(environment.id)}/audit`
    ) {
      auditRequests += 1;
      const cursor = requestUrl.searchParams.get("cursor");
      if (cursor) auditCursors.push(cursor);
    }
    if (
      browserRequest.method() === "PUT" &&
      requestUrl.pathname ===
        `/api/v1/environments/${encodeURIComponent(environment.id)}`
    ) {
      environmentUpdates += 1;
    }
  });

  await page.route("**/api/v1/sessions/**/events", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body:
        `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` +
        `event: notification\ndata: ${JSON.stringify(completedTurnNotification)}\n\n` +
        `event: activity\ndata: ${JSON.stringify({
          nativeSessionId: snapshot.nativeSessionId,
          historyRevision: snapshot.historyRevision,
          activity: persistedActivity,
        })}\n\n`,
    });
  });
  await page.route("**/api/v1/sessions/**/models", async (route) => {
    await route.fulfill({
      json: {
        data: {
          data: [
            {
              id: snapshot.modelId,
              displayName: "E2E native Codex model",
              isDefault: true,
            },
          ],
        },
        meta: { availability: "available", source: "codex" },
      },
    });
  });
  await page.route("**/api/v1/environments/**/audit**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor) {
      await route.fulfill({
        json: {
          data: {
            ...mockEnvironmentAudit,
            events: [],
            nextCursor: undefined,
          },
        },
      });
      return;
    }
    await auditResponseGate;
    await route.fulfill({ json: { data: mockEnvironmentAudit } });
  });

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await expect(page.getByText("The release is valid.")).toBeVisible();
  await expect.poll(() => auditRequests).toBe(0);
  await page.getByRole("button", { name: "Open inspector" }).click();
  const inspectorViews = page.getByRole("navigation", {
    name: "Inspector views",
  });
  await expect(
    inspectorViews.getByRole("button", { name: "Audit", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Inspector views" })
    .getByRole("button", { name: "Activity", exact: true })
    .click();

  const activityView = page.getByLabel("Codex Session Activity", {
    exact: true,
  });
  const activityHeading = activityView.getByRole("heading", {
    name: "Codex Session Activity",
  });
  const activityFilter = activityView.getByRole("combobox", {
    name: "Filter Codex Session Activity",
  });
  await expect(
    activityHeading,
  ).toBeVisible();
  await expect(activityFilter).toBeVisible();
  const [activityHeadingBox, activityFilterBox] = await Promise.all([
    activityHeading.boundingBox(),
    activityFilter.boundingBox(),
  ]);
  expect(activityHeadingBox).not.toBeNull();
  expect(activityFilterBox).not.toBeNull();
  expect(activityFilterBox!.y).toBeLessThan(activityHeadingBox!.y);
  await expect(
    activityView.getByText(
      "Attributed by native Thread and Turn IDs.",
      { exact: false },
    ),
  ).toHaveCount(0);
  await expect(
    activityView.getByRole("heading", {
      name: "Check the release and repository.",
    }),
  ).toBeVisible();
  await expect(
    activityView.getByText(nativeThreadId, { exact: false }),
  ).toBeHidden();
  await activityView
    .locator(".codex-session-activity-boundary summary")
    .click();
  await expect(
    activityView.getByText(nativeThreadId, { exact: false }),
  ).toBeVisible();
  await expect(
    activityView.locator(".codex-session-activity-intro"),
  ).toContainText("3 actions · 5 native records");
  await expect(
    activityView.locator(".codex-session-activity-turn > header"),
  ).toContainText("3 actions · 5 records");
  const commandActivity = activityView
    .locator(".codex-compact-activity")
    .filter({ hasText: "git status --short" });
  await expect(commandActivity).toBeVisible();
  await expect(commandActivity.locator(":scope > summary")).toHaveAccessibleName(
    /Ran.*git status --short.*1 update/,
  );
  await expect(commandActivity).not.toContainText(
    "call-e2e-rollout-exec",
  );
  await commandActivity.locator(":scope > summary").click();
  await expect(commandActivity).toContainText("1 update");
  await commandActivity
    .locator(".codex-native-tool-details > summary")
    .click();
  await expect(
    commandActivity.locator(".codex-native-tool-details pre").first(),
  ).toHaveAttribute("tabindex", "0");
  await expect(commandActivity).toContainText("call-e2e-rollout-exec");
  await expect(commandActivity).toContainText("Script completed");
  const mcpActivity = activityView
    .locator(".codex-native-tool")
    .filter({ hasText: "GitHub · get_release" });
  await expect(mcpActivity).toBeVisible();
  await expect(mcpActivity.locator(":scope > summary")).toHaveAccessibleName(
    /Called.*GitHub.*get_release.*External/,
  );
  await mcpActivity.locator(":scope > summary").click();
  await mcpActivity.locator(".codex-native-tool-details > summary").click();
  await expect(mcpActivity).toContainText('"repo": "sandpi"');

  await activityFilter.selectOption("external");
  await expect(commandActivity).toBeHidden();
  await expect(mcpActivity).toBeVisible();
  await expect(activityView.getByText("sandpi v1.2.3")).toBeVisible();
  await expect.poll(() => auditRequests).toBe(0);

  const auditRequest = page.waitForRequest((candidate) => {
    const requestUrl = new URL(candidate.url());
    return (
      candidate.method() === "GET" &&
      requestUrl.pathname ===
        `/api/v1/environments/${encodeURIComponent(environment.id)}/audit`
    );
  });
  await activityView
    .getByRole("button", { name: "Open Environment Audit" })
    .click();
  await auditRequest;

  const settingsDialog = page.getByRole("dialog", {
    name: `${environment.name} settings`,
  });
  await expect(settingsDialog).toBeVisible();
  await expect(
    settingsDialog.getByRole("heading", { name: "Environment audit" }),
  ).toBeVisible();
  await expect(
    settingsDialog.locator(".settings-nav button.is-active"),
  ).toHaveText("Audit");
  await expect(
    settingsDialog.getByRole("status").getByText("Loading Environment audit…"),
  ).toBeVisible();
  releaseAuditResponse();
  await expect(
    settingsDialog.getByRole("region", { name: "Environment audit" }),
  ).toBeVisible();
  const auditRegion = settingsDialog.getByRole("region", {
    name: "Environment audit",
  });
  await expect(auditRegion).toContainText(
    "8 signed records · 4 operations · 1 issue",
  );
  await expect(auditRegion).toContainText(
    "Earliest loaded range; newer records are available",
  );
  await expect(
    auditRegion.getByText("All 8 loaded records are verified"),
  ).toBeVisible();
  await expect(
    auditRegion.locator(".audit-technical-content pre"),
  ).toHaveCount(0);

  const firstAuditActivity = auditRegion.locator(".audit-activity").first();
  await expect(firstAuditActivity).toContainText(
    "Blocked connection to telemetry.example.dev:443",
  );
  await firstAuditActivity.locator(":scope > summary").click();
  await expect(
    firstAuditActivity.locator(".audit-activity-facts"),
  ).toBeVisible();
  await expect(
    firstAuditActivity.locator(".audit-technical-content pre"),
  ).toHaveCount(0);
  await firstAuditActivity
    .locator(".audit-technical-details > summary")
    .first()
    .click();
  const signedEventJson = firstAuditActivity
    .locator(".audit-technical-content pre")
    .first();
  await expect(signedEventJson).toBeVisible();
  await expect(signedEventJson).toHaveAttribute("tabindex", "0");
  await expect(signedEventJson).toContainText(
    "55555555-5555-4555-8555-555555555555",
  );

  await auditRegion
    .getByRole("combobox", { name: "Filter loaded Environment audit" })
    .selectOption("attention");
  await expect(auditRegion.locator(".audit-activity-item")).toHaveCount(1);

  const auditRequestsBeforePagination = auditRequests;
  await auditRegion
    .getByRole("button", { name: "Load newer signed records" })
    .click();
  await expect
    .poll(() => auditCursors)
    .toEqual(["mock-history-cursor"]);
  await expect(
    auditRegion.getByRole("button", { name: "Load newer signed records" }),
  ).toHaveCount(0);
  await expect(auditRegion).toContainText(
    "8 signed records · 4 operations · 1 issue",
  );
  await expect(auditRegion).toContainText("All available records loaded");
  await expect
    .poll(() => auditRequests)
    .toBe(auditRequestsBeforePagination + 1);
  await expect(
    settingsDialog.getByText("Environment audit records are read-only."),
  ).toBeVisible();
  await expect(page.getByText("Session audit")).toHaveCount(0);

  await settingsDialog.getByRole("button", { name: "Done" }).click();
  await expect(settingsDialog).toBeHidden();
  await expect
    .poll(() => environmentUpdates)
    .toBe(0);
  expect(browserErrors).toEqual([]);
});

test("opens nested Agent file links and restores the selected file", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  test.skip(session.harness !== "codex", "A Codex Session is required.");
  const now = Date.now() / 1_000;
  const nativeThreadId = "thread-e2e-workspace-links";
  const nativeTurnId = "turn-e2e-workspace-links";
  const globalsPath = "/workspace/app/globals.css";
  const pagePath = "/workspace/app/page.tsx";
  const directoryRequests: string[] = [];
  const fileRequests: string[] = [];
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const nativeSnapshot: CodexNativeSnapshot = {
    protocol: "codex-app-server",
    nativeSessionId: nativeThreadId,
    historyRevision: 1,
    modelId: "e2e-workspace-links-model",
    sessionStatus: "waiting",
    forkableTurnIds: [nativeTurnId],
    activity: {
      source: "codex-rollout",
      availability: "available",
      error: null,
      records: [],
    },
    thread: {
      id: nativeThreadId,
      createdAt: now - 5,
      updatedAt: now,
      status: { type: "idle" },
      turns: [
        {
          id: nativeTurnId,
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: now - 5,
          completedAt: now,
          durationMs: 5_000,
          items: [
            {
              type: "userMessage",
              id: "workspace-links-user",
              clientId: null,
              content: [
                {
                  type: "text",
                  text: "Create the app files.",
                  text_elements: [],
                },
              ],
            },
            {
              type: "agentMessage",
              id: "workspace-links-agent",
              text:
                `Open [globals.css](${globalsPath}) or ` +
                `[page.tsx](${pagePath}).`,
              phase: "final_answer",
              memoryCitation: null,
            },
          ],
        },
      ],
    },
  };
  const ideSnapshot: WorkspaceIdeSnapshot = {
    refreshedAt: now,
    files: [
      {
        id: "workspace",
        name: "workspace",
        path: "/workspace",
        kind: "folder",
        children: [
          {
            id: "app",
            name: "app",
            path: "/workspace/app",
            kind: "folder",
          },
        ],
      },
    ],
    git: { repositories: [] },
  };
  const files = new Map<string, WorkspaceIdeFile>([
    [
      globalsPath,
      {
        path: globalsPath,
        name: "globals.css",
        revision: `sha256:${"e".repeat(43)}`,
        encoding: "base64",
        content: Buffer.from("body { color: tomato; }\n").toString("base64"),
        kind: "text",
        editable: true,
        size: "24 B",
        modifiedAt: now,
        lineChanges: [],
      },
    ],
    [
      pagePath,
      {
        path: pagePath,
        name: "page.tsx",
        revision: `sha256:${"f".repeat(43)}`,
        encoding: "base64",
        content: Buffer.from(
          "export default function Page() { return <main>Hello</main>; }\n",
        ).toString("base64"),
        kind: "text",
        editable: true,
        size: "63 B",
        modifiedAt: now,
        lineChanges: [],
      },
    ],
  ]);

  await page.route("**/api/v1/sessions/**/events", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: `event: snapshot\ndata: ${JSON.stringify(nativeSnapshot)}\n\n`,
    });
  });
  await page.route("**/api/v1/sessions/**/models", async (route) => {
    await route.fulfill({
      json: {
        data: {
          data: [
            {
              id: nativeSnapshot.modelId,
              displayName: "E2E workspace links model",
              isDefault: true,
            },
          ],
        },
        meta: { availability: "available", source: "codex" },
      },
    });
  });
  await page.route("**/api/v1/environments/**/ide/file?*", async (route) => {
    const filePath = new URL(route.request().url()).searchParams.get("path");
    if (!filePath || !files.has(filePath)) {
      await route.fulfill({
        status: 404,
        json: {
          error: {
            code: "workspace_file_not_found",
            message: "File not found.",
          },
        },
      });
      return;
    }
    fileRequests.push(filePath);
    await route.fulfill({ json: { data: files.get(filePath) } });
  });
  await page.route("**/api/v1/environments/**/files?*", async (route) => {
    const directoryPath = new URL(route.request().url()).searchParams.get(
      "path",
    );
    if (directoryPath) directoryRequests.push(directoryPath);
    const listing: WorkspaceDirectoryListing = {
      path: "/workspace/app",
      refreshedAt: now,
      entries: [...files.values()].map((file) => ({
        id: file.name,
        name: file.name,
        path: file.path,
        kind: "file",
        size: file.size,
        modifiedAt: file.modifiedAt,
      })),
    };
    await route.fulfill({ json: { data: listing } });
  });
  await page.route("**/api/v1/environments/**/ide", async (route) => {
    await route.fulfill({ json: { data: ideSnapshot } });
  });
  await page.routeWebSocket(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/ide/events`,
    (socket) => {
      socket.send(JSON.stringify({ type: "ready", at: now }));
    },
  );

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await expect(page.getByText("Loading conversation…")).toBeHidden();

  await page.locator(`[data-workspace-path="${globalsPath}"]`).click();
  const inspectorViews = page.getByRole("navigation", {
    name: "Inspector views",
  });
  const openFiles = page.getByRole("tablist", { name: "Open files" });
  const workspaceTree = page.getByRole("complementary", {
    name: "Workspace files",
  });
  const globalsTab = openFiles.getByRole("tab", { name: /globals\.css/ });
  await expect(inspectorViews).toBeVisible();
  await expect(globalsTab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText("workspace / app/globals.css", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("globals.css", { exact: true })).toBeVisible();
  await expect(
    workspaceTree.locator(`button[title="${globalsPath}"]`),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    workspaceTree.locator('button[title="/workspace/app"]'),
  ).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("path"))
    .toBe(globalsPath);
  await expect.poll(() => directoryRequests).toContain("/workspace/app");
  await expect.poll(() => fileRequests).toContain(globalsPath);

  await page.locator(`[data-workspace-path="${pagePath}"]`).click();
  const pageTab = openFiles.getByRole("tab", { name: /page\.tsx/ });
  await expect(pageTab).toHaveAttribute("aria-selected", "true");
  await expect(globalsTab).toHaveAttribute("aria-selected", "false");
  await expect(openFiles.getByRole("tab")).toHaveCount(2);
  await expect(
    page.getByText("workspace / app/page.tsx", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("page.tsx", { exact: true })).toBeVisible();
  await expect(
    workspaceTree.locator(`button[title="${pagePath}"]`),
  ).toHaveAttribute("aria-current", "page");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("path"))
    .toBe(pagePath);
  await expect.poll(() => fileRequests).toContain(pagePath);
  expect(new Set(directoryRequests)).toEqual(new Set(["/workspace/app"]));

  await inspectorViews
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  await inspectorViews
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await expect(
    page.getByRole("tablist", { name: "Open files" }).getByRole("tab", {
      name: /page\.tsx/,
    }),
  ).toHaveAttribute("aria-selected", "true");

  await page.reload();
  await expect(page.getByText("Loading conversation…")).toBeHidden();
  await expect(
    page.getByRole("navigation", { name: "Inspector views" }),
  ).toBeVisible();
  await expect(
    page.getByRole("tablist", { name: "Open files" }).getByRole("tab", {
      name: /page\.tsx/,
    }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page
      .getByRole("complementary", { name: "Workspace files" })
      .locator(`button[title="${pagePath}"]`),
  ).toHaveAttribute("aria-current", "page");
  expect(browserErrors).toEqual([]);
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

test("opens the Environment terminal from New Session and replays only the last three commands", async ({
  page,
  request,
}) => {
  const environment = await readyEnvironment(request);
  test.skip(!environment, "A ready Environment is required for this check.");
  if (!environment) return;
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
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&new=1`,
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

test("stops retrying a structured terminal failure until the user asks", async ({
  page,
  request,
}) => {
  const environment = await readyEnvironment(request);
  test.skip(!environment, "A ready Environment is required for this check.");
  if (!environment) return;
  let connections = 0;

  await page.routeWebSocket(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/terminal`,
    async (socket) => {
      connections += 1;
      socket.send(
        JSON.stringify({
          type: "error",
          code: "sandbox0_unauthorized",
          error: "Unauthorized",
        }),
      );
      await socket.close({ code: 1008, reason: "Terminal connection failed" });
    },
  );

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  await page.getByRole("button", { name: "Terminal" }).click();
  const terminal = page.getByRole("region", {
    name: `Terminal for ${environment.name}`,
  });
  await expect(terminal.getByText("Unauthorized", { exact: true })).toBeVisible();
  await expect(terminal.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(connections).toBe(1);

  await terminal.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => connections).toBe(2);
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
    if (/\/sessions\/[^/]+\/events$/.test(path)) {
      // This test exercises shared Inspector loading, not native history
      // authorization. Keep the unrelated EventSource healthy and let the
      // dedicated Codex streaming tests own its behavior.
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": inspector fixture\n\n",
      });
      return;
    }
    if (/\/(ide|metrics)$/.test(path)) {
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
  await page.routeWebSocket(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/ide/events`,
    (socket) => {
      socket.send(JSON.stringify({ type: "ready", at: now }));
    },
  );

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
  await expect.poll(() => directoryLoads).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  const directoryLoadsBeforeToggle = directoryLoads;
  await sourceFolder.click();
  await sourceFolder.click();
  await page.waitForTimeout(200);
  expect(directoryLoads).toBe(directoryLoadsBeforeToggle);
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
  await expect(save).toBeEnabled();
  // Use the editor's real keyboard save path here. The conflict response
  // disables the button synchronously, which can make Playwright retry a
  // locator click even though the first click already reached the server.
  await page.keyboard.press("Control+S");
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

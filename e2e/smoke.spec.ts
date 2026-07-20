import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";

import type { ApiEnvelope } from "../src/lib/api-client";
import type {
  Environment,
  SandpiBootstrap,
  WorkspaceDirectoryListing,
  WorkspaceIdeFile,
  WorkspaceIdeSnapshot,
} from "../src/lib/types";
import type {
  CodexEventEnvelope,
  CodexNativeSnapshot,
  CodexThreadItem,
  CodexTurn,
} from "../src/harnesses/codex/types";
import {
  mockEnvironmentAudit,
  mockEnvironmentMetrics,
} from "../src/lib/mock-data";

interface ControlledEventWindow extends Window {
  __sandpiEmitEvent?: (
    urlIncludes: string,
    type: string,
    payload: unknown,
  ) => boolean;
}

async function installControlledEventSource(page: Page) {
  await page.addInitScript(() => {
    class ControlledEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;

      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials: boolean;
      readyState = 1;

      constructor(url: string | URL, init?: EventSourceInit) {
        super();
        this.url = String(url);
        this.withCredentials = init?.withCredentials ?? false;
        sources.push(this);
      }

      close() {
        this.readyState = ControlledEventSource.CLOSED;
      }
    }

    const sources: ControlledEventSource[] = [];
    const host = window as ControlledEventWindow;
    host.__sandpiEmitEvent = (urlIncludes, type, payload) => {
      const source = sources.findLast(
        (candidate) =>
          candidate.readyState === ControlledEventSource.OPEN &&
          candidate.url.includes(urlIncludes),
      );
      if (!source) return false;
      source.dispatchEvent(
        new MessageEvent(type, { data: JSON.stringify(payload) }),
      );
      return true;
    };
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: ControlledEventSource,
    });
  });
}

async function emitControlledEvent(
  page: Page,
  urlIncludes: string,
  type: string,
  payload: unknown,
) {
  await expect
    .poll(() =>
      page.evaluate(
        ({ urlIncludes, type, payload }) =>
          (window as ControlledEventWindow).__sandpiEmitEvent?.(
            urlIncludes,
            type,
            payload,
          ) ?? false,
        { urlIncludes, type, payload },
      ),
    )
    .toBe(true);
}

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
  const session = bootstrap.data.sessions.find(
    (candidate) => !candidate.archived,
  );
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
  await expect(newSessionHeading).toBeVisible();
  await expect(
    page.getByText("Development", { exact: true }).first(),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Development settings" })
    .last()
    .click();
  await page.getByRole("button", { name: /Coding agent/ }).click();
  const settingsLayout = await page
    .locator(".settings-content")
    .evaluate((content) => {
      const section = content.querySelector<HTMLElement>(".settings-section");
      const body = content.querySelector<HTMLElement>(".settings-section-body");
      if (!section || !body)
        throw new Error("Environment settings layout missing");
      const sectionStyle = window.getComputedStyle(section);
      return {
        contentWidth: content.getBoundingClientRect().width,
        bodyWidth: body.getBoundingClientRect().width,
        paddingInline:
          Number.parseFloat(sectionStyle.paddingLeft) +
          Number.parseFloat(sectionStyle.paddingRight),
        bodyOverflow: body.scrollWidth - body.clientWidth,
      };
    });
  expect(settingsLayout.paddingInline).toBeLessThanOrEqual(64);
  expect(
    settingsLayout.bodyWidth / settingsLayout.contentWidth,
  ).toBeGreaterThan(0.88);
  expect(settingsLayout.bodyOverflow).toBe(0);
  await expect(
    page.locator(".credential-row").getByText(/Connected|Not connected/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^(Connect|Re-authenticate) Codex$/ }),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("waits for native New Session models and scopes reasoning effort by model", async ({
  page,
  request,
}) => {
  const environment = await readyEnvironment(request);
  test.skip(
    !environment || environment.codingAgent.status !== "connected",
    "A ready Environment with Codex connected is required for this check.",
  );
  if (!environment || environment.codingAgent.status !== "connected") return;

  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  let releaseCatalog!: () => void;
  let createSessionBody: Record<string, unknown> | undefined;
  let uploadBody: Record<string, unknown> | undefined;
  const catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route("**/api/v1/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createSessionBody = route.request().postDataJSON() as Record<
      string,
      unknown
    >;
    await route.fulfill({
      // Stop after inspecting the request without creating a real Session or
      // turning the intentional interception into a browser network error.
      status: 204,
    });
  });
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/models`,
    async (route) => {
      await catalogGate;
      await route.fulfill({
        json: {
          data: {
            data: [
              {
                id: "e2e-codex-fast",
                displayName: "E2E Codex Fast",
                isDefault: true,
                defaultReasoningEffort: "high",
                supportedReasoningEfforts: [
                  {
                    reasoningEffort: "low",
                    description: "Faster answers",
                  },
                  {
                    reasoningEffort: "high",
                    description: "Deeper reasoning",
                  },
                ],
              },
              {
                id: "e2e-codex-deep",
                displayName: "E2E Codex Deep",
                isDefault: false,
                defaultReasoningEffort: "max",
                supportedReasoningEfforts: [
                  {
                    reasoningEffort: "medium",
                    description: "Balanced reasoning",
                  },
                  {
                    reasoningEffort: "max",
                    description: "Maximum reasoning",
                  },
                ],
              },
            ],
          },
          meta: { availability: "available", source: "codex" },
        },
      });
    },
  );
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/uploads`,
    async (route) => {
      uploadBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        json: {
          data: {
            id: "upload:e2e-requirements",
            name: "requirements.pdf",
            path: "/workspace/.sandpi/uploads/e2e-requirements/requirements.pdf",
            mimeType: "application/pdf",
            sizeBytes: 13,
            kind: "mention",
            source: "upload",
          },
        },
      });
    },
  );
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/files/search?*`,
    async (route) => {
      expect(new URL(route.request().url()).searchParams.get("query")).toBe(
        "README",
      );
      await route.fulfill({
        json: {
          data: [
            {
              name: "README.md",
              path: "/workspace/README.md",
              kind: "file",
            },
          ],
          meta: { source: "sandbox0", root: "/workspace" },
        },
      });
    },
  );

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  const modelPicker = page.getByRole("combobox", {
    name: `Select ${environment.codingAgent.label} model`,
  });
  await expect(modelPicker).toBeDisabled();
  await expect(modelPicker).toContainText(
    `Starting ${environment.codingAgent.label}…`,
  );
  await expect(
    page.getByRole("status").filter({
      hasText: `Starting ${environment.codingAgent.label}…`,
    }),
  ).toBeVisible();
  await expect(modelPicker.locator("option")).not.toContainText(
    `${environment.codingAgent.label} default`,
  );

  releaseCatalog();
  await expect(modelPicker).toBeEnabled();
  await expect(modelPicker).toHaveValue("e2e-codex-fast");
  const fastEffortPicker = page.getByRole("combobox", {
    name: "Select reasoning effort for E2E Codex Fast",
  });
  await expect(fastEffortPicker).toHaveValue("high");
  await expect(fastEffortPicker.locator("option")).toHaveText(["Low", "High"]);

  await page.getByTestId("codex-composer-upload-input").setInputFiles({
    name: "requirements.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-e2e-test"),
  });
  await expect(
    page.getByText("requirements.pdf", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => uploadBody)
    .toMatchObject({
      name: "requirements.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-e2e-test").toString("base64"),
    });
  await page.getByRole("button", { name: "Mention a Workspace file" }).click();
  await page.getByPlaceholder("Search /workspace").fill("README");
  await page.getByRole("option").filter({ hasText: "README.md" }).click();
  await expect(
    page.locator(".composer-file-reference").filter({ hasText: "README.md" }),
  ).toBeVisible();

  await modelPicker.selectOption("e2e-codex-deep");
  const deepEffortPicker = page.getByRole("combobox", {
    name: "Select reasoning effort for E2E Codex Deep",
  });
  await expect(deepEffortPicker).toHaveValue("max");
  await expect(deepEffortPicker.locator("option")).toHaveText([
    "Medium",
    "Max",
  ]);
  await deepEffortPicker.selectOption("medium");
  await modelPicker.selectOption("e2e-codex-fast");
  await expect(fastEffortPicker).toHaveValue("high");
  await modelPicker.selectOption("e2e-codex-deep");
  await expect(deepEffortPicker).toHaveValue("medium");
  await page
    .getByPlaceholder(
      `Ask ${environment.codingAgent.label} to work on something…`,
    )
    .fill("Verify native model settings.");
  await page
    .getByRole("button", {
      name: "Send instruction and start Session",
    })
    .click();
  await expect
    .poll(() => createSessionBody)
    .toMatchObject({
      environmentId: environment.id,
      modelId: "e2e-codex-deep",
      reasoningEffort: "medium",
      references: [
        {
          name: "requirements.pdf",
          path: "/workspace/.sandpi/uploads/e2e-requirements/requirements.pdf",
          kind: "mention",
        },
        {
          name: "README.md",
          path: "/workspace/README.md",
          kind: "mention",
        },
      ],
    });
  await page.reload();
  await expect(modelPicker).toBeEnabled();
  await expect(modelPicker).toHaveValue("e2e-codex-deep");
  await expect(
    page.getByRole("combobox", {
      name: "Select reasoning effort for E2E Codex Deep",
    }),
  ).toHaveValue("medium");
  expect(browserErrors).toEqual([]);
});

test("refreshes the Codex account and live limits after device login", async ({
  page,
  request,
}) => {
  const environment = await readyEnvironment(request);
  test.skip(!environment, "A ready Environment is required for this check.");
  if (!environment) return;

  const disconnectedEnvironment = {
    ...environment,
    credentialRevision: 0,
    codingAgent: {
      ...environment.codingAgent,
      status: "not-connected" as const,
      account: undefined,
      lastVerified: undefined,
    },
  };
  const connectedEnvironment = {
    ...environment,
    credentialRevision: 1,
    codingAgent: {
      ...environment.codingAgent,
      status: "connected" as const,
      account: "codex-user@example.com",
      lastVerified: 1_800_000_000,
    },
  };
  let loginStarted = false;
  let loginCompleted = false;
  let completedEnvironmentRefreshes = 0;

  await page.route("**/api/v1/bootstrap**", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
    body.data.environments = body.data.environments.map((candidate) =>
      candidate.id === environment.id ? disconnectedEnvironment : candidate,
    );
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/v1\/environments(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as ApiEnvelope<Environment[]>;
    body.data = body.data.map((candidate) =>
      candidate.id === environment.id
        ? loginCompleted
          ? connectedEnvironment
          : disconnectedEnvironment
        : candidate,
    );
    if (loginCompleted) completedEnvironmentRefreshes += 1;
    await route.fulfill({ response, json: body });
  });
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/device-login**`,
    async (route) => {
      const requestUrl = new URL(route.request().url());
      const basePath =
        `/api/v1/environments/${encodeURIComponent(environment.id)}` +
        "/harnesses/codex/device-login";
      if (
        requestUrl.pathname === basePath &&
        route.request().method() === "GET"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: loginStarted
              ? {
                  id: "codex-auth-test",
                  environmentId: environment.id,
                  status: "awaiting_user",
                  verificationUrl: "https://auth.openai.com/device",
                  userCode: "TEST-CODE",
                  expiresAt: 1_900_000_000,
                }
              : null,
          }),
        });
        return;
      }
      if (
        requestUrl.pathname === basePath &&
        route.request().method() === "POST"
      ) {
        loginStarted = true;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              id: "codex-auth-test",
              environmentId: environment.id,
              status: "awaiting_user",
              verificationUrl: "https://auth.openai.com/device",
              userCode: "TEST-CODE",
              expiresAt: 1_900_000_000,
            },
          }),
        });
        return;
      }
      loginCompleted = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "codex-auth-test",
            environmentId: environment.id,
            status: "completed",
            expiresAt: 1_900_000_000,
          },
        }),
      });
    },
  );
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/account`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: loginCompleted
            ? {
                type: "chatgpt",
                email: "codex-user@example.com",
                planType: "pro",
                lastVerified: 1_800_000_000,
              }
            : null,
        }),
      });
    },
  );
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/rate-limits`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            fetchedAt: 1_800_000_100,
            limits: [
              {
                id: "codex",
                name: "Codex",
                planType: "pro",
                primary: {
                  usedPercent: 42,
                  windowDurationMins: 300,
                  resetsAt: 1_800_010_000,
                },
                secondary: {
                  usedPercent: 5,
                  windowDurationMins: 10_080,
                  resetsAt: 1_800_500_000,
                },
                reached: false,
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
  await settingsDialog.getByRole("button", { name: "Coding agent" }).click();
  await settingsDialog.getByRole("button", { name: "Connect Codex" }).click();

  await expect(
    settingsDialog
      .locator(".codex-account-identity")
      .getByText("codex-user@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    settingsDialog.locator(".codex-account-identity").getByText("Pro", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    settingsDialog.getByRole("progressbar", {
      name: "Codex 5-hour window",
    }),
  ).toHaveAttribute("aria-valuenow", "42");
  await expect(settingsDialog.getByText("58% remaining")).toBeVisible();
  await expect(settingsDialog.getByText("95% remaining")).toBeVisible();
  await expect(
    settingsDialog.getByRole("button", { name: "Re-authenticate Codex" }),
  ).toBeVisible();
  expect(completedEnvironmentRefreshes).toBeGreaterThan(0);
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
  await expect(
    settingsDialog.getByRole("button", { name: "Functions", exact: true }),
  ).toHaveCount(0);
  await expect(
    settingsDialog.getByRole("button", { name: "Sharing", exact: true }),
  ).toHaveCount(0);
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
  await expect(
    settingsDialog.getByLabel("Server URL", { exact: true }),
  ).toHaveValue("https://connector.oomol.com/v1/mcp");
  await settingsDialog.getByRole("button", { name: "Cancel" }).click();

  await settingsDialog
    .getByRole("button", { name: "Configure Playwright" })
    .click();
  await expect(
    settingsDialog.getByText("Playwright", { exact: true }),
  ).toBeInViewport();
  await expect(
    settingsDialog.getByText(/Trusted code: runs beside Codex/),
  ).toBeInViewport();
  await expect(settingsDialog.getByLabel("Name")).toHaveValue("playwright");
  await expect(settingsDialog.getByLabel("Transport")).toHaveValue("stdio");
  await expect(settingsDialog.getByLabel("Command")).toHaveValue("npx");
  await expect(settingsDialog.getByLabel(/Arguments/)).toHaveValue(
    "-y\n@playwright/mcp@0.0.78\n--headless\n--no-sandbox",
  );

  await settingsDialog.getByRole("button", { name: "Cancel" }).click();
  await settingsDialog
    .getByRole("button", { name: "Configure Context7" })
    .click();
  await expect(settingsDialog.getByLabel("Name")).toHaveValue("context7");
  await expect(settingsDialog.getByLabel("Transport")).toHaveValue(
    "streamable-http",
  );
  await expect(
    settingsDialog.getByLabel("Server URL", { exact: true }),
  ).toHaveValue("https://mcp.context7.com/mcp");
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
  await expect(
    settingsDialog.getByText("github.com", { exact: true }),
  ).toBeVisible();

  await settingsDialog.getByText("Allow by default", { exact: true }).click();
  await expect(
    settingsDialog.getByRole("alert").getByText("Clear 1 allowed domain?"),
  ).toBeVisible();
  await settingsDialog
    .getByRole("button", { name: "Keep current mode" })
    .click();
  await expect(blockByDefault).toBeChecked();
  await expect(
    settingsDialog.getByText("github.com", { exact: true }),
  ).toBeVisible();

  await settingsDialog.getByText("Allow by default", { exact: true }).click();
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

  const confirmation = page.getByLabel(`Type ${environment.name} to confirm`);
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
  await expect.poll(() => deleteCalls).toBe(1);
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
  await expect(
    page.getByRole("heading", { name: "Preferences" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Environment and coding agent settings live with each Environment.",
    ),
  ).toBeVisible();

  await page.goto("/team");
  await expect(page).toHaveURL(/\/team\/?$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Sandpi", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Sandpi control plane", { exact: true }),
  ).toBeVisible();
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
  await expect(
    activityView.getByRole("alert").getByText(message),
  ).toBeVisible();
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
    page
      .getByRole("alert")
      .getByText(
        "The Codex event stream could not be opened. Check the Sandpi server connection and deployment configuration.",
      ),
  ).toBeVisible();
  await expect(page.getByText("Loading conversation…")).toBeHidden();
});

test("keeps an optimistic prompt ahead of native Activity without duplicating it", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const eventPath = `/api/v1/sessions/${session.id}/events`;
  const nativeThreadId = "thread-e2e-optimistic-order";
  const nativeTurnId = "turn-e2e-optimistic-order";
  const prompt = "Keep this prompt ahead of its Activity.";
  const now = Date.now() / 1_000;
  const snapshot: CodexNativeSnapshot = {
    protocol: "codex-app-server",
    nativeSessionId: nativeThreadId,
    historyRevision: 1,
    modelId: "e2e-order-model",
    reasoningEffort: "high",
    sessionStatus: "waiting",
    forkableTurnIds: [],
    activity: {
      source: "codex-rollout",
      availability: "available",
      error: null,
      records: [],
    },
    thread: {
      id: nativeThreadId,
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      turns: [],
    },
  };
  let turnRequestBody:
    | {
        clientMessageId?: string;
        references?: Array<{
          name: string;
          path: string;
          kind: string;
        }>;
      }
    | undefined;
  let releaseTurnResponse!: () => void;
  const turnResponseGate = new Promise<void>((resolve) => {
    releaseTurnResponse = resolve;
  });

  await installControlledEventSource(page);
  await page.route("**/api/v1/sessions/**/models", async (route) => {
    await route.fulfill({
      json: {
        data: {
          data: [
            {
              id: snapshot.modelId,
              displayName: "E2E order model",
              isDefault: true,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                {
                  reasoningEffort: "high",
                  description: "Deep reasoning",
                },
              ],
            },
          ],
        },
        meta: { availability: "available", source: "codex" },
      },
    });
  });
  await page.route(
    `**/api/v1/sessions/${encodeURIComponent(session.id)}/turns`,
    async (route) => {
      turnRequestBody = route.request().postDataJSON() as {
        clientMessageId?: string;
        references?: Array<{
          name: string;
          path: string;
          kind: string;
        }>;
      };
      await turnResponseGate;
      await route.fulfill({
        status: 202,
        json: {
          data: {
            requestId: "turn-start:e2e-order",
            clientMessageId: turnRequestBody.clientMessageId,
            nativeTurnId,
          },
        },
      });
    },
  );
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/files/search?*`,
    async (route) => {
      await route.fulfill({
        json: {
          data: [
            {
              name: "page.tsx",
              path: "/workspace/app/page.tsx",
              kind: "file",
            },
          ],
          meta: { source: "sandbox0", root: "/workspace" },
        },
      });
    },
  );

  await page.goto(
    `/?team=${encodeURIComponent(environment.teamId)}&environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await emitControlledEvent(page, eventPath, "snapshot", snapshot);
  await expect(page.getByText("Loading conversation…")).toBeHidden();

  const composer = page.getByRole("textbox", {
    name: `Message ${environment.codingAgent.label}`,
  });
  await expect(page.getByTestId("codex-composer-upload-input")).toHaveCount(1);
  await page.getByRole("button", { name: "Mention a Workspace file" }).click();
  await page.getByPlaceholder("Search /workspace").fill("page");
  await page.getByRole("option").filter({ hasText: "app/page.tsx" }).click();
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect
    .poll(() => turnRequestBody?.clientMessageId)
    .toMatch(/^user-message-/);
  const clientMessageId = turnRequestBody?.clientMessageId;
  expect(clientMessageId).toBeTruthy();
  expect(turnRequestBody?.references).toEqual([
    {
      name: "page.tsx",
      path: "/workspace/app/page.tsx",
      kind: "mention",
    },
  ]);
  await expect(composer).toHaveValue("");
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Starting Codex turn" }),
  ).toHaveAttribute("aria-busy", "true");

  const userRow = page.locator(".message-column > .message-user");
  const activityRow = page.locator(
    ".message-column > .message-codex-turn-activity",
  );
  await expect(userRow).toHaveCount(1);
  await expect(activityRow).toHaveCount(1);
  const initialOrder = await Promise.all([
    userRow.boundingBox(),
    activityRow.boundingBox(),
  ]);
  expect(initialOrder[0]).not.toBeNull();
  expect(initialOrder[1]).not.toBeNull();
  expect(initialOrder[0]!.y).toBeLessThan(initialOrder[1]!.y);

  const runningTurn: CodexTurn = {
    id: nativeTurnId,
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: now,
    completedAt: null,
    durationMs: null,
  };
  const nativeUserMessage: CodexThreadItem = {
    type: "userMessage",
    id: "native-user-e2e-order",
    clientId: clientMessageId!,
    content: [
      { type: "text", text: prompt, text_elements: [] },
      {
        type: "mention",
        name: "page.tsx",
        path: "/workspace/app/page.tsx",
      },
    ],
  };
  const runningCommand: CodexThreadItem = {
    type: "commandExecution",
    id: "native-command-e2e-order",
    command: "rg --files",
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status: "inProgress",
    commandActions: [
      { type: "listFiles", command: "rg --files", path: "/workspace" },
    ],
    aggregatedOutput: "app/page.tsx\n",
    exitCode: null,
    durationMs: null,
  };
  let sequence = 1;
  const envelope = (
    notification: CodexEventEnvelope["notification"],
  ): CodexEventEnvelope => ({
    harness: "codex",
    harnessVersion: "e2e",
    protocolVersion: "v2",
    sequence: sequence++,
    receivedAt: now + sequence,
    notification,
  });

  await emitControlledEvent(
    page,
    eventPath,
    "notification",
    envelope({
      method: "turn/started",
      params: { threadId: nativeThreadId, turn: runningTurn },
    }),
  );
  await emitControlledEvent(
    page,
    eventPath,
    "notification",
    envelope({
      method: "item/started",
      params: {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        item: nativeUserMessage,
        startedAtMs: now * 1_000,
      },
    }),
  );
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
  releaseTurnResponse();
  await emitControlledEvent(
    page,
    eventPath,
    "notification",
    envelope({
      method: "item/started",
      params: {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        item: runningCommand,
        startedAtMs: now * 1_000 + 100,
      },
    }),
  );
  const activityDetails = activityRow.locator(":scope > details");
  await expect(activityDetails).toHaveAttribute("open", "");
  const runningActivityHeight = await activityDetails.evaluate(
    (details) => details.getBoundingClientRect().height,
  );
  expect(runningActivityHeight).toBeGreaterThan(40);

  const completedCommand: CodexThreadItem = {
    ...runningCommand,
    status: "completed",
    exitCode: 0,
    durationMs: 250,
  };
  const finalMessage: CodexThreadItem = {
    type: "agentMessage",
    id: "native-final-e2e-order",
    text: "The ordering is stable.",
    phase: "final_answer",
    memoryCitation: null,
  };
  const completedTurn: CodexTurn = {
    ...runningTurn,
    items: [nativeUserMessage, completedCommand, finalMessage],
    status: "completed",
    completedAt: now + 1,
    durationMs: 1_000,
  };
  await emitControlledEvent(
    page,
    eventPath,
    "notification",
    envelope({
      method: "turn/completed",
      params: { threadId: nativeThreadId, turn: completedTurn },
    }),
  );

  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
  await expect(
    page.getByText("The ordering is stable.", { exact: true }),
  ).toBeVisible();
  await expect(activityDetails).toHaveAttribute("open", "");
  const completedActivityHeight = await activityDetails.evaluate(
    (details) => details.getBoundingClientRect().height,
  );
  expect(completedActivityHeight).toBeGreaterThan(40);
  const completedRows = await page
    .locator(".message-column > .message")
    .evaluateAll((rows) => rows.map((row) => row.className));
  expect(completedRows).toEqual([
    "message message-user",
    "message message-codex-turn-activity",
    "message message-assistant",
  ]);
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
          outputs: [
            {
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
            },
          ],
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
          outputs: [
            {
              outputType: "function_call_output",
              createdAt: startedAt + 2.1,
              nativeStatus: null,
              payload: {
                type: "function_call_output",
                call_id: "call-e2e-rollout-wait",
                output: "Script completed",
              },
            },
          ],
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
  await expect(activityHeading).toBeVisible();
  await expect(activityFilter).toBeVisible();
  const [activityHeadingBox, activityFilterBox] = await Promise.all([
    activityHeading.boundingBox(),
    activityFilter.boundingBox(),
  ]);
  expect(activityHeadingBox).not.toBeNull();
  expect(activityFilterBox).not.toBeNull();
  expect(activityFilterBox!.y).toBeLessThan(activityHeadingBox!.y);
  await expect(
    activityView.getByText("Attributed by native Thread and Turn IDs.", {
      exact: false,
    }),
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
  await expect(
    commandActivity.locator(":scope > summary"),
  ).toHaveAccessibleName(/Ran.*git status --short.*1 update/);
  await expect(commandActivity).not.toContainText("call-e2e-rollout-exec");
  await commandActivity.locator(":scope > summary").click();
  await expect(commandActivity).toContainText("1 update");
  await commandActivity.locator(".codex-native-tool-details > summary").click();
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
  await expect(auditRegion.locator(".audit-technical-content pre")).toHaveCount(
    0,
  );

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
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(
          window.localStorage.getItem("sandpi.local-ui-preferences.v1") ??
            "{}",
        ) as {
          filters?: {
            codexSessionActivity?: string;
            environmentAudit?: string;
          };
        };
        return stored.filters;
      }),
    )
    .toEqual({
      codexSessionActivity: "external",
      environmentAudit: "attention",
    });

  const auditRequestsBeforePagination = auditRequests;
  await auditRegion
    .getByRole("button", { name: "Load newer signed records" })
    .click();
  await expect.poll(() => auditCursors).toEqual(["mock-history-cursor"]);
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
  await expect.poll(() => environmentUpdates).toBe(0);
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
      const after = Number(
        new URL(socket.url()).searchParams.get("after") ?? 0,
      );
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
      history
        .filter((event) => event.seq > after)
        .forEach((event) => {
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
  await expect(
    terminal.getByText("Unauthorized", { exact: true }),
  ).toBeVisible();
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
                defaultReasoningEffort: "high",
                supportedReasoningEfforts: [
                  {
                    reasoningEffort: "low",
                    description: "Faster answers",
                  },
                  {
                    reasoningEffort: "high",
                    description: "Deeper reasoning",
                  },
                ],
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
    if (tab !== "files")
      await tabs.getByRole("button", { name: label }).click();
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
  await expect
    .poll(() => modelPicker.locator("option").count())
    .toBeGreaterThan(0);
  const firstNativeModel = await modelPicker
    .locator("option")
    .first()
    .getAttribute("value");
  expect(firstNativeModel).toBeTruthy();
  await modelPicker.selectOption(firstNativeModel ?? "");
  await expect(modelPicker).toHaveValue(firstNativeModel ?? "");
  const reasoningEffortPicker = page.getByRole("combobox", {
    name: "Select reasoning effort for E2E native Codex model",
  });
  await expect(
    page.locator(".conversation-header-actions button[aria-haspopup='menu']"),
  ).toHaveCount(0);
  await expect(reasoningEffortPicker).toBeEnabled();
  await expect(reasoningEffortPicker).toHaveValue("high");
  await reasoningEffortPicker.selectOption("low");
  await expect(reasoningEffortPicker).toHaveValue("low");

  await page.reload();
  await expect(tabs).toBeVisible();
  await expect(
    tabs.getByRole("button", { name: "Metrics" }),
  ).toHaveClass(/is-active/);
  await expect(metricsRange).toHaveValue("21600");
  await expect(reasoningEffortPicker).toHaveValue("low");
  await page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("button", { name: "Close inspector" })
    .click();
  await expect(tabs).toBeHidden();

  await page.reload();
  await expect(page.getByRole("button", { name: "Open inspector" })).toBeVisible();
  await expect(tabs).toBeHidden();
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
    const directoryPath = new URL(route.request().url()).searchParams.get(
      "path",
    );
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
  await expect(
    page.getByText("feature/live-ide", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("src · feature/live-ide", { exact: true }),
  ).toBeVisible();
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
    content: Buffer.from("export const externalChange = true;\n").toString(
      "base64",
    ),
  };
  await expect(save).toBeEnabled();
  // Use the editor's real keyboard save path here. The conflict response
  // disables the button synchronously, which can make Playwright retry a
  // locator click even though the first click already reached the server.
  await page.keyboard.press("Control+S");
  await expect(
    page.getByText("This file changed outside the editor."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use latest" }).click();
  await expect(
    page.getByText("export const externalChange = true;"),
  ).toBeVisible();
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

  await page
    .getByRole("button", { name: "Development settings" })
    .last()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Development settings" }),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

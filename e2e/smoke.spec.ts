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
  CodexFileUpdateChange,
  CodexNativeSnapshot,
  CodexThread,
  CodexThreadItem,
  CodexTurn,
} from "../src/harnesses/codex/types";
import { PENDING_GUEST_PROMPT_STORAGE_KEY } from "../src/lib/auth-navigation";
import {
  getMockBootstrap,
  mockEnvironmentMetrics,
} from "../src/lib/mock-data";

interface ControlledEventWindow extends Window {
  __sandpiEmitEvent?: (
    urlIncludes: string,
    type: string,
    payload: unknown,
  ) => boolean;
}

function useEnglishUi(bootstrap: SandpiBootstrap) {
  bootstrap.preferences = {
    ...bootstrap.preferences,
    general: {
      ...bootstrap.preferences.general,
      language: "en",
    },
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/bootstrap**", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const body = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
    useEnglishUi(body.data);
    await route.fulfill({ response, json: body });
  });
});

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

async function serveAnonymousBootstrap(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "authentication_required",
            message: "Sign in required.",
            loginUrl: "/api/v1/auth/login",
          },
        }),
      });
    },
  );
}

async function captureLoginNavigation(page: Page) {
  let requestUrl: string | undefined;
  await page.route(
    (url) => url.pathname === "/api/v1/auth/login",
    async (route) => {
      requestUrl = route.request().url();
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Identity provider</title>",
      });
    },
  );
  return () => requestUrl;
}

test("keeps anonymous visitors on the app home until they send a message", async ({
  page,
}) => {
  await serveAnonymousBootstrap(page);
  const loginRequestUrl = await captureLoginNavigation(page);

  await page.goto("/");
  const appUrl = page.url();
  await expect(
    page.getByRole("heading", { name: "What should Codex work on?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Log in or sign up" }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(loginRequestUrl()).toBeUndefined();

  const composer = page.getByPlaceholder("Ask Codex to work on something…");
  await composer.fill("Inspect this repository before changing anything");
  expect(loginRequestUrl()).toBeUndefined();

  await page
    .getByRole("button", { name: "Send message and continue" })
    .click();
  await expect.poll(loginRequestUrl).toBeTruthy();

  const loginRequest = new URL(loginRequestUrl()!);
  expect(loginRequest.pathname).toBe("/api/v1/auth/login");
  expect(loginRequest.searchParams.get("return_to")).toBe(
    new URL("/?new=1", appUrl).toString(),
  );
  expect(
    await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      PENDING_GUEST_PROMPT_STORAGE_KEY,
    ),
  ).toBe("Inspect this repository before changing anything");
});

test("starts login from the anonymous account action", async ({ page }) => {
  await serveAnonymousBootstrap(page);
  const loginRequestUrl = await captureLoginNavigation(page);

  await page.goto("/");
  const appUrl = page.url();
  await page.getByRole("button", { name: "Log in or sign up" }).click();
  await expect.poll(loginRequestUrl).toBeTruthy();
  expect(new URL(loginRequestUrl()!).searchParams.get("return_to")).toBe(appUrl);
});

test("offers Help & feedback without account-only links to anonymous visitors", async ({
  page,
}) => {
  await serveAnonymousBootstrap(page);

  await page.goto(
    "/?environment=env-private&session=session-private&path=%2Fworkspace%2Fsecret",
  );
  await expect(
    page.getByRole("link", { name: "Sandpi GitHub repository" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("iOS · Android · HarmonyOS coming soon"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Help & feedback" }).click();

  const dialog = page.getByRole("dialog", { name: "Help & feedback" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: /Read the documentation/ }),
  ).toHaveAttribute("href", "https://github.com/sandbox0-ai/sandpi#readme");

  const reportHref = await dialog
    .getByRole("link", { name: /Report a problem/ })
    .getAttribute("href");
  expect(reportHref).toBeTruthy();
  const reportUrl = new URL(reportHref!);
  expect(`${reportUrl.origin}${reportUrl.pathname}`).toBe(
    "https://github.com/sandbox0-ai/sandpi/issues/new",
  );
  expect(reportUrl.searchParams.get("body")).not.toContain("env-private");
  expect(reportUrl.searchParams.get("body")).not.toContain("session-private");
  expect(reportUrl.searchParams.get("body")).not.toContain("workspace");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("logs OIDC users out to the anonymous app home", async ({ page }) => {
  const bootstrap = getMockBootstrap();
  let loggedOut = false;
  let logoutRequests = 0;

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      if (loggedOut) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "authentication_required",
              message: "Sign in required.",
              loginUrl: "/api/v1/auth/login",
            },
          }),
        });
        return;
      }
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/auth/logout",
    async (route) => {
      expect(route.request().method()).toBe("POST");
      logoutRequests += 1;
      loggedOut = true;
      await route.fulfill({ status: 204 });
    },
  );

  await page.goto(
    "/?environment=env-private&session=session-private&path=%2Fworkspace%2Fsecret",
  );
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();

  await expect(
    page.getByRole("heading", { name: "What should Codex work on?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Log in or sign up" }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).search).toBe("");
  expect(logoutRequests).toBe(1);
});

test("keeps built-in logout anonymous until the user signs in again", async ({
  page,
  request,
}) => {
  const response = await request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
  test.skip(
    bootstrap.data.deployment.identity.protocol !== "builtin",
    "The built-in identity mode is required for this check.",
  );

  await page.goto(
    "/?environment=env-private&session=session-private&path=%2Fworkspace%2Fsecret",
  );
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();

  await expect(
    page.getByRole("heading", { name: "What should Codex work on?" }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).search).toBe("");

  await page.getByRole("button", { name: "Log in or sign up" }).click();
  await expect(
    page.getByRole("button", { name: "Open account menu" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Log in or sign up" }),
  ).toBeHidden();
});

test("restores a guest message on the authenticated new Session page", async ({
  page,
  request,
}) => {
  const response = await request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
  const environment = bootstrap.data.environments[0];
  test.skip(!environment, "An Environment is required for this check.");
  if (!environment) return;

  const pendingPrompt = "Keep this task after authentication";
  await page.addInitScript(
    ({ key, prompt }) => window.sessionStorage.setItem(key, prompt),
    {
      key: PENDING_GUEST_PROMPT_STORAGE_KEY,
      prompt: pendingPrompt,
    },
  );
  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );

  await expect(
    page.locator('textarea[name="new-session-instruction"]'),
  ).toHaveValue(pendingPrompt);
  expect(
    await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      PENDING_GUEST_PROMPT_STORAGE_KEY,
    ),
  ).toBeNull();
});

test("loads the live workspace and Environment credential surface", async ({
  page,
  request,
}) => {
  const environment = await readyEnvironment(request);
  test.skip(!environment, "A ready Environment is required.");
  if (!environment) return;
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  await expect(
    page.locator('textarea[name="new-session-instruction"]'),
  ).toBeVisible();

  await page
    .locator(".environment-row")
    .filter({ hasText: environment.name })
    .locator(".environment-row-actions button")
    .last()
    .click();
  await page.getByRole("button", { name: "Agent harness" }).click();
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
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Credentials", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".environment-credentials-panel")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add credential", exact: true }),
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
                additionalSpeedTiers: ["fast"],
                serviceTiers: [
                  {
                    id: "e2e-native-priority",
                    name: "Fast",
                    description: "Fast native processing",
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
            kind: "file",
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
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  const modelPicker = page.getByRole("combobox", {
    name: /Select Codex model|选择 Codex 模型/,
  });
  await expect(modelPicker).toBeDisabled();
  await expect(modelPicker.locator("option")).toHaveCount(1);
  await expect(
    page.getByRole("status").filter({
      hasText: /Starting Codex|正在启动 Codex/,
    }),
  ).toBeVisible();
  await expect(modelPicker.locator("option")).not.toContainText(/default|默认/);

  releaseCatalog();
  await expect(modelPicker).toBeEnabled();
  await expect(modelPicker).toHaveValue("e2e-codex-fast");
  const fastEffortPicker = page.getByRole("combobox", {
    name: /Select reasoning effort for E2E Codex Fast|选择 E2E Codex Fast 的推理深度/,
  });
  await expect(fastEffortPicker).toHaveValue("high");
  await expect(fastEffortPicker.locator("option")).toHaveText(["Low", "High"]);
  const fastToggle = page.getByTestId("codex-fast-toggle");
  await expect(fastToggle).toHaveAttribute("aria-pressed", "false");
  await fastToggle.click();
  await expect(fastToggle).toHaveAttribute("aria-pressed", "true");

  const newSessionComposer = page.locator(
    'textarea[name="new-session-instruction"]',
  );
  await newSessionComposer.fill("Verify native model settings.");

  await page.getByTestId("codex-composer-upload-input").setInputFiles({
    name: "requirements.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-e2e-test"),
  });
  await expect(newSessionComposer).toHaveValue(
    "Verify native model settings. " +
      ".sandpi/uploads/e2e-requirements/requirements.pdf ",
  );
  await expect
    .poll(() => uploadBody)
    .toMatchObject({
      name: "requirements.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from("%PDF-e2e-test").toString("base64"),
    });
  await page
    .getByRole("button", {
      name: /Mention a Workspace file|引用工作区文件/,
    })
    .click();
  await page
    .getByPlaceholder(/Search \/workspace|搜索 \/workspace/)
    .fill("README");
  await page.getByRole("option").filter({ hasText: "README.md" }).click();
  await expect(newSessionComposer).toHaveValue(
    "Verify native model settings. " +
      ".sandpi/uploads/e2e-requirements/requirements.pdf README.md ",
  );

  await modelPicker.selectOption("e2e-codex-deep");
  await expect(fastToggle).toBeHidden();
  const deepEffortPicker = page.getByRole("combobox", {
    name: /Select reasoning effort for E2E Codex Deep|选择 E2E Codex Deep 的推理深度/,
  });
  await expect(deepEffortPicker).toHaveValue("max");
  await expect(deepEffortPicker.locator("option")).toHaveText([
    "Medium",
    "Max",
  ]);
  await deepEffortPicker.selectOption("medium");
  await modelPicker.selectOption("e2e-codex-fast");
  await expect(fastEffortPicker).toHaveValue("high");
  await expect(fastToggle).toHaveAttribute("aria-pressed", "false");
  await modelPicker.selectOption("e2e-codex-deep");
  await expect(deepEffortPicker).toHaveValue("medium");
  await page.locator(".composer-shell .send-button").click();
  await expect
    .poll(() => createSessionBody)
    .toMatchObject({
      environmentId: environment.id,
      modelId: "e2e-codex-deep",
      reasoningEffort: "medium",
      prompt:
        "Verify native model settings. " +
        ".sandpi/uploads/e2e-requirements/requirements.pdf README.md",
      localImages: [],
    });
  expect(createSessionBody).not.toHaveProperty("references");
  expect(createSessionBody).not.toHaveProperty("serviceTier");
  await page.reload();
  await expect(modelPicker).toBeEnabled();
  await expect(modelPicker).toHaveValue("e2e-codex-deep");
  await expect(
    page.getByRole("combobox", {
      name: /Select reasoning effort for E2E Codex Deep|选择 E2E Codex Deep 的推理深度/,
    }),
  ).toHaveValue("medium");
  expect(browserErrors).toEqual([]);
});

test("keeps New Session header operations aligned with the conversation", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  const environment = bootstrap.environments[0]!;
  bootstrap.sessions = [];
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = "";

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/models`,
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            data: [
              {
                id: "e2e-new-session-header-model",
                displayName: "E2E New Session Header",
                isDefault: true,
              },
            ],
          },
          meta: { availability: "available", source: "codex" },
        },
      });
    },
  );
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/ide`,
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            files: [],
            git: { repositories: [] },
            refreshedAt: Date.now() / 1_000,
          },
        },
      });
    },
  );
  await page.routeWebSocket(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/ide/events`,
    (socket) => {
      socket.send(JSON.stringify({ type: "ready", at: Date.now() / 1_000 }));
    },
  );

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  await expect(
    page.getByRole("heading", { name: "What should Codex work on?" }),
  ).toBeVisible();

  const header = page.locator("#conversation > header");
  await expect(
    header.getByRole("button", { name: "Terminal" }),
  ).toBeVisible();
  const inspectorToggle = header.getByRole("button", {
    name: "Open inspector",
  });
  await expect(inspectorToggle).toBeVisible();
  await expect(
    header.getByRole("button", { name: `${environment.name} settings` }),
  ).toHaveCount(0);

  await inspectorToggle.click();
  const inspectorViews = page.getByRole("navigation", {
    name: "Inspector views",
  });
  await expect(inspectorViews).toBeVisible();
  await expect(
    inspectorViews.getByRole("button", { name: "Files", exact: true }),
  ).toHaveClass(/is-active/);
  await expect(
    inspectorViews.getByRole("button", { name: "Metrics", exact: true }),
  ).toBeVisible();
  await expect(
    inspectorViews.getByRole("button", { name: "Activity", exact: true }),
  ).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: "Close inspector" }),
  ).toHaveAttribute("aria-pressed", "true");

  await header.getByRole("button", { name: "Close inspector" }).click();
  await expect(inspectorViews).toBeHidden();
  await expect(
    header.getByRole("button", { name: "Open inspector" }),
  ).toHaveAttribute("aria-pressed", "false");
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
  let usageReset = false;
  let usageResetBody: Record<string, unknown> | undefined;
  let usageResetMethod: string | undefined;

  await page.route("**/api/v1/bootstrap**", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
    useEnglishUi(body.data);
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
            resetCredits: {
              availableCount: usageReset ? 0 : 1,
            },
            limits: [
              {
                id: "codex",
                name: "Codex",
                planType: "pro",
                primary: {
                  usedPercent: usageReset ? 0 : 42,
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
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/rate-limits/reset`,
    async (route) => {
      usageResetMethod = route.request().method();
      usageResetBody = route.request().postDataJSON() as Record<
        string,
        unknown
      >;
      usageReset = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { outcome: "reset" },
        }),
      });
    },
  );

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  await page
    .getByRole("button", { name: /Connect Codex|连接 Codex/, exact: true })
    .click();
  const settingsDialog = page.getByRole("dialog", {
    name: `${environment.name} settings`,
  });
  await expect(
    settingsDialog.getByRole("heading", { name: "Agent harness & account" }),
  ).toBeVisible();
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
  const resetUsageButton = settingsDialog.getByRole("button", {
    name: "Reset Codex usage (1 reset credit available)",
  });
  await resetUsageButton.click();
  await expect(
    settingsDialog.getByText("Reset Codex usage limits?"),
  ).toBeVisible();
  await settingsDialog
    .getByRole("button", { name: "Use reset credit" })
    .click();
  await expect
    .poll(() => usageResetBody?.idempotencyKey)
    .toMatch(/^codex-usage-reset-[a-z0-9]{24}$/);
  expect(usageResetMethod).toBe("PUT");
  await expect(
    settingsDialog.getByText("Codex usage limits were reset."),
  ).toBeVisible();
  await expect(
    settingsDialog.getByRole("progressbar", {
      name: "Codex 5-hour window",
    }),
  ).toHaveAttribute("aria-valuenow", "0");
  await expect(
    settingsDialog.getByRole("button", {
      name: "Reset Codex usage (0 reset credits available)",
    }),
  ).toBeDisabled();
  await expect(
    settingsDialog.getByRole("button", { name: "Re-authenticate Codex" }),
  ).toBeVisible();
  expect(completedEnvironmentRefreshes).toBeGreaterThan(0);
});

test("connects native MCP OAuth and toggles user-level definitions", async ({
  context,
  page,
  request,
}) => {
  const response = await request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
  const environment = bootstrap.data.environments[0];
  test.skip(!environment, "An Environment is required for this check.");
  if (!environment) return;

  let enabled = true;
  let submitted: unknown;
  let loginSubmitted = false;
  let linearConnected = false;
  await context.route("https://linear.example.test/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Linear connected</title>",
    });
  });
  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/mcp-servers**`,
    async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        route.request().method() === "POST" &&
        requestUrl.pathname.endsWith("/linear/oauth/login")
      ) {
        loginSubmitted = true;
        linearConnected = true;
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              name: "linear",
              authorizationUrl:
                "https://linear.example.test/oauth/authorize?state=e2e",
              expiresAt: Date.now() / 1_000 + 300,
            },
          }),
        });
        return;
      }
      if (route.request().method() === "PUT") {
        submitted = route.request().postDataJSON();
        enabled = false;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            servers: [
              {
                name: "admin",
                transport: "stdio",
                command: "admin-mcp",
                args: ["--stdio"],
                enabled: true,
                managed: false,
                authStatus: "unknown",
                runtimeStatus: "unavailable",
                toolCount: 0,
                resourceCount: 0,
              },
              {
                name: "linear",
                transport: "streamable-http",
                args: [],
                url: "https://mcp.linear.app/mcp",
                enabled: true,
                managed: true,
                runtimeStatus: linearConnected
                  ? "connected"
                  : "authentication-required",
                serverTitle: linearConnected ? "Linear" : undefined,
                toolCount: linearConnected ? 12 : 0,
                resourceCount: 0,
              },
              {
                name: "docs",
                transport: "streamable-http",
                args: [],
                url: "https://docs.example.test/mcp",
                enabled,
                managed: true,
                authStatus: "unsupported",
                runtimeStatus: enabled ? "connected" : "disabled",
                serverTitle: "Documentation",
                toolCount: 3,
                resourceCount: 1,
              },
            ],
          },
        }),
      });
    },
  );

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  await page
    .locator(".environment-group")
    .filter({ hasText: environment.name })
    .locator(".environment-row-actions button")
    .last()
    .click();
  const settingsDialog = page.getByRole("dialog", {
    name: `${environment.name} settings`,
  });
  await settingsDialog.getByRole("button", { name: "MCP servers" }).click();

  await expect(
    settingsDialog.getByText("Documentation", { exact: true }),
  ).toBeVisible();
  await expect(settingsDialog.getByText("3 tools")).toBeVisible();
  await expect(settingsDialog.getByText("Read only")).toBeVisible();
  await expect(
    settingsDialog.getByRole("button", { name: /Configure|Add MCP/ }),
  ).toHaveCount(0);

  const popupPromise = page.waitForEvent("popup");
  await settingsDialog
    .getByRole("button", { name: "Connect linear" })
    .click();
  const popup = await popupPromise;
  await popup.waitForURL(
    "https://linear.example.test/oauth/authorize?state=e2e",
  );
  expect(loginSubmitted).toBe(true);
  await expect(
    settingsDialog.getByText("Linear", { exact: true }),
  ).toBeVisible();
  await expect(settingsDialog.getByText("12 tools")).toBeVisible();
  await expect(
    settingsDialog.getByRole("button", { name: "Connect linear" }),
  ).toHaveCount(0);

  await settingsDialog.getByRole("switch", { name: "Disable docs" }).click();
  await expect.poll(() => submitted).toEqual({ enabled: false });
  await expect(
    settingsDialog.getByRole("switch", { name: "Enable docs" }),
  ).toHaveAttribute("aria-checked", "false");
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
    useEnglishUi(body.data);
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
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
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
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
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

test("serves the Preferences layout", async ({ page }) => {
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
  const preferenceSections = page.getByRole("navigation", {
    name: "Preference sections",
  });
  await expect(preferenceSections.getByRole("button")).toHaveCount(3);
  await expect(
    preferenceSections.getByRole("button", { name: "General", exact: true }),
  ).toBeVisible();
  await expect(
    preferenceSections.getByRole("button", {
      name: "Appearance",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    preferenceSections.getByRole("button", {
      name: "Billing",
      exact: true,
    }),
  ).toBeVisible();
  for (const removedSection of ["Notifications", "Security", "Advanced"]) {
    await expect(
      preferenceSections.getByRole("button", {
        name: removedSection,
        exact: true,
      }),
    ).toHaveCount(0);
  }
});

test("shows account usage and submits only a server-owned plan id", async ({
  page,
}) => {
  let checkoutBody: unknown;
  const periodStartsAt = Date.parse("2026-07-01T00:00:00.000Z") / 1_000;
  const periodEndsAt = Date.parse("2026-08-01T00:00:00.000Z") / 1_000;
  await page.route(
    (url) => url.pathname === "/api/v1/billing/summary",
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            billingEnabled: true,
            plan: {
              id: "free",
              name: "Free",
              monthlyPriceUsd: 0,
              environmentLimit: 1,
              memoryConfigurable: false,
              runtimeQuotaGiBHours: 1,
              quotaPeriod: "account-month",
            },
            availablePlans: [
              {
                id: "free",
                name: "Free",
                monthlyPriceUsd: 0,
                environmentLimit: 1,
                memoryConfigurable: false,
                runtimeQuotaGiBHours: 1,
                quotaPeriod: "account-month",
              },
              {
                id: "plus",
                name: "Plus",
                monthlyPriceUsd: 10,
                environmentLimit: 3,
                memoryConfigurable: true,
                runtimeQuotaGiBHours: 168,
                quotaPeriod: "fixed-week",
              },
              {
                id: "pro",
                name: "Pro",
                monthlyPriceUsd: 25,
                environmentLimit: 10,
                memoryConfigurable: true,
                runtimeQuotaGiBHours: 500,
                quotaPeriod: "fixed-week",
              },
            ],
            usage: {
              periodStartsAt,
              periodEndsAt,
              confirmedMiBMilliseconds: 921_600_000,
              projectedMiBMilliseconds: 1_843_200_000,
              usedMiBMilliseconds: 1_843_200_000,
              limitMiBMilliseconds: 3_686_400_000,
              remainingMiBMilliseconds: 1_843_200_000,
              usedGiBHours: 0.5,
              limitGiBHours: 1,
              percentUsed: 50,
              exhausted: false,
            },
            environmentCount: 1,
            overEnvironmentLimit: false,
            customerPortalAvailable: false,
            usageSource: "sandbox0-sdk",
          },
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/billing/checkout",
    async (route) => {
      checkoutBody = route.request().postDataJSON();
      await route.fulfill({
        json: { data: { kind: "subscription-updated" } },
      });
    },
  );

  await page.goto("/");

  const accountMenuTrigger = page.getByRole("button", {
    name: "Open account menu",
  });
  await expect(
    accountMenuTrigger.locator(".account-menu-indicator"),
  ).toHaveClass(/lucide-chevron-up/);
  await expect(
    page.getByRole("link", { name: "Sandpi GitHub repository" }),
  ).toHaveCount(0);

  await accountMenuTrigger.click();
  const closeAccountMenuTrigger = page.getByRole("button", {
    name: "Close account menu",
  });
  await expect(
    closeAccountMenuTrigger.locator(".account-menu-indicator"),
  ).toHaveClass(/lucide-chevron-down/);
  const accountMenu = page.getByRole("menu", { name: "Account actions" });
  await expect(accountMenu.getByText("Sandbox runtime")).toBeVisible();
  await expect(accountMenu.getByText("0.5 / 1 GiB-hours")).toBeVisible();
  await expect(
    accountMenu.getByRole("menuitem", {
      name: "Sandpi GitHub repository",
    }),
  ).toHaveAttribute("href", "https://github.com/sandbox0-ai/sandpi");
  await expect(
    accountMenu.getByText("iOS · Android · HarmonyOS coming soon"),
  ).toBeVisible();

  await closeAccountMenuTrigger.click();
  await expect(
    accountMenuTrigger.locator(".account-menu-indicator"),
  ).toHaveClass(/lucide-chevron-up/);

  await page.goto("/preferences?billing=open");

  await expect(
    page.getByRole("heading", { name: "Billing & usage" }),
  ).toBeVisible();
  await expect(page.getByText("0.5 / 1 GiB-hours")).toBeVisible();
  await expect(page.getByText("Sandbox0 SDK", { exact: true })).toBeVisible();
  const plusPlan = page
    .getByRole("article")
    .filter({ hasText: "Plus" });
  await plusPlan.getByRole("button", { name: "Choose plan" }).click();

  await expect.poll(() => checkoutBody).toBeTruthy();
  expect(checkoutBody).toEqual({
    planId: "plus",
    idempotencyKey: expect.any(String),
  });
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
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
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
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
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
  const activityFilter = activityView.getByRole("combobox", {
    name: "Filter Codex Session Activity",
  });
  await expect(activityFilter).toBeEnabled();
  await activityFilter.click();
  await activityFilter.selectOption("system");
  await expect(activityFilter).toHaveValue("system");
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
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
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

test("interrupts a persisted running Session before its native snapshot arrives", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const sessionPath = `/api/v1/sessions/${session.id}`;
  const eventPath = `${sessionPath}/events`;
  const interruptPath = `${sessionPath}/turns/interrupt`;
  let interruptBody: unknown;

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
      useEnglishUi(body.data);
      body.data.sessions = body.data.sessions.map((candidate) =>
        candidate.id === session.id
          ? { ...candidate, status: "running" }
          : candidate,
      );
      await route.fulfill({ response, json: body });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/sessions",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as ApiEnvelope<
        SandpiBootstrap["sessions"]
      >;
      body.data = body.data.map((candidate) =>
        candidate.id === session.id
          ? { ...candidate, status: "running" }
          : candidate,
      );
      await route.fulfill({ response, json: body });
    },
  );
  await page.route(
    (url) => url.pathname === sessionPath,
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            ...session,
            status: "running",
          },
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === eventPath,
    async (route) => {
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
    },
  );
  await page.route(
    (url) => url.pathname === interruptPath,
    async (route) => {
      interruptBody = route.request().postDataJSON();
      await route.fulfill({
        status: 202,
        json: {
          data: {
            turnId: "turn-from-durable-session-state",
            status: "interrupting",
          },
        },
      });
    },
  );

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );

  const interrupt = page.getByRole("button", {
    name: /Interrupt running Codex turn|中断正在运行的 Codex Turn/,
  });
  await expect(interrupt).toBeEnabled();
  const beforeHover = await interrupt.boundingBox();
  await interrupt.hover();
  const afterHover = await interrupt.boundingBox();
  expect(beforeHover).not.toBeNull();
  expect(afterHover).toEqual(beforeHover);
  await interrupt.click();
  await expect.poll(() => interruptBody).toEqual({});
});

test("deduplicates native models and sends Plan plus composer Fast mode", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(
    !workspace ||
      workspace.environment.status !== "ready" ||
      workspace.environment.codingAgent.status !== "connected",
    "A ready Environment with Codex connected is required for this check.",
  );
  if (
    !workspace ||
    workspace.environment.status !== "ready" ||
    workspace.environment.codingAgent.status !== "connected"
  ) {
    return;
  }
  const { environment } = workspace;
  let createBody: Record<string, unknown> | undefined;

  await page.route(
    `**/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/models`,
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            data: [
              {
                id: "e2e-plan-model",
                displayName: "E2E Plan Model",
                isDefault: true,
                defaultReasoningEffort: "high",
                supportedReasoningEfforts: [
                  {
                    reasoningEffort: "high",
                    description: "Deep reasoning",
                  },
                ],
                additionalSpeedTiers: ["fast"],
                serviceTiers: [
                  {
                    id: "e2e-native-priority",
                    name: "Fast",
                    description: "Fast native processing",
                  },
                ],
              },
              {
                id: "e2e-plan-model",
                displayName: "Duplicate E2E Plan Model",
                isDefault: false,
                defaultReasoningEffort: "low",
                supportedReasoningEfforts: [
                  {
                    reasoningEffort: "low",
                    description: "Duplicate native entry",
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
  await page.route("**/api/v1/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 204 });
  });

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  const modelPicker = page.locator(
    'select[name="coding-agent-model"]',
  );
  await expect(modelPicker).toBeEnabled();
  await expect(modelPicker.locator("option")).toHaveText(["E2E Plan Model"]);

  const composer = page.locator(
    'textarea[name="new-session-instruction"]',
  );
  await composer.fill("/plan");
  await composer.press("Enter");
  await expect(page.locator(".codex-composer-mode")).toBeVisible();
  await expect(composer).toHaveValue("");
  const fastToggle = page.getByTestId("codex-fast-toggle");
  await expect(fastToggle).toHaveAttribute("aria-pressed", "false");
  await fastToggle.click();
  await expect(fastToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".codex-composer-mode")).toHaveCount(1);

  await composer.fill("Design the persistence change");
  await page.locator(".composer-shell .send-button").click();
  await expect
    .poll(() => createBody)
    .toMatchObject({
      environmentId: environment.id,
      prompt: "Design the persistence change",
      modelId: "e2e-plan-model",
      reasoningEffort: "high",
      collaborationMode: "plan",
      serviceTier: "e2e-native-priority",
    });
});

test("maps Codex slash commands to Sandpi new and fork Session flows", async ({
  page,
  request,
}) => {
  const workspace = await activeWorkspace(request);
  test.skip(!workspace, "An active Session is required for this check.");
  if (!workspace) return;
  const { environment, session } = workspace;
  const eventPath = `/api/v1/sessions/${session.id}/events`;
  const nativeThreadId = "thread-e2e-slash-commands";
  const forkedSessionId = "session-e2e-slash-fork";
  const now = Date.now() / 1_000;
  const snapshot: CodexNativeSnapshot = {
    protocol: "codex-app-server",
    nativeSessionId: nativeThreadId,
    historyRevision: 1,
    modelId: "e2e-slash-model",
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
  let forkBody: unknown;
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await installControlledEventSource(page);
  await page.route("**/api/v1/**/models", async (route) => {
    await route.fulfill({
      json: {
        data: {
          data: [
            {
              id: snapshot.modelId,
              displayName: "E2E slash model",
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
    `**/api/v1/sessions/${encodeURIComponent(session.id)}/fork`,
    async (route) => {
      forkBody = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        json: {
          data: {
            ...session,
            id: forkedSessionId,
            title: "Forked from slash command",
            status: "waiting",
            archived: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      });
    },
  );
  const agentThread: CodexThread = {
    id: "thread-e2e-subagent",
    parentThreadId: nativeThreadId,
    agentNickname: "Scout",
    agentRole: "explorer",
    preview: "Inspect the native Agent flow",
    createdAt: now + 1,
    updatedAt: now + 2,
    status: { type: "idle" },
    turns: [
      {
        id: "turn-e2e-subagent",
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: now + 1,
        completedAt: now + 2,
        durationMs: 1_000,
        items: [
          {
            type: "userMessage",
            id: "item-e2e-subagent-prompt",
            clientId: null,
            content: [
              {
                type: "text",
                text: "Inspect the native Agent flow",
                text_elements: [],
              },
            ],
          },
          {
            type: "agentMessage",
            id: "item-e2e-subagent-answer",
            text: "Sub-agent result from its own native Thread.",
            phase: "final_answer",
            memoryCitation: null,
          },
        ],
      },
    ],
  };
  await page.route(
    `**/api/v1/sessions/${encodeURIComponent(session.id)}/agents**`,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/agents")) {
        await route.fulfill({
          json: {
            data: {
              root: snapshot.thread,
              descendants: [{ ...agentThread, turns: [] }],
            },
          },
        });
        return;
      }
      const requestedThreadId = decodeURIComponent(path.split("/").at(-1)!);
      await route.fulfill({
        json: {
          data:
            requestedThreadId === agentThread.id
              ? agentThread
              : snapshot.thread,
        },
      });
    },
  );

  const sourceUrl =
    `/?environment=${encodeURIComponent(environment.id)}` +
    `&session=${encodeURIComponent(session.id)}`;
  await page.goto(sourceUrl);
  await emitControlledEvent(page, eventPath, "snapshot", snapshot);
  await expect(page.getByText("Loading conversation…")).toBeHidden();

  const composer = page.locator('textarea[name="message"]');
  await composer.fill("/");
  const menu = page.getByRole("listbox", {
    name: /Codex slash commands|Codex 斜杠命令/,
  });
  await expect(menu).toBeVisible();
  await expect(
    menu.locator(".codex-slash-command-name", { hasText: "/new" }),
  ).toHaveCount(1);
  await expect(
    menu.locator(".codex-slash-command-name", { hasText: "/fork" }),
  ).toHaveCount(1);
  await expect(menu).not.toContainText("/resume");
  await expect(menu).not.toContainText("/side");
  await expect(menu).not.toContainText("/btw");
  await expect(menu).not.toContainText("/fast");
  await expect(menu).not.toContainText("/status");

  await composer.fill("/agent");
  await composer.press("Enter");
  const agentDialog = page.getByRole("dialog", { name: "Agent Threads" });
  await expect(agentDialog).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("agents"))
    .toBe("1");
  await expect(
    page.getByRole("complementary", { name: "Inspector" }),
  ).toBeHidden();
  await agentDialog.getByRole("button", { name: /Scout/ }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("agent"))
    .toBe(agentThread.id);
  await expect(
    agentDialog.getByText("Sub-agent result from its own native Thread."),
  ).toBeVisible();
  await page.reload();
  await emitControlledEvent(page, eventPath, "snapshot", snapshot);
  await expect(agentDialog).toBeVisible();
  await expect(
    agentDialog.getByText("Sub-agent result from its own native Thread."),
  ).toBeVisible();
  await agentDialog
    .getByRole("button", { name: "Close Agent Threads" })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("agents"))
    .toBeNull();
  expect(new URL(page.url()).searchParams.get("agent")).toBeNull();

  await composer.fill("/subagents");
  await composer.press("Enter");
  await expect(agentDialog).toBeVisible();
  await agentDialog
    .getByRole("button", { name: "Close Agent Threads" })
    .click();

  await composer.fill("/new");
  await composer.press("Enter");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("session"))
    .toBeNull();
  await expect(
    page.locator('textarea[name="new-session-instruction"]'),
  ).toBeVisible();

  await page.goto(sourceUrl);
  await emitControlledEvent(page, eventPath, "snapshot", snapshot);
  await expect(page.getByText("Loading conversation…")).toBeHidden();
  const resumedComposer = page.locator('textarea[name="message"]');
  await resumedComposer.fill("/fork");
  await resumedComposer.press("Enter");
  await expect.poll(() => forkBody).toEqual({});
  await expect
    .poll(() => new URL(page.url()).searchParams.get("session"))
    .toBe(forkedSessionId);
  expect(browserErrors).toEqual([]);
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
        text?: string;
        localImages?: Array<{
          name: string;
          path: string;
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
        text?: string;
        localImages?: Array<{
          name: string;
          path: string;
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
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await emitControlledEvent(page, eventPath, "snapshot", snapshot);
  await expect(page.getByText("Loading conversation…")).toBeHidden();

  const composer = page.locator('textarea[name="message"]');
  const submittedPrompt = `${prompt} app/page.tsx`;
  await expect(page.getByTestId("codex-composer-upload-input")).toHaveCount(1);
  await composer.fill(prompt);
  await page
    .getByRole("button", {
      name: /Mention a Workspace file|引用工作区文件/,
    })
    .click();
  await page
    .getByPlaceholder(/Search \/workspace|搜索 \/workspace/)
    .fill("page");
  await page.getByRole("option").filter({ hasText: "app/page.tsx" }).click();
  await expect(composer).toHaveValue(`${submittedPrompt} `);
  await page
    .getByRole("button", { name: /Send message|发送消息/ })
    .click();
  await expect
    .poll(() => turnRequestBody?.clientMessageId)
    .toMatch(/^user-message-/);
  const clientMessageId = turnRequestBody?.clientMessageId;
  expect(clientMessageId).toBeTruthy();
  expect(turnRequestBody?.text).toBe(submittedPrompt);
  expect(turnRequestBody?.localImages).toEqual([]);
  expect(turnRequestBody).not.toHaveProperty("references");
  await expect(composer).toHaveValue("");
  await expect(page.getByText(submittedPrompt, { exact: true })).toHaveCount(1);
  await expect(
    page.getByRole("button", {
      name: /Starting Codex turn|正在启动 Codex Turn/,
    }),
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
      { type: "text", text: submittedPrompt, text_elements: [] },
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
  const liveFileChanges: CodexFileUpdateChange[] = [
    {
      path: "/workspace/app/page.tsx",
      kind: { type: "update", move_path: null },
      diff: "-old page\n+new page",
    },
    {
      path: "/workspace/app/theme.css",
      kind: { type: "add" },
      diff: "+body {}",
    },
  ];
  const completedFileChange: CodexThreadItem = {
    type: "fileChange",
    id: "native-files-e2e-order",
    changes: liveFileChanges,
    status: "completed",
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
  await expect(page.getByText(submittedPrompt, { exact: true })).toHaveCount(1);
  await expect(
    activityRow.locator(":scope > .codex-turn-activity-static"),
  ).toBeVisible();
  await expect(activityRow.locator(":scope > details")).toHaveCount(0);
  releaseTurnResponse();
  await emitControlledEvent(
    page,
    eventPath,
    "notification",
    envelope({
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        itemId: completedFileChange.id,
        changes: liveFileChanges,
      },
    }),
  );
  const activityDetails = activityRow.locator(":scope > details");
  await expect(activityDetails).toHaveAttribute("open", "");
  await expect(activityDetails).toContainText("Editing 2 files");
  await expect(activityDetails).toContainText("app/page.tsx");
  await expect(activityDetails).toContainText("app/theme.css");
  await emitControlledEvent(
    page,
    eventPath,
    "notification",
    envelope({
      method: "item/completed",
      params: {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        item: completedFileChange,
        completedAtMs: now * 1_000 + 150,
      },
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
        item: runningCommand,
        startedAtMs: now * 1_000 + 100,
      },
    }),
  );
  await expect(activityDetails).toHaveAttribute("open", "");
  await expect(activityDetails).toContainText("rg --files");
  await expect(activityDetails).toContainText("app/page.tsx");
  await expect(activityDetails.locator("details")).toHaveCount(0);
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
    items: [
      nativeUserMessage,
      completedFileChange,
      completedCommand,
      finalMessage,
    ],
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

  await expect(page.getByText(submittedPrompt, { exact: true })).toHaveCount(1);
  await expect(
    page.getByText("The ordering is stable.", { exact: true }),
  ).toBeVisible();
  await expect(activityDetails).not.toHaveAttribute("open", "");
  const completedActivityHeight = await activityDetails.evaluate(
    (details) => details.getBoundingClientRect().height,
  );
  expect(completedActivityHeight).toBeLessThan(runningActivityHeight);
  const completedRows = await page
    .locator(".message-column > .message")
    .evaluateAll((rows) => rows.map((row) => row.className));
  expect(completedRows).toEqual([
    "message message-user",
    "message message-codex-turn-activity",
    "message message-assistant",
  ]);
});

test("keeps Codex Session Activity native", async ({
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
              'const r = await tools.exec_command({cmd:"git status --short"});',
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
        {
          kind: "rolloutToolCall",
          id: `rollout:${nativeTurnId}:custom:call-e2e-rollout-plan`,
          turnId: nativeTurnId,
          createdAt: startedAt + 2.2,
          completedAt: startedAt + 2.3,
          durationMs: 100,
          status: "completed",
          callId: "call-e2e-rollout-plan",
          callType: "custom_tool_call",
          name: "exec",
          namespace: null,
          nativeStatus: "completed",
          callPayload: {
            type: "custom_tool_call",
            call_id: "call-e2e-rollout-plan",
            name: "exec",
            input:
              'tools.update_plan({plan:[{step:"Inspect",status:"completed"}]});',
          },
          outputs: [],
          codeModeTools: ["update_plan"],
          payloadTruncated: false,
        },
        {
          kind: "rolloutToolCall",
          id: `rollout:${nativeTurnId}:custom:call-e2e-rollout-batch`,
          turnId: nativeTurnId,
          createdAt: startedAt + 3,
          completedAt: startedAt + 3.3,
          durationMs: 300,
          status: "completed",
          callId: "call-e2e-rollout-batch",
          callType: "custom_tool_call",
          name: "exec",
          namespace: null,
          nativeStatus: "completed",
          callPayload: {
            type: "custom_tool_call",
            call_id: "call-e2e-rollout-batch",
            name: "exec",
            input: `const jobs = [
  { args: { cmd: \`uname -a
cat /proc/version\`, workdir: "/workspace" } },
  { args: { cmd: \`id
ps -o pid,ppid,comm\`, workdir: "/workspace" } },
  { args: { cmd: \`findmnt -rn
cat /proc/self/cgroup\`, workdir: "/workspace" } }
];
await Promise.all(jobs.map((job) => tools.exec_command(job.args)));`,
          },
          outputs: [
            {
              outputType: "custom_tool_call_output",
              createdAt: startedAt + 3.3,
              nativeStatus: null,
              payload: {
                type: "custom_tool_call_output",
                call_id: "call-e2e-rollout-batch",
                output: "Script completed",
              },
            },
          ],
          codeModeTools: ["exec_command"],
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
  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
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
    activityView.getByText("How this activity is sourced", { exact: true }),
  ).toHaveCount(0);
  await expect(
    activityView.locator(".codex-session-activity-intro"),
  ).toContainText("4 actions · 6 native records");
  await expect(
    activityView.locator(".codex-session-activity-turn > header"),
  ).toContainText("4 actions · 6 records");
  await expect(
    activityView.getByText("update_plan", { exact: true }),
  ).toHaveCount(0);
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
  await expect(
    commandActivity.locator(".codex-native-tool-details.is-inline pre").first(),
  ).toHaveAttribute("tabindex", "0");
  await expect(commandActivity).toContainText("call-e2e-rollout-exec");
  await expect(commandActivity).toContainText("Script completed");
  const batchCommandActivity = activityView
    .locator(".codex-compact-activity")
    .filter({ hasText: "uname -a" });
  await expect(batchCommandActivity).toBeVisible();
  await expect(
    batchCommandActivity.locator(":scope > summary"),
  ).toHaveAccessibleName(/Ran.*uname -a.*id.*\+1/);
  await batchCommandActivity.locator(":scope > summary").click();
  const batchCommands = batchCommandActivity.locator(
    ".codex-rollout-command-list pre",
  );
  await expect(batchCommands).toHaveCount(3);
  await expect(batchCommands.nth(0)).toHaveText(
    "uname -a\ncat /proc/version",
  );
  await expect(batchCommands.nth(1)).toHaveText(
    "id\nps -o pid,ppid,comm",
  );
  await expect(batchCommands.nth(2)).toHaveText(
    "findmnt -rn\ncat /proc/self/cgroup",
  );
  const mcpActivity = activityView
    .locator(".codex-native-tool")
    .filter({ hasText: "GitHub · get_release" });
  await expect(mcpActivity).toBeVisible();
  await expect(mcpActivity.locator(":scope > summary")).toHaveAccessibleName(
    /Called.*GitHub.*get_release.*External/,
  );
  await mcpActivity.locator(":scope > summary").click();
  await expect(
    mcpActivity.locator(".codex-native-tool-details.is-inline pre").first(),
  ).toHaveAttribute("tabindex", "0");
  await expect(mcpActivity).toContainText('"repo": "sandpi"');

  await activityFilter.selectOption("external");
  await expect(commandActivity).toBeHidden();
  await expect(batchCommandActivity).toBeHidden();
  await expect(mcpActivity).toBeVisible();
  await expect(activityView.getByText("sandpi v1.2.3")).toBeVisible();
  await expect.poll(() => auditRequests).toBe(0);

  await expect(
    activityView.getByRole("button", { name: "Open Environment Audit" }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(
          window.localStorage.getItem("sandpi.local-ui-preferences.v1") ??
            "{}",
        ) as {
          filters?: {
            codexSessionActivity?: string;
          };
        };
        return stored.filters;
      }),
    )
    .toEqual({
      codexSessionActivity: "external",
    });

  await page
    .getByLabel("Codex conversation", { exact: true })
    .getByRole("button", { name: environment.name, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "What should Codex work on?" }),
  ).toBeVisible();
  await expect.poll(() => {
      const url = new URL(page.url());
      return {
        environment: url.searchParams.get("environment"),
        session: url.searchParams.get("session"),
        newSession: url.searchParams.get("new"),
      };
  }).toEqual({
      environment: environment.id,
      session: null,
      newSession: "1",
    });
  await expect(
    page.getByRole("dialog", { name: `${environment.name} settings` }),
  ).toHaveCount(0);
  await expect.poll(() => auditRequests).toBe(0);
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
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
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

  await page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("button", { name: "Close inspector" })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Inspector views" }),
  ).toBeHidden();
  await expect
    .poll(() => new URL(page.url()).searchParams.has("path"))
    .toBe(false);

  await page.reload();
  await expect(page.getByText("Loading conversation…")).toBeHidden();
  await expect(page.getByRole("button", { name: "Open inspector" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Inspector views" }),
  ).toBeHidden();
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
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
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
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
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
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
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
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
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
    await route.fallback();
  });

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
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
  await expect(page.locator(".metric-chart-pause-band")).toHaveCount(3);
  await expect(page.locator(".metric-chart-pause-legend")).toHaveCount(3);
  await expect(
    page.locator(".metric-chart-pause-legend").first(),
  ).toContainText("Sandpi idle pause");

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
            id: "github-config",
            name: ".github",
            path: "/workspace/.github",
            kind: "folder",
          },
          {
            id: "sandpi-state",
            name: ".sandpi",
            path: "/workspace/.sandpi",
            kind: "folder",
          },
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
  const managedFile: WorkspaceIdeFile = {
    path: "/workspace/.sandpi/config.json",
    name: "config.json",
    revision: `sha256:${"d".repeat(43)}`,
    encoding: "base64",
    content: Buffer.from('{"managed":true}\n').toString("base64"),
    kind: "text",
    editable: false,
    readOnlyReason: "sandpi-managed",
    size: "17 B",
    modifiedAt: now,
    lineChanges: [],
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
  let managedDirectoryLoads = 0;
  let remoteFile = file;
  const createRequests: Array<{
    parentPath: string;
    name: string;
    kind: "file" | "folder";
  }> = [];
  const renameRequests: Array<{ path: string; name: string }> = [];
  const deleteRequests: string[] = [];
  const sourceEntries: WorkspaceDirectoryListing["entries"] = [
    {
      id: "demo",
      name: "demo.ts",
      path: "/workspace/src/demo.ts",
      kind: "file",
      language: "TypeScript",
      size: "83 B",
      modifiedAt: now,
    },
  ];
  const createdFiles = new Map<string, WorkspaceIdeFile>();
  await page.route("**/api/v1/environments/**/files?*", async (route) => {
    const directoryPath = new URL(route.request().url()).searchParams.get(
      "path",
    );
    if (directoryPath === "/workspace/.sandpi") {
      managedDirectoryLoads += 1;
      const listing: WorkspaceDirectoryListing = {
        path: directoryPath,
        refreshedAt: now,
        entries: [
          {
            id: "sandpi-config",
            name: "config.json",
            path: managedFile.path,
            kind: "file",
            language: "JSON",
            size: managedFile.size,
            modifiedAt: now,
          },
        ],
      };
      await route.fulfill({ json: { data: listing } });
      return;
    }
    expect(directoryPath).toBe("/workspace/src");
    directoryLoads += 1;
    const listing: WorkspaceDirectoryListing = {
      path: "/workspace/src",
      refreshedAt: now,
      entries: sourceEntries,
    };
    await route.fulfill({ json: { data: listing } });
  });
  await page.route("**/api/v1/environments/**/ide/entries*", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const body = route.request().postDataJSON() as {
        parentPath: string;
        name: string;
        kind: "file" | "folder";
      };
      createRequests.push(body);
      const entryPath = `${body.parentPath}/${body.name}`;
      const entry = {
        id: Buffer.from(entryPath).toString("base64url"),
        name: body.name,
        path: entryPath,
        kind: body.kind,
      };
      sourceEntries.push(entry);
      if (body.kind === "file") {
        createdFiles.set(entryPath, {
          path: entryPath,
          name: body.name,
          revision: `sha256:${"e".repeat(43)}`,
          encoding: "base64",
          content: "",
          kind: "text",
          editable: true,
          size: "0 B",
          modifiedAt: now,
          lineChanges: [],
        });
      }
      await route.fulfill({ json: { data: entry } });
      return;
    }
    if (method === "PUT") {
      const body = route.request().postDataJSON() as {
        path: string;
        name: string;
      };
      renameRequests.push(body);
      const index = sourceEntries.findIndex((entry) => entry.path === body.path);
      expect(index).toBeGreaterThanOrEqual(0);
      const source = sourceEntries[index]!;
      const destinationPath = `${body.path.slice(0, body.path.lastIndexOf("/"))}/${body.name}`;
      const renamed = {
        ...source,
        id: Buffer.from(destinationPath).toString("base64url"),
        name: body.name,
        path: destinationPath,
      };
      sourceEntries[index] = renamed;
      const createdFile = createdFiles.get(body.path);
      if (createdFile) {
        createdFiles.delete(body.path);
        createdFiles.set(destinationPath, {
          ...createdFile,
          path: destinationPath,
          name: body.name,
        });
      }
      await route.fulfill({ json: { data: renamed } });
      return;
    }
    expect(method).toBe("DELETE");
    const entryPath = new URL(route.request().url()).searchParams.get("path");
    expect(entryPath).toBeTruthy();
    deleteRequests.push(entryPath ?? "");
    const index = sourceEntries.findIndex((entry) => entry.path === entryPath);
    expect(index).toBeGreaterThanOrEqual(0);
    const [deleted] = sourceEntries.splice(index, 1);
    for (const createdPath of [...createdFiles.keys()]) {
      if (
        createdPath === entryPath ||
        createdPath.startsWith(`${entryPath}/`)
      ) {
        createdFiles.delete(createdPath);
      }
    }
    await route.fulfill({ json: { data: deleted } });
  });
  await page.route("**/api/v1/environments/**/ide/file?*", async (route) => {
    const filePath = new URL(route.request().url()).searchParams.get("path");
    if (filePath === managedFile.path) {
      expect(route.request().method()).toBe("GET");
      await route.fulfill({ json: { data: managedFile } });
      return;
    }
    const createdFile = filePath ? createdFiles.get(filePath) : undefined;
    if (createdFile) {
      expect(route.request().method()).toBe("GET");
      await route.fulfill({ json: { data: createdFile } });
      return;
    }
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
  await page.addInitScript(() => {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value(command: string) {
        if (command.toLowerCase() !== "copy") return false;
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLTextAreaElement) {
          window.localStorage.setItem(
            "__sandpi_e2e_clipboard",
            activeElement.value,
          );
        }
        return true;
      },
    });
  });

  await page.goto(
    `/ide/?environment=${encodeURIComponent(environment.id)}&new=1`,
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
    page.locator('button[title="/workspace/.github"]'),
  ).toBeVisible();
  await expect(
    page.locator('button[title="/workspace/.sandpi"]'),
  ).toBeVisible();
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
  const demoFile = page.locator('button[title="/workspace/src/demo.ts"]');
  const directoryLoadsBeforeContextActions = directoryLoads;
  await sourceFolder.click({ button: "right" });
  const folderMenu = page.getByRole("menu", { name: "Actions for src" });
  await expect(folderMenu).toBeVisible();
  await folderMenu.getByRole("menuitem", { name: "Collapse Folder" }).click();
  await expect(demoFile).toBeHidden();

  await sourceFolder.focus();
  await page.keyboard.press("Shift+F10");
  await expect(folderMenu).toBeVisible();
  const expandFolder = folderMenu.getByRole("menuitem", {
    name: "Expand Folder",
  });
  await expect(
    folderMenu.getByRole("menuitem", { name: "New File" }),
  ).toBeFocused();
  await expandFolder.click();
  await expect(demoFile).toBeVisible();
  expect(directoryLoads).toBe(directoryLoadsBeforeContextActions);

  await sourceFolder.click({ button: "right" });
  await folderMenu.getByRole("menuitem", { name: "Refresh Folder" }).click();
  await expect
    .poll(() => directoryLoads)
    .toBeGreaterThan(directoryLoadsBeforeContextActions);

  await sourceFolder.click({ button: "right" });
  await folderMenu.getByRole("menuitem", { name: "New Folder" }).click();
  const newFolderName = page.getByRole("textbox", {
    name: "New folder in /workspace/src",
  });
  await expect(newFolderName).toBeFocused();
  await newFolderName.fill("components");
  await newFolderName.press("Enter");
  await expect(
    page.locator('button[title="/workspace/src/components"]'),
  ).toBeVisible();
  expect(createRequests.at(-1)).toEqual({
    parentPath: "/workspace/src",
    name: "components",
    kind: "folder",
  });
  const componentsFolder = page.locator(
    'button[title="/workspace/src/components"]',
  );
  await componentsFolder.click({ button: "right" });
  const componentsMenu = page.getByRole("menu", {
    name: "Actions for components",
  });
  await componentsMenu.getByRole("menuitem", { name: "Rename" }).click();
  const renameFolderName = page.getByRole("textbox", {
    name: "Rename /workspace/src/components",
  });
  await expect(renameFolderName).toHaveValue("components");
  await renameFolderName.fill("ui");
  await renameFolderName.press("Enter");
  const uiFolder = page.locator('button[title="/workspace/src/ui"]');
  await expect(uiFolder).toBeVisible();
  await expect(componentsFolder).toHaveCount(0);
  expect(renameRequests.at(-1)).toEqual({
    path: "/workspace/src/components",
    name: "ui",
  });

  await uiFolder.click({ button: "right" });
  const uiFolderMenu = page.getByRole("menu", { name: "Actions for ui" });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("and everything inside it");
    await dialog.accept();
  });
  await uiFolderMenu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(uiFolder).toHaveCount(0);
  expect(deleteRequests.at(-1)).toBe("/workspace/src/ui");

  await sourceFolder.click({ button: "right" });
  await folderMenu.getByRole("menuitem", { name: "New File" }).click();
  const newFileForm = page.getByRole("form", {
    name: "New file in /workspace/src",
  });
  const newFileName = newFileForm.getByRole("textbox");
  await newFileName.fill("demo.ts");
  await newFileName.press("Enter");
  await expect(newFileForm.getByRole("alert")).toHaveText(
    "“demo.ts” already exists in this folder.",
  );
  expect(createRequests).toHaveLength(1);
  await newFileName.fill("notes.md");
  await newFileName.press("Enter");
  await expect(
    page.locator('button[title="/workspace/src/notes.md"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /notes\.md/ }),
  ).toHaveAttribute("aria-selected", "true");
  expect(createRequests.at(-1)).toEqual({
    parentPath: "/workspace/src",
    name: "notes.md",
    kind: "file",
  });
  const notesFile = page.locator('button[title="/workspace/src/notes.md"]');
  const notesEditor = page.locator(".monaco-editor").first();
  await expect(notesEditor).toBeVisible();
  await notesEditor.click();
  await page.keyboard.insertText("# local notes\n");
  const notesSave = page.getByRole("button", { name: /Save file/ });
  await expect(notesSave).toBeEnabled();

  await notesFile.click({ button: "right" });
  const notesMenu = page.getByRole("menu", { name: "Actions for notes.md" });
  await notesMenu.getByRole("menuitem", { name: "Rename" }).click();
  const renameFileName = page.getByRole("textbox", {
    name: "Rename /workspace/src/notes.md",
  });
  await renameFileName.fill("renamed.md");
  await renameFileName.press("Enter");
  const renamedFile = page.locator(
    'button[title="/workspace/src/renamed.md"]',
  );
  await expect(renamedFile).toBeVisible();
  await expect(notesFile).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: /renamed\.md/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("# local notes")).toBeVisible();
  await expect(notesSave).toBeEnabled();
  await expect(page).toHaveURL(
    /path=%2Fworkspace%2Fsrc%2Frenamed\.md/,
  );
  expect(renameRequests.at(-1)).toEqual({
    path: "/workspace/src/notes.md",
    name: "renamed.md",
  });

  await renamedFile.click({ button: "right" });
  const renamedFileMenu = page.getByRole("menu", {
    name: "Actions for renamed.md",
  });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("1 open file has unsaved changes");
    await dialog.accept();
  });
  await renamedFileMenu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(renamedFile).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /renamed\.md/ })).toHaveCount(0);
  expect(deleteRequests.at(-1)).toBe("/workspace/src/renamed.md");

  await demoFile.focus();
  await page.keyboard.press("Shift+F10");
  const fileMenu = page.getByRole("menu", { name: "Actions for demo.ts" });
  await expect(fileMenu).toBeVisible();
  await expect(
    fileMenu.getByRole("menuitem", { name: "Open", exact: true }),
  ).toBeFocused();
  await expect(
    fileMenu.getByRole("menuitem", { name: "Open in New Tab" }),
  ).toHaveAttribute(
    "href",
    /path=%2Fworkspace%2Fsrc%2Fdemo\.ts/,
  );
  await page.keyboard.press("End");
  const copyRelativePath = fileMenu.getByRole("menuitem", {
    name: "Copy Relative Path",
  });
  await expect(copyRelativePath).toBeFocused();
  await copyRelativePath.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("__sandpi_e2e_clipboard"),
      ),
    )
    .toBe("src/demo.ts");
  await expect(demoFile).toBeFocused();

  await page.keyboard.press("Shift+F10");
  await expect(fileMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(fileMenu).toBeHidden();
  await expect(demoFile).toBeFocused();

  await demoFile.click({ button: "right" });
  await fileMenu.getByRole("menuitem", { name: "Copy Path" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("__sandpi_e2e_clipboard"),
      ),
    )
    .toBe("/workspace/src/demo.ts");
  await expect(page.getByRole("status")).toHaveText("Path copied");

  await demoFile.click({ button: "right" });
  const downloadPromise = page.waitForEvent("download");
  await fileMenu.getByRole("menuitem", { name: "Download" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("demo.ts");

  await demoFile.click();
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
  await expect(
    page.getByRole("button", { name: /^Share / }),
  ).toHaveCount(0);
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
  const managedFolder = page.locator('button[title="/workspace/.sandpi"]');
  await managedFolder.click({ button: "right" });
  const managedFolderMenu = page.getByRole("menu", {
    name: "Actions for .sandpi",
  });
  await expect(
    managedFolderMenu.getByRole("menuitem", { name: "New File" }),
  ).toHaveCount(0);
  await expect(
    managedFolderMenu.getByRole("menuitem", { name: "New Folder" }),
  ).toHaveCount(0);
  await expect(
    managedFolderMenu.getByRole("menuitem", { name: "Rename" }),
  ).toHaveCount(0);
  await expect(
    managedFolderMenu.getByRole("menuitem", { name: "Delete" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await managedFolder.click();
  const managedFileButton = page.locator(
    'button[title="/workspace/.sandpi/config.json"]',
  );
  await expect(managedFileButton).toBeVisible();
  await managedFileButton.click();
  await expect(
    page.getByText("Sandpi-managed files are read-only in the Web IDE."),
  ).toBeVisible();
  await expect(page.getByText('{"managed":true}')).toBeVisible();
  await expect(save).toBeDisabled();
  expect(managedDirectoryLoads).toBeGreaterThan(0);
  await expect.poll(() => pageBlocksUnload(page)).toBe(true);
  expect(browserErrors).toEqual([]);
});

test("renders verified image, audio, video and PDF Workspace previews", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  const environment = bootstrap.environments[0]!;
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = "";
  useEnglishUi(bootstrap);

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );

  const now = Date.now() / 1_000;
  const previewFiles: WorkspaceIdeFile[] = [
    {
      path: "/workspace/pixel.png",
      name: "pixel.png",
      revision: `sha256:${"1".repeat(43)}`,
      encoding: "base64",
      content:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      kind: "binary",
      preview: { kind: "image", mimeType: "image/png" },
      editable: false,
      readOnlyReason: "binary",
      size: "68 B",
      modifiedAt: now,
      lineChanges: [],
    },
    {
      path: "/workspace/tone.wav",
      name: "tone.wav",
      revision: `sha256:${"2".repeat(43)}`,
      encoding: "base64",
      content: Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.alloc(4),
        Buffer.from("WAVE"),
      ]).toString("base64"),
      kind: "binary",
      preview: { kind: "audio", mimeType: "audio/wav" },
      editable: false,
      readOnlyReason: "binary",
      size: "12 B",
      modifiedAt: now,
      lineChanges: [],
    },
    {
      path: "/workspace/demo.webm",
      name: "demo.webm",
      revision: `sha256:${"3".repeat(43)}`,
      encoding: "base64",
      content: Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        Buffer.from("webm"),
      ]).toString("base64"),
      kind: "binary",
      preview: { kind: "video", mimeType: "video/webm" },
      editable: false,
      readOnlyReason: "binary",
      size: "8 B",
      modifiedAt: now,
      lineChanges: [],
    },
    {
      path: "/workspace/guide.pdf",
      name: "guide.pdf",
      revision: `sha256:${"4".repeat(43)}`,
      encoding: "base64",
      content: Buffer.from("%PDF-1.7\n", "ascii").toString("base64"),
      kind: "binary",
      preview: { kind: "pdf", mimeType: "application/pdf" },
      editable: false,
      readOnlyReason: "binary",
      size: "9 B",
      modifiedAt: now,
      lineChanges: [],
    },
  ];
  const filesByPath = new Map(
    previewFiles.map((file) => [file.path, file] as const),
  );
  const snapshot: WorkspaceIdeSnapshot = {
    refreshedAt: now,
    files: [
      {
        id: "workspace",
        name: "workspace",
        path: "/workspace",
        kind: "folder",
        children: previewFiles.map((file) => ({
          id: file.name,
          name: file.name,
          path: file.path,
          kind: "file",
          size: file.size,
          modifiedAt: file.modifiedAt,
        })),
      },
    ],
    git: { repositories: [] },
  };

  await page.route("**/api/v1/environments/**/ide/file?*", async (route) => {
    const filePath = new URL(route.request().url()).searchParams.get("path");
    const file = filePath ? filesByPath.get(filePath) : undefined;
    if (!file) {
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
    await route.fulfill({ json: { data: file } });
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
    `/ide/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );

  await page.locator('button[title="/workspace/pixel.png"]').click();
  await expect(
    page.getByAltText("Image preview: pixel.png"),
  ).toBeVisible();
  await expect(page.getByText("PNG image", { exact: false })).toBeVisible();
  const imageViewer = page.getByRole("region", {
    name: "Image viewer: pixel.png",
  });
  const zoomLevel = page.getByLabel("Image zoom level");
  const zoomIn = page.getByRole("button", { name: "Zoom in (+)" });
  const zoomOut = page.getByRole("button", { name: "Zoom out (−)" });
  const fitImage = page.getByRole("button", {
    name: "Fit image to viewport (0)",
  });
  await expect(imageViewer).toHaveAttribute("data-zoom", "1");
  await expect(zoomLevel).toHaveText("100%");
  await expect(page.getByText("1 × 1 px", { exact: true })).toBeVisible();
  await expect(fitImage).toBeDisabled();
  const fittedImageWidth = await page
    .getByAltText("Image preview: pixel.png")
    .evaluate((image) => image.getBoundingClientRect().width);

  await zoomIn.click();
  await expect(imageViewer).toHaveAttribute("data-zoom", "1.25");
  await expect(zoomLevel).toHaveText("125%");
  await expect
    .poll(() =>
      page
        .getByAltText("Image preview: pixel.png")
        .evaluate((image) => image.getBoundingClientRect().width),
    )
    .toBeGreaterThan(fittedImageWidth * 1.2);
  await expect
    .poll(() =>
      imageViewer.evaluate(
        (viewer) =>
          viewer.scrollWidth > viewer.clientWidth &&
          viewer.scrollHeight > viewer.clientHeight &&
          viewer.scrollLeft > 0 &&
          viewer.scrollTop > 0,
      ),
    )
    .toBe(true);
  await imageViewer.focus();
  await page.keyboard.press("=");
  await expect(imageViewer).toHaveAttribute("data-zoom", "1.5");
  await page.keyboard.press("-");
  await expect(imageViewer).toHaveAttribute("data-zoom", "1.25");
  await zoomOut.click();
  await expect(imageViewer).toHaveAttribute("data-zoom", "1");
  await zoomOut.click();
  await expect(imageViewer).toHaveAttribute("data-zoom", "0.75");
  await fitImage.click();
  await expect(imageViewer).toHaveAttribute("data-zoom", "1");
  await expect(fitImage).toBeDisabled();

  await page.locator('button[title="/workspace/tone.wav"]').click();
  await expect(
    page.locator('audio[aria-label="Audio preview: tone.wav"]'),
  ).toBeVisible();

  await page.locator('button[title="/workspace/demo.webm"]').click();
  await expect(
    page.locator('video[aria-label="Video preview: demo.webm"]'),
  ).toBeVisible();

  await page.locator('button[title="/workspace/guide.pdf"]').click();
  await expect(
    page.locator('object[aria-label="PDF preview: guide.pdf"]'),
  ).toBeVisible();
  await expect(page.getByText("Read-only preview", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Binary files cannot be rendered as text."),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Save file/ }),
  ).toBeDisabled();
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
      }),
    );
  });

  await page.goto("/?environment=env-default&new=1");
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

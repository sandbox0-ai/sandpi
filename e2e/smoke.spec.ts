import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";

import type { ApiEnvelope } from "../src/lib/api-client";
import type {
  CodingSession,
  Environment,
  SandpiBootstrap,
  SandpiCloudSnapshot,
  WorkspaceDirectoryListing,
  WorkspaceIdeFile,
  WorkspaceIdeSnapshot,
} from "../src/lib/types";
import type {
  CodexEventEnvelope,
  CodexFileUpdateChange,
  CodexNativeSnapshot,
  CodexSession,
  CodexThread,
  CodexThreadItem,
  CodexTurn,
} from "../src/harnesses/codex/types";
import { PENDING_GUEST_PROMPT_STORAGE_KEY } from "../src/lib/auth-navigation";
import { BROWSER_DASHBOARD_SESSION_READY_MESSAGE } from "../src/lib/environment-browser";
import {
  getMockBootstrap,
  mockEnvironmentMetrics,
} from "../src/lib/mock-data";
import { LOCAL_UI_PREFERENCES_STORAGE_KEY } from "../src/lib/local-ui-preferences";

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
    appearance: {
      ...bootstrap.preferences.appearance,
      theme: "light",
    },
  };
}

async function installDarkUiPreferences(page: Page) {
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
  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      const response = await route.fetch();
      if (!response.ok()) {
        await route.fulfill({ response });
        return;
      }
      const body = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
      useEnglishUi(body.data);
      body.data.preferences.appearance.theme = "dark";
      await route.fulfill({ response, json: body });
    },
  );
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

async function pullNativeSurface(page: Page, selector: string) {
  await page.locator(selector).evaluate((target) => {
    const touch = (clientY: number) =>
      new Touch({
        identifier: 1,
        target,
        clientX: 180,
        clientY,
      });
    target.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [touch(72)],
        targetTouches: [touch(72)],
        changedTouches: [touch(72)],
      }),
    );
    target.dispatchEvent(
      new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [touch(240)],
        targetTouches: [touch(240)],
        changedTouches: [touch(240)],
      }),
    );
    target.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [touch(240)],
      }),
    );
  });
}

function codexTokenBreakdown(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
  };
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

test("reserves declared native titlebar space in the desktop sidebar", async ({
  page,
}) => {
  await serveAnonymousBootstrap(page);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");

  const brandRow = page.locator(".sidebar-brand-row");
  await expect(brandRow).toHaveCSS("padding-left", "17px");
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      "--sandpi-native-titlebar-leading-inset",
      "88px",
    );
  });
  await expect(brandRow).toHaveCSS("padding-left", "88px");

  const [brandBox, actionBox] = await Promise.all([
    brandRow.locator(".brand-lockup").boundingBox(),
    brandRow.locator(".sidebar-collapse-button").boundingBox(),
  ]);
  expect(brandBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect(brandBox!.x + brandBox!.width).toBeLessThanOrEqual(actionBox!.x);

  await brandRow.locator(".sidebar-collapse-button").click();
  const contentHeader = page.locator(
    "[data-native-titlebar-leading-content]",
  );
  await expect(contentHeader).toHaveCSS("padding-left", "88px");
  const expandBox = await contentHeader.locator("button").first().boundingBox();
  expect(expandBox).not.toBeNull();
  expect(expandBox!.x).toBeGreaterThanOrEqual(88);
});

test("separates anonymous New Session facts from the composer", async ({
  page,
}) => {
  await serveAnonymousBootstrap(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const gap = await page.locator(".composer-shell").evaluate((composer) => {
    const intro = composer.previousElementSibling;
    if (!(intro instanceof HTMLElement)) return null;
    return (
      composer.getBoundingClientRect().top -
      intro.getBoundingClientRect().bottom
    );
  });
  expect(gap).not.toBeNull();
  expect(gap!).toBeGreaterThanOrEqual(12);
});

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

test("keeps the disconnected Codex action compact on mobile", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const environment = bootstrap.environments[0];
  expect(environment).toBeTruthy();
  if (!environment) return;

  bootstrap.sessions = [];
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = "";
  environment.status = "ready";
  environment.codingAgent = {
    ...environment.codingAgent,
    status: "not-connected",
  };

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );

  await expect(
    page.locator(
      '#conversation > header[data-tauri-drag-region="deep"]',
    ),
  ).toBeVisible();
  const connectButton = page.getByRole("button", {
    name: "Connect Codex",
    exact: true,
  });
  await expect(connectButton).toBeVisible();
  const notice = connectButton.locator("..");
  const [noticeBox, buttonBox] = await Promise.all([
    notice.boundingBox(),
    connectButton.boundingBox(),
  ]);
  expect(noticeBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.width / noticeBox!.width).toBeLessThan(0.45);
  expect(buttonBox!.x).toBeGreaterThan(
    noticeBox!.x + noticeBox!.width / 2,
  );
});

test("pulls durable cloud state without reloading or losing a draft", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const environment = bootstrap.environments[0]!;
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = "";
  const cloudEnvironment = { ...environment };
  delete (cloudEnvironment as Partial<Environment>).sandboxState;
  const snapshot = {
    environments: [
      {
        ...cloudEnvironment,
        name: "Synced Environment",
        revision: environment.revision + 1,
      },
    ],
    sessions: bootstrap.sessions,
    preferences: bootstrap.preferences,
  } satisfies SandpiCloudSnapshot;
  const etag = '"e2e-cloud-state-v1"';
  let syncRequests = 0;
  const conditionalHeaders: Array<string | undefined> = [];

  await page.addInitScript(() => {
    (
      window as Window & {
        __sandpiNativeShellInstalled?: boolean;
      }
    ).__sandpiNativeShellInstalled = true;
  });
  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/sync",
    async (route) => {
      syncRequests += 1;
      conditionalHeaders.push(
        route.request().headers()["if-none-match"],
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (route.request().headers()["if-none-match"] === etag) {
        await route.fulfill({ status: 304, headers: { etag } });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { etag },
        json: { data: snapshot },
      });
    },
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  const composer = page.locator("textarea").first();
  await composer.fill("Keep this draft");
  await expect(page.getByTestId("native-pull-refresh")).toBeAttached();

  await pullNativeSurface(
    page,
    '#conversation > header[data-tauri-drag-region="deep"]',
  );
  await expect
    .poll(() => syncRequests)
    .toBe(1);
  await expect(composer).toHaveValue("Keep this draft");
  await expect(page).toHaveURL(/new=1/);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("button", {
      name: "Synced Environment",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("complementary", { name: "Sandpi navigation" })
    .getByRole("button", { name: "Close navigation" })
    .click();

  await pullNativeSurface(
    page,
    '#conversation > header[data-tauri-drag-region="deep"]',
  );
  await expect
    .poll(() => syncRequests)
    .toBe(2);
  expect(conditionalHeaders).toEqual([undefined, etag]);
  await expect(composer).toHaveValue("Keep this draft");
});

test("shows live native context usage inside the Session composer", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const session = bootstrap.sessions.find(
    (candidate) => candidate.harness === "codex" && !candidate.archived,
  );
  const environment = bootstrap.environments.find(
    (candidate) => candidate.id === session?.environmentId,
  );
  expect(session).toBeTruthy();
  expect(environment).toBeTruthy();
  if (!session || !environment || session.harness !== "codex") return;
  const codexSession = session as CodexSession;
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = session.id;

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.route(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${environment.id}/metrics/current`,
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            cpuUtilization: 0.075,
            memoryUtilization: 0.42,
          },
        },
      });
    },
  );

  const nativeSessionId = codexSession.harnessState.threadId;
  const snapshot: CodexNativeSnapshot = {
    protocol: "codex-app-server",
    nativeSessionId,
    historyRevision: codexSession.harnessState.historyRevision,
    modelId: codexSession.harnessState.modelId,
    reasoningEffort: codexSession.harnessState.reasoningEffort,
    sessionStatus: "waiting",
    tokenUsage: null,
    activity: {
      source: "codex-rollout",
      availability: "loading",
      records: [],
      error: null,
    },
    forkableTurnIds: [],
    thread: {
      id: nativeSessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: { type: "idle" },
      turns: [],
    },
  };
  const restoredUsage = {
    total: codexTokenBreakdown(59_000),
    last: codexTokenBreakdown(59_000),
    modelContextWindow: 200_000,
  };
  const liveUsage = {
    total: codexTokenBreakdown(106_000),
    last: codexTokenBreakdown(106_000),
    modelContextWindow: 200_000,
  };

  await installControlledEventSource(page);
  await page.route(
    "**/api/v1/environments/**/harnesses/codex/models",
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            data: [
              {
                id: snapshot.modelId,
                displayName: "E2E Codex Mobile Layout Stress Model",
                isDefault: true,
                defaultReasoningEffort: "high",
                supportedReasoningEfforts: [
                  {
                    reasoningEffort: "medium",
                    description: "Balanced reasoning",
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
            ],
          },
          meta: { availability: "available", source: "codex" },
        },
      });
    },
  );

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  const eventPath = `/api/v1/sessions/${session.id}/events`;
  await emitControlledEvent(page, eventPath, "snapshot", snapshot);
  await emitControlledEvent(page, eventPath, "activity", {
    nativeSessionId,
    historyRevision: snapshot.historyRevision,
    activity: {
      source: "codex-rollout",
      availability: "available",
      records: [],
      error: null,
    },
    tokenUsage: restoredUsage,
  });
  const composer = page.locator(".composer-shell");
  const cpuMeter = composer.getByRole("meter", {
    name: "Sandbox CPU utilization: 7.5%",
  });
  const memoryMeter = composer.getByRole("meter", {
    name: "Sandbox memory utilization: 42%",
  });
  await expect(cpuMeter).toContainText("CPU 7.5%");
  await expect(memoryMeter).toContainText("MEM 42%");
  await expect(
    composer.getByRole("meter", {
      name: "25% of the current context is used",
    }),
  ).toContainText("Context 25%");

  await emitControlledEvent(
    page,
    eventPath,
    "notification",
    {
      harness: "codex",
      harnessVersion: "e2e",
      protocolVersion: "v2",
      sequence: 1,
      receivedAt: session.updatedAt,
      notification: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: nativeSessionId,
          turnId: "turn-context-usage",
          tokenUsage: liveUsage,
        },
      },
    } satisfies CodexEventEnvelope,
  );
  const meter = composer.getByRole("meter", {
    name: "50% of the current context is used",
  });
  await expect(meter).toContainText("Context 50%");

  const [composerBox, cpuMeterBox, memoryMeterBox, meterBox] = await Promise.all([
    composer.boundingBox(),
    cpuMeter.boundingBox(),
    memoryMeter.boundingBox(),
    meter.boundingBox(),
  ]);
  expect(composerBox).not.toBeNull();
  for (const statusBox of [cpuMeterBox, memoryMeterBox, meterBox]) {
    expect(statusBox).not.toBeNull();
    expect(statusBox!.x).toBeGreaterThanOrEqual(composerBox!.x);
    expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(
      composerBox!.x + composerBox!.width,
    );
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(composer.locator("textarea")).toHaveCSS("font-size", "16px");
  await expect(composer).toHaveCSS("box-shadow", "none");
  const mobileToolIcons = await composer
    .locator(".composer-icon-button > svg")
    .evaluateAll((icons) =>
      icons.map((icon) => {
        const bounds = icon.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
    );
  expect(mobileToolIcons).toHaveLength(2);
  for (const icon of mobileToolIcons) {
    expect(icon.width).toBeGreaterThanOrEqual(17);
    expect(icon.height).toBeGreaterThanOrEqual(17);
  }
  const [mobileComposerBox, ...mobileStatusBoxes] = await Promise.all([
    composer.boundingBox(),
    cpuMeter.boundingBox(),
    memoryMeter.boundingBox(),
    meter.boundingBox(),
  ]);
  const [
    mobileToolsBox,
    mobileTelemetryBox,
    mobileAgentBox,
    mobileActionsBox,
    mobileModelBox,
    mobileEffortBox,
    mobileFastBox,
  ] = await Promise.all([
    composer.locator(".composer-tools").boundingBox(),
    composer.locator(".composer-telemetry").boundingBox(),
    composer.locator(".composer-agent-bound").boundingBox(),
    composer.locator(".composer-actions").boundingBox(),
    composer
      .getByRole("combobox", { name: "Select Codex model" })
      .boundingBox(),
    composer
      .getByRole("combobox", {
        name: "Select reasoning effort for E2E Codex Mobile Layout Stress Model",
      })
      .boundingBox(),
    composer.getByTestId("codex-fast-toggle").boundingBox(),
  ]);
  expect(mobileComposerBox).not.toBeNull();
  expect(mobileToolsBox).not.toBeNull();
  expect(mobileTelemetryBox).not.toBeNull();
  expect(mobileAgentBox).not.toBeNull();
  expect(mobileActionsBox).not.toBeNull();
  expect(mobileModelBox).not.toBeNull();
  expect(mobileEffortBox).not.toBeNull();
  expect(mobileFastBox).not.toBeNull();
  expect(mobileToolsBox!.x + mobileToolsBox!.width).toBeLessThanOrEqual(
    mobileTelemetryBox!.x + 1,
  );
  expect(
    Math.max(
      mobileToolsBox!.y + mobileToolsBox!.height,
      mobileTelemetryBox!.y + mobileTelemetryBox!.height,
    ),
  ).toBeLessThanOrEqual(
    Math.min(mobileAgentBox!.y, mobileActionsBox!.y) + 1,
  );
  for (const controlBox of [mobileModelBox, mobileEffortBox, mobileFastBox]) {
    expect(controlBox!.x).toBeGreaterThanOrEqual(mobileAgentBox!.x);
    expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(
      mobileAgentBox!.x + mobileAgentBox!.width,
    );
  }
  expect(mobileAgentBox!.x + mobileAgentBox!.width).toBeLessThanOrEqual(
    mobileActionsBox!.x + 1,
  );
  expect(mobileModelBox!.x + mobileModelBox!.width).toBeLessThanOrEqual(
    mobileEffortBox!.x + 1,
  );
  expect(mobileEffortBox!.x + mobileEffortBox!.width).toBeLessThanOrEqual(
    mobileFastBox!.x + 1,
  );

  for (const width of [320, 440, 680]) {
    await page.setViewportSize({ width, height: 844 });
    const [responsiveComposer, responsiveAgent, responsiveActions, responsiveModel] =
      await Promise.all([
        composer.boundingBox(),
        composer.locator(".composer-agent-bound").boundingBox(),
        composer.locator(".composer-actions").boundingBox(),
        composer
          .getByRole("combobox", { name: "Select Codex model" })
          .boundingBox(),
      ]);
    expect(responsiveComposer).not.toBeNull();
    expect(responsiveAgent).not.toBeNull();
    expect(responsiveActions).not.toBeNull();
    expect(responsiveModel).not.toBeNull();
    expect(responsiveAgent!.x).toBeGreaterThanOrEqual(responsiveComposer!.x);
    expect(
      responsiveAgent!.x + responsiveAgent!.width,
    ).toBeLessThanOrEqual(responsiveActions!.x + 1);
    expect(responsiveModel!.width).toBeLessThanOrEqual(121);
    expect(
      responsiveActions!.x + responsiveActions!.width,
    ).toBeLessThanOrEqual(responsiveComposer!.x + responsiveComposer!.width);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await composer
    .getByRole("button", { name: "Mention a Workspace file" })
    .click();
  await expect(composer).toHaveCSS("box-shadow", "none");
  const mentionPopover = composer.locator(".composer-mention-popover");
  await expect(mentionPopover).toBeVisible();
  expect(
    await mentionPopover.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + 10,
      );
      return hit !== null && element.contains(hit);
    }),
  ).toBe(true);
  for (const statusBox of mobileStatusBoxes) {
    expect(statusBox).not.toBeNull();
    expect(statusBox!.x).toBeGreaterThanOrEqual(mobileTelemetryBox!.x);
    expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(
      mobileTelemetryBox!.x + mobileTelemetryBox!.width,
    );
  }
  for (let index = 0; index < mobileStatusBoxes.length - 1; index += 1) {
    const current = mobileStatusBoxes[index]!;
    const next = mobileStatusBoxes[index + 1]!;
    expect(current!.x + current!.width).toBeLessThanOrEqual(next!.x + 1);
  }
  const lastStatusBox = mobileStatusBoxes.at(-1)!;
  expect(
    Math.abs(
      lastStatusBox.x +
        lastStatusBox.width -
        (mobileTelemetryBox!.x + mobileTelemetryBox!.width),
    ),
  ).toBeLessThanOrEqual(1);
});

test("restores a recent Session snapshot and draft without reloading Environment models", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const sessions = bootstrap.sessions.filter(
    (candidate): candidate is CodexSession =>
      candidate.harness === "codex" &&
      candidate.environmentId === "env-default" &&
      !candidate.archived,
  );
  const [firstSession, secondSession] = sessions;
  const environment = bootstrap.environments.find(
    (candidate) => candidate.id === firstSession?.environmentId,
  );
  expect(firstSession).toBeTruthy();
  expect(secondSession).toBeTruthy();
  expect(environment).toBeTruthy();
  if (!firstSession || !secondSession || !environment) return;
  firstSession.status = "waiting";
  firstSession.unread = false;
  secondSession.status = "waiting";
  secondSession.unread = false;
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = firstSession.id;

  const snapshotFor = (
    session: CodexSession,
    assistantText: string,
  ): CodexNativeSnapshot => {
    const now = Date.now() / 1_000;
    const turn: CodexTurn = {
      id: `turn-${session.id}`,
      items: [
        {
          type: "userMessage",
          id: `user-${session.id}`,
          clientId: `client-${session.id}`,
          content: [
            {
              type: "text",
              text: session.title,
              text_elements: [],
            },
          ],
        },
        {
          type: "agentMessage",
          id: `assistant-${session.id}`,
          text: assistantText,
          phase: null,
          memoryCitation: null,
        },
      ],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: now,
      completedAt: now + 1,
      durationMs: 1_000,
    };
    return {
      protocol: "codex-app-server",
      nativeSessionId: session.harnessState.threadId,
      historyRevision: session.harnessState.historyRevision,
      modelId: session.harnessState.modelId,
      reasoningEffort: session.harnessState.reasoningEffort,
      sessionStatus: "waiting",
      tokenUsage: null,
      activity: {
        source: "codex-rollout",
        availability: "available",
        records: [],
        error: null,
      },
      forkableTurnIds: [turn.id],
      thread: {
        id: session.harnessState.threadId,
        createdAt: now,
        updatedAt: now + 1,
        status: { type: "idle" },
        turns: [turn],
      },
    };
  };
  const firstSnapshot = snapshotFor(
    firstSession,
    "First Session response from the native snapshot.",
  );
  const secondSnapshot = snapshotFor(
    secondSession,
    "Second Session response from the native snapshot.",
  );
  let modelRequests = 0;
  let sessionReads = 0;

  await installControlledEventSource(page);
  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.route(
    (url) => /^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname),
    async (route) => {
      sessionReads += 1;
      const sessionId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-1) ?? "",
      );
      const session = bootstrap.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      await route.fulfill({
        status: session ? 200 : 404,
        json: session
          ? { data: session }
          : {
              error: {
                code: "session_not_found",
                message: "Session not found.",
              },
            },
      });
    },
  );
  await page.route(
    "**/api/v1/environments/**/harnesses/codex/models",
    async (route) => {
      modelRequests += 1;
      await route.fulfill({
        json: {
          data: {
            data: [
              {
                id: firstSnapshot.modelId,
                displayName: "E2E cached model",
                isDefault: true,
                supportedReasoningEfforts: [],
              },
            ],
          },
          meta: { availability: "available", source: "codex" },
        },
      });
    },
  );
  await page.route("**/api/v1/environments/**/metrics/current", async (route) => {
    await route.fulfill({
      json: {
        data: { cpuUtilization: 0.1, memoryUtilization: 0.2 },
      },
    });
  });

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(firstSession.id)}`,
  );
  await emitControlledEvent(
    page,
    `/api/v1/sessions/${firstSession.id}/events`,
    "snapshot",
    firstSnapshot,
  );
  await expect(
    page.getByText("First Session response from the native snapshot."),
  ).toBeVisible();
  const composer = page.getByPlaceholder(
    "Ask Codex to work in this session…",
  );
  await composer.fill("Keep this draft with the first Session");

  await page
    .locator(".session-main-button")
    .filter({ hasText: secondSession.title })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`session=${encodeURIComponent(secondSession.id)}`),
  );
  await expect(page.getByText("Loading conversation…")).toBeVisible();
  await emitControlledEvent(
    page,
    `/api/v1/sessions/${secondSession.id}/events`,
    "snapshot",
    secondSnapshot,
  );
  await expect(
    page.getByText("Second Session response from the native snapshot."),
  ).toBeVisible();
  await expect(composer).toHaveValue("");

  await page
    .locator(".session-main-button")
    .filter({ hasText: firstSession.title })
    .click();
  await expect(
    page.getByText("First Session response from the native snapshot."),
  ).toBeVisible();
  await expect(composer).toHaveValue(
    "Keep this draft with the first Session",
  );
  await expect(page.getByText("Checking Codex runtime")).toBeVisible();
  expect(modelRequests).toBe(1);
  expect(sessionReads).toBe(0);
});

test("uses the Sandpi logo and sidebar viewer avatar in conversation messages", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  bootstrap.viewer.avatarInitials = "SP";
  const session = bootstrap.sessions.find(
    (candidate) => candidate.harness === "codex" && !candidate.archived,
  );
  const environment = bootstrap.environments.find(
    (candidate) => candidate.id === session?.environmentId,
  );
  expect(session).toBeTruthy();
  expect(environment).toBeTruthy();
  if (!session || !environment || session.harness !== "codex") return;
  const codexSession = session as CodexSession;
  session.status = "waiting";
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = session.id;

  const nativeSessionId = codexSession.harnessState.threadId;
  const now = Date.now() / 1_000;
  const turn: CodexTurn = {
    id: "turn-avatar-e2e",
    items: [
      {
        type: "userMessage",
        id: "user-avatar-e2e",
        clientId: "client-avatar-e2e",
        content: [
          {
            type: "text",
            text: "Show the conversation identities.",
            text_elements: [],
          },
        ],
      },
      {
        type: "agentMessage",
        id: "assistant-avatar-e2e",
        text: "The shared avatars are visible.",
        phase: null,
        memoryCitation: null,
      },
    ],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: now,
    completedAt: now + 1,
    durationMs: 1_000,
  };
  const snapshot: CodexNativeSnapshot = {
    protocol: "codex-app-server",
    nativeSessionId,
    historyRevision: codexSession.harnessState.historyRevision,
    modelId: codexSession.harnessState.modelId,
    reasoningEffort: codexSession.harnessState.reasoningEffort,
    sessionStatus: "waiting",
    tokenUsage: null,
    activity: {
      source: "codex-rollout",
      availability: "available",
      records: [],
      error: null,
    },
    forkableTurnIds: [turn.id],
    thread: {
      id: nativeSessionId,
      createdAt: now,
      updatedAt: now + 1,
      status: { type: "idle" },
      turns: [turn],
    },
  };

  await installControlledEventSource(page);
  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.route(
    "**/api/v1/environments/**/harnesses/codex/models",
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            data: [
              {
                id: snapshot.modelId,
                displayName: "E2E avatar model",
                isDefault: true,
                supportedReasoningEfforts: [],
              },
            ],
          },
          meta: { availability: "available", source: "codex" },
        },
      });
    },
  );
  await page.route("**/api/v1/environments/**/metrics/current", async (route) => {
    await route.fulfill({
      json: {
        data: { cpuUtilization: 0.1, memoryUtilization: 0.2 },
      },
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await emitControlledEvent(
    page,
    `/api/v1/sessions/${session.id}/events`,
    "snapshot",
    snapshot,
  );
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("left", "0px");

  const sidebarAvatar = page.locator(
    ".account-menu-trigger .account-avatar",
  );
  const messageAvatar = page.locator(
    ".message-user .account-avatar.user-avatar",
  );
  await expect(sidebarAvatar).toHaveText("SP");
  await expect(messageAvatar).toHaveText("SP");

  const sidebarBrandMark = page.locator(
    ".sidebar .brand-lockup .brand-mark",
  );
  await expect(sidebarBrandMark).toBeVisible();
  await expect(sidebarBrandMark).toHaveCSS("width", "21px");
  await expect(sidebarBrandMark).toHaveCSS("height", "21px");
  await expect(sidebarBrandMark.locator(".sandpi-mark-bubble")).toHaveCSS(
    "background-color",
    "rgb(23, 23, 22)",
  );
  await expect(sidebarBrandMark.locator(".sandpi-mark-eye-left")).toHaveCSS(
    "background-color",
    "rgb(239, 238, 233)",
  );

  const avatarVisualStyle = async (
    locator: ReturnType<Page["locator"]>,
  ) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: style.width,
        height: style.height,
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
      };
    });
  expect(await avatarVisualStyle(messageAvatar)).toEqual(
    await avatarVisualStyle(sidebarAvatar),
  );

  const assistantAvatar = page
    .locator(".message-assistant .assistant-avatar")
    .filter({ has: page.locator(".sandpi-mark") });
  await expect(assistantAvatar).toHaveAttribute("aria-label", "Sandpi");
  const assistantMark = assistantAvatar.locator(
    ".sandpi-mark.assistant-avatar-mark",
  );
  await expect(assistantMark).toBeVisible();
  await expect(assistantMark.locator(".sandpi-mark-eye-right")).toBeVisible();
  await expect(assistantAvatar).toHaveCSS("border-top-width", "0px");
  await expect(assistantAvatar).toHaveCSS("padding-top", "0px");
  await expect(assistantAvatar).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const [assistantAvatarBox, assistantMarkBox] = await Promise.all([
    assistantAvatar.boundingBox(),
    assistantMark.boundingBox(),
  ]);
  expect(assistantAvatarBox).not.toBeNull();
  expect(assistantMarkBox).toEqual(assistantAvatarBox);

  await page.locator("html").evaluate((element) => {
    element.setAttribute("data-resolved-theme", "dark");
    element.style.setProperty("--canvas", "#181817");
    element.style.setProperty("--sidebar", "#20201e");
    element.style.setProperty("--ink", "#f0efe9");
  });
  await expect(sidebarBrandMark.locator(".sandpi-mark-bubble")).toHaveCSS(
    "background-color",
    "rgb(240, 239, 233)",
  );
  await expect(sidebarBrandMark.locator(".sandpi-mark-eye-left")).toHaveCSS(
    "background-color",
    "rgb(32, 32, 30)",
  );
});

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
  await page.setViewportSize({ width: 390, height: 844 });
  const guestComposer = page.locator(".composer-shell", { has: composer });
  const [guestToolsBox, guestSendAreaBox] = await Promise.all([
    guestComposer.locator(".composer-tools").boundingBox(),
    guestComposer.locator(".composer-send-area").boundingBox(),
  ]);
  expect(guestToolsBox).not.toBeNull();
  expect(guestSendAreaBox).not.toBeNull();
  expect(Math.max(guestToolsBox!.y, guestSendAreaBox!.y)).toBeLessThan(
    Math.min(
      guestToolsBox!.y + guestToolsBox!.height,
      guestSendAreaBox!.y + guestSendAreaBox!.height,
    ),
  );
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

test("synchronizes the anonymous mobile sidebar with native chrome", async ({
  page,
}) => {
  await serveAnonymousBootstrap(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      canvas: style.getPropertyValue("--canvas").trim(),
      sidebar: style.getPropertyValue("--sidebar").trim(),
    };
  });
  const topColor = page.locator(
    'meta[name="sandpi-native-top-color"]',
  );
  const bottomColor = page.locator(
    'meta[name="sandpi-native-bottom-color"]',
  );
  await expect(topColor).toHaveAttribute("content", colors.canvas);
  await expect(bottomColor).toHaveAttribute("content", colors.canvas);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("left", "0px");
  await expect(topColor).toHaveAttribute("content", colors.sidebar);
  await expect(bottomColor).toHaveAttribute("content", colors.sidebar);

  await page
    .getByRole("complementary", { name: "Sandpi navigation" })
    .getByRole("button", { name: "Close navigation" })
    .click();
  await expect(topColor).toHaveAttribute("content", colors.canvas);
  await expect(bottomColor).toHaveAttribute("content", colors.canvas);
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

test("keeps a guest draft when login starts from the account action", async ({
  page,
}) => {
  await serveAnonymousBootstrap(page);
  const loginRequestUrl = await captureLoginNavigation(page);

  await page.goto("/");
  const appUrl = page.url();
  const pendingPrompt = "Keep this draft when I sign in";
  await page
    .getByPlaceholder("Ask Codex to work on something…")
    .fill(pendingPrompt);
  await page.getByRole("button", { name: "Log in or sign up" }).click();
  await expect.poll(loginRequestUrl).toBeTruthy();

  const loginRequest = new URL(loginRequestUrl()!);
  expect(loginRequest.searchParams.get("return_to")).toBe(
    new URL("/?new=1", appUrl).toString(),
  );
  expect(
    await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      PENDING_GUEST_PROMPT_STORAGE_KEY,
    ),
  ).toBe(pendingPrompt);
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
    page.getByText(
      "iOS · Android · HarmonyOS · Windows · macOS coming soon",
    ),
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

test("replaces the Environment idle timeout after clearing the number input", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const environment = bootstrap.environments[0];
  expect(environment).toBeTruthy();
  if (!environment) return;
  bootstrap.sessions = [];
  bootstrap.selectedSessionId = "";
  environment.idlePauseTimeoutSeconds = 30 * 60;
  environment.codingAgent = {
    harness: "codex",
    label: "Codex",
    status: "not-connected",
  };

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/billing/summary",
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            plan: {
              id: "deployment",
              name: "Deployment",
              memoryConfigurable: true,
            },
          },
        },
      });
    },
  );
  await page.route(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/workspace-backups`,
    async (route) => {
      await route.fulfill({ json: { data: [] } });
    },
  );
  await page.route(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/device-login`,
    async (route) => {
      await route.fulfill({ json: { data: null } });
    },
  );
  let updateBody: Record<string, unknown> | undefined;
  await page.route(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}`,
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      updateBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        json: {
          data: {
            ...environment,
            idlePauseTimeoutSeconds: updateBody.idlePauseTimeoutSeconds,
          },
        },
      });
    },
  );

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  await page
    .getByRole("button", { name: `${environment.name} settings` })
    .click();
  await page.getByRole("button", { name: "Sandbox", exact: true }).click();

  const idleInput = page.getByRole("spinbutton", {
    name: "Environment auto-pause timeout in minutes",
  });
  const saveButton = page.getByRole("button", { name: "Save changes" });
  await expect(idleInput).toHaveValue("30");
  await idleInput.press("ControlOrMeta+A");
  await idleInput.press("Backspace");
  await expect(idleInput).toHaveValue("");
  await expect(saveButton).toBeDisabled();
  await idleInput.pressSequentially("15");
  await expect(idleInput).toHaveValue("15");
  await expect(saveButton).toBeEnabled();

  await saveButton.click();
  await expect.poll(() => updateBody?.idlePauseTimeoutSeconds).toBe(15 * 60);
});

test("opens Environment settings from the Inspector and controls Sandbox recovery", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const environment = bootstrap.environments[0];
  expect(environment).toBeTruthy();
  if (!environment) return;
  bootstrap.sessions = [];
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = "";
  environment.sandboxState = "running";

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/billing/summary",
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            plan: {
              id: "deployment",
              name: "Deployment",
              memoryConfigurable: true,
            },
          },
        },
      });
    },
  );
  await page.route(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/workspace-backups`,
    async (route) => {
      await route.fulfill({ json: { data: [] } });
    },
  );
  const lifecycleRequests: string[] = [];
  for (const action of ["pause", "restart"] as const) {
    await page.route(
      (url) =>
        url.pathname ===
        `/api/v1/environments/${encodeURIComponent(environment.id)}/sandbox/${action}`,
      async (route) => {
        lifecycleRequests.push(`${route.request().method()} ${action}`);
        await route.fulfill({
          json: {
            data: {
              ...environment,
              sandboxState: action === "pause" ? "paused" : "running",
            },
          },
        });
      },
    );
  }

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  await page.getByRole("button", { name: "Open inspector" }).click();
  const inspectorViews = page.getByRole("navigation", {
    name: "Inspector views",
  });
  const filesTab = inspectorViews.getByRole("button", {
    name: "Files",
    exact: true,
  });
  const settingsAction = inspectorViews.getByRole("button", {
    name: "Open Environment settings",
  });
  await expect(filesTab).toHaveClass(/is-active/);
  await expect(settingsAction).not.toHaveClass(/is-active/);

  await settingsAction.click();
  await expect(
    page.getByRole("dialog", { name: `${environment.name} settings` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sandbox", exact: true }).click();

  const sandboxState = page.locator(".sandbox-lifecycle-state");
  await expect(sandboxState).toHaveText("Running");
  await page.getByRole("button", { name: "Pause Sandbox" }).click();
  await expect(
    page.getByRole("group", { name: "Confirm Sandbox pause" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm pause" }).click();
  await expect(sandboxState).toHaveText("Paused");
  await expect(
    page.getByText("Sandbox paused.", { exact: false }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Restart Sandbox" }).click();
  await expect(
    page.getByRole("group", { name: "Confirm Sandbox restart" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm restart" }).click();
  await expect(sandboxState).toHaveText("Running");
  await expect(
    page.getByText("Sandbox restarted.", { exact: false }),
  ).toBeVisible();
  expect(lifecycleRequests).toEqual(["PUT pause", "PUT restart"]);

  await page
    .getByRole("button", { name: "Close Environment settings" })
    .click();
  await expect(filesTab).toHaveClass(/is-active/);
  await expect(settingsAction).not.toHaveClass(/is-active/);
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
  let browserSessionStarts = 0;
  const browserViewports: Array<{ width: number; height: number }> = [];
  await page.route(
    (url) =>
      url.pathname.startsWith(
        `/api/v1/environments/${encodeURIComponent(environment.id)}/browser`,
      ),
    async (route) => {
      if (route.request().url().endsWith("/browser/session")) {
        browserSessionStarts += 1;
        await route.fulfill({ status: 204 });
        return;
      }
      if (route.request().url().endsWith("/browser/viewport")) {
        browserViewports.push(
          route.request().postDataJSON() as {
            width: number;
            height: number;
          },
        );
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html>
          <p>Official Playwright Dashboard fixture</p>
          <script>
            let tabs = [{
              index: 0,
              title: "Fixture tab",
              url: "https://example.test/",
              selected: true,
            }];
            const post = (message) => parent.postMessage(message, "*");
            const postTabs = () => post({
              type: "sandpi:browser-dashboard-tabs",
              integrated: true,
              tabs,
            });
            const finishActivity = () => setTimeout(() => post({
              type: "sandpi:browser-dashboard-loading",
              loading: false,
            }), 400);
            addEventListener("message", (event) => {
              const message = event.data;
              if (message?.type === "sandpi:browser-dashboard-viewport-mode") {
                const viewport = message.mode === "mobile"
                  ? { width: 390, height: 844 }
                  : message.mode === "responsive"
                    ? { width: 640, height: 700 }
                    : { width: 1280, height: 800 };
                post({
                  type: "sandpi:browser-dashboard-viewport",
                  ...viewport,
                });
              }
              if (message?.type !== "sandpi:browser-dashboard-command") return;
              post({
                type: "sandpi:browser-dashboard-loading",
                loading: true,
              });
              if (message.action === "new") {
                tabs = tabs.map((tab) => ({ ...tab, selected: false }));
                tabs.push({
                  index: tabs.length,
                  title: "New Tab",
                  url: "about:blank",
                  selected: true,
                });
              } else if (message.action === "select") {
                tabs = tabs.map((tab) => ({
                  ...tab,
                  selected: tab.index === message.index,
                }));
              } else if (message.action === "close" && tabs.length > 1) {
                const selected = tabs[message.index]?.selected;
                tabs.splice(message.index, 1);
                tabs = tabs.map((tab, index) => ({ ...tab, index }));
                if (selected) tabs[0].selected = true;
              }
              postTabs();
              finishActivity();
            });
            post({ type: "sandpi:browser-dashboard-ready" });
            post({ type: "sandpi:browser-dashboard-session-ready" });
            postTabs();
          </script>`,
      });
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
  const browserView = inspectorViews.getByRole("button", {
    name: "Browser",
    exact: true,
  });
  await expect(browserView).toBeVisible();
  await expect(
    inspectorViews.getByRole("button", { name: "Activity", exact: true }),
  ).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: "Close inspector" }),
  ).toHaveAttribute("aria-pressed", "true");

  await browserView.click();
  await expect(
    page
      .frameLocator('iframe[title="Shared Environment browser"]')
      .getByText("Official Playwright Dashboard fixture"),
  ).toBeVisible();
  expect(browserSessionStarts).toBe(0);
  await expect(
    page.getByRole("tab", { name: "Fixture tab", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("combobox", { name: "Browser viewport" }),
  ).toHaveValue("desktop");
  await expect.poll(() => browserViewports.at(-1)).toEqual({
    width: 1280,
    height: 800,
  });

  const browserFrame = page.locator(
    'iframe[title="Shared Environment browser"]',
  );
  const browserPanel = page.locator(".browser-panel");
  const filesPanel = page.locator(".files-panel");
  await expect(browserFrame).toHaveCount(1);
  await expect(browserPanel).toBeVisible();
  await expect(filesPanel).toBeHidden();
  await inspectorViews
    .getByRole("button", { name: "Files", exact: true })
    .click();
  await expect(browserFrame).toHaveCount(1);
  await expect(browserFrame).toBeHidden();
  await expect(browserPanel).toBeHidden();
  await expect(filesPanel).toBeVisible();
  await browserView.click();
  await expect(browserFrame).toBeVisible();
  await expect(browserPanel).toBeVisible();
  await expect(filesPanel).toBeHidden();
  expect(browserSessionStarts).toBe(0);

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(page.getByRole("tab", { name: "New Tab" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".environment-browser-toolbar")).toHaveClass(
    /is-loading/,
  );
  await page.getByRole("tab", { name: "Fixture tab", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Fixture tab", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Close New Tab" }).click();
  await expect(page.getByRole("tab", { name: "New Tab" })).toHaveCount(0);

  await page
    .getByRole("combobox", { name: "Browser viewport" })
    .selectOption("responsive");
  await expect.poll(() => browserViewports.at(-1)).toEqual({
    width: 640,
    height: 700,
  });
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(window.localStorage.getItem(key) ?? "{}").workspace
            ?.browserViewportMode,
        LOCAL_UI_PREFERENCES_STORAGE_KEY,
      ),
    )
    .toBe("responsive");

  await header.getByRole("button", { name: "Close inspector" }).click();
  await expect(inspectorViews).toBeHidden();
  await expect(
    header.getByRole("button", { name: "Open inspector" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(browserFrame).toHaveCount(1);
  await expect(browserFrame).toBeHidden();

  await header.getByRole("button", { name: "Open inspector" }).click();
  await expect(browserFrame).toBeVisible();
  expect(browserSessionStarts).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inspectorViews).toBeHidden();
  await header.getByRole("button", { name: "Open inspector" }).click();
  await expect(inspectorViews).toBeVisible();
  const panelColor = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--panel")
      .trim(),
  );
  await expect(
    page.locator('meta[name="sandpi-native-top-color"]'),
  ).toHaveAttribute("content", panelColor);
  await expect(
    page.locator('meta[name="sandpi-native-bottom-color"]'),
  ).toHaveAttribute("content", panelColor);

  await page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("button", { name: "Close inspector" })
    .click();
  const canvasColor = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--canvas")
      .trim(),
  );
  await expect(
    page.locator('meta[name="sandpi-native-top-color"]'),
  ).toHaveAttribute("content", canvasColor);
  await expect(
    page.locator('meta[name="sandpi-native-bottom-color"]'),
  ).toHaveAttribute("content", canvasColor);
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
    accountMenu.getByText(
      "iOS · Android · HarmonyOS · Windows · macOS coming soon",
    ),
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

  await installDarkUiPreferences(page);
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
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "dark",
  );
  const parentAgentMessage = agentDialog.locator(
    'article[data-role="user"] .markdown-content',
  );
  await expect(parentAgentMessage).toHaveCSS(
    "background-color",
    "rgb(32, 56, 42)",
  );
  await expect(parentAgentMessage).toHaveCSS(
    "color",
    "rgb(240, 239, 233)",
  );
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
  await expect(agentDialog).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Codex conversation" })
      .getByRole("alert"),
  ).toContainText("Unknown command /subagents");

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
  await page.route(
    "**/api/v1/environments/**/harnesses/codex/models",
    async (route) => {
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
    },
  );
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
  await emitControlledEvent(
    page,
    eventPath,
    "notification",
    envelope({
      method: "item/completed",
      params: {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        item: completedCommand,
        completedAtMs: now * 1_000 + 250,
      },
    }),
  );
  const finalMessageText = "## The ordering is stable.\n\n- Streamed Markdown";
  const streamingFinalMessage: CodexThreadItem = {
    type: "agentMessage",
    id: "native-final-e2e-order",
    text: "",
    phase: null,
    memoryCitation: null,
  };
  await emitControlledEvent(
    page,
    eventPath,
    "notification",
    envelope({
      method: "item/started",
      params: {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        item: streamingFinalMessage,
        startedAtMs: now * 1_000 + 300,
      },
    }),
  );
  await emitControlledEvent(
    page,
    eventPath,
    "notification",
    envelope({
      method: "item/agentMessage/delta",
      params: {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        itemId: streamingFinalMessage.id,
        delta: finalMessageText,
      },
    }),
  );
  const streamingAssistant = page.locator(
    ".message-column > .message-assistant",
  );
  await expect(streamingAssistant.locator("h2")).toHaveText(
    "The ordering is stable.",
  );
  await expect(
    activityDetails.locator(".message-assistant"),
  ).toHaveCount(0);

  const finalMessage: CodexThreadItem = {
    ...streamingFinalMessage,
    text: finalMessageText,
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
    page.getByRole("heading", {
      name: "The ordering is stable.",
      exact: true,
    }),
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
  await page.route(
    "**/api/v1/environments/**/harnesses/codex/models",
    async (route) => {
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
    },
  );
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

test("opens Environment file and loopback links in their native inspectors", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const session = bootstrap.sessions.find(
    (candidate) => candidate.harness === "codex" && !candidate.archived,
  );
  const environment = bootstrap.environments.find(
    (candidate) => candidate.id === session?.environmentId,
  );
  test.skip(!session || !environment, "A Codex Session is required.");
  if (!session || !environment) return;
  test.skip(session.harness !== "codex", "A Codex Session is required.");
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = session.id;
  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  const now = Date.now() / 1_000;
  const nativeThreadId = "thread-e2e-workspace-links";
  const nativeTurnId = "turn-e2e-workspace-links";
  const globalsPath = "/workspace/app/globals.css";
  const pagePath = "/workspace/app/page.tsx";
  const directoryRequests: string[] = [];
  const fileRequests: string[] = [];
  const watchSubscriptions: string[][] = [];
  let releaseDirectoryListings: () => void = () => undefined;
  const directoryListingsReleased = new Promise<void>((resolve) => {
    releaseDirectoryListings = resolve;
  });
  let browserOpenBody: unknown;
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
                `[page.tsx](${pagePath}), then inspect ` +
                `[the app](localhost:3000/preview).`,
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
  await page.route(
    "**/api/v1/environments/**/harnesses/codex/models",
    async (route) => {
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
    },
  );
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
    await directoryListingsReleased;
    if (directoryPath === "/workspace") {
      await route.fulfill({
        json: {
          data: {
            path: "/workspace",
            refreshedAt: now,
            entries: ideSnapshot.files[0]?.children ?? [],
          },
        },
      });
      return;
    }
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
  await page.route("**/api/v1/environments/**/ide/git", async (route) => {
    await route.fulfill({ json: { data: ideSnapshot.git } });
  });
  await page.route("**/api/v1/environments/**/ide", async (route) => {
    await route.fulfill({ json: { data: ideSnapshot } });
  });
  await page.routeWebSocket(
    (url) =>
      url.pathname ===
      `/api/v1/environments/${encodeURIComponent(environment.id)}/ide/events`,
    (socket) => {
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as {
          type?: string;
          paths?: string[];
        };
        if (message.type === "subscribe" && message.paths) {
          watchSubscriptions.push(message.paths);
        }
      });
      socket.send(JSON.stringify({ type: "ready", at: now }));
    },
  );
  await page.route(
    (url) =>
      url.pathname.startsWith(
        `/api/v1/environments/${encodeURIComponent(environment.id)}/browser`,
      ),
    async (route) => {
      if (route.request().url().endsWith("/browser/open")) {
        browserOpenBody = route.request().postDataJSON();
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><p>Shared Browser fixture</p><script>window.parent.postMessage({type:${JSON.stringify(
          BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
        )}}, "*")</script>`,
      });
    },
  );

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  await expect(page.getByText("Loading conversation…")).toBeHidden();

  await page.locator(`[data-workspace-path="${globalsPath}"]`).click();
  await expect(
    page.getByText("workspace / app/globals.css", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("globals.css", { exact: true })).toBeVisible();
  await expect.poll(() => fileRequests).toContain(globalsPath);
  releaseDirectoryListings();

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
    workspaceTree.locator(`button[title="${globalsPath}"]`),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    workspaceTree.locator('button[title="/workspace/app"]'),
  ).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("path"))
    .toBe(globalsPath);
  await expect.poll(() => directoryRequests).toContain("/workspace/app");
  await expect
    .poll(() =>
      watchSubscriptions.some((paths) => paths.includes("/workspace/app")),
    )
    .toBe(true);

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
  expect(new Set(directoryRequests)).toEqual(
    new Set(["/workspace", "/workspace/app"]),
  );
  expect(directoryRequests.filter((path) => path === "/workspace")).toHaveLength(
    1,
  );
  expect(
    directoryRequests.filter((path) => path === "/workspace/app"),
  ).toHaveLength(1);

  const fileBrowserResizeHandle = page.getByRole("separator", {
    name: "Resize file browser",
  });
  const initialFileBrowserWidth = (await workspaceTree.boundingBox())!.width;
  const fileBrowserResizeHandleBox =
    await fileBrowserResizeHandle.boundingBox();
  expect(fileBrowserResizeHandleBox).not.toBeNull();
  await page.mouse.move(
    fileBrowserResizeHandleBox!.x + fileBrowserResizeHandleBox!.width / 2,
    fileBrowserResizeHandleBox!.y + 120,
  );
  await page.mouse.down();
  await page.mouse.move(
    fileBrowserResizeHandleBox!.x + 72,
    fileBrowserResizeHandleBox!.y + 120,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => (await workspaceTree.boundingBox())?.width ?? 0)
    .toBeGreaterThan(initialFileBrowserWidth + 50);
  const resizedFileBrowserWidth = (await workspaceTree.boundingBox())!.width;
  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        const raw = window.localStorage.getItem(storageKey);
        return raw
          ? (
              JSON.parse(raw) as {
                workspace?: { fileBrowserSidebarWidth?: number };
              }
            ).workspace?.fileBrowserSidebarWidth
          : undefined;
      }, LOCAL_UI_PREFERENCES_STORAGE_KEY),
    )
    .toBeCloseTo(resizedFileBrowserWidth, 0);

  await page
    .getByRole("button", { name: "Collapse file browser" })
    .click();
  await expect(workspaceTree).toBeHidden();
  const expandFileBrowser = page.getByRole("button", {
    name: "Expand file browser",
  });
  await expect(expandFileBrowser).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        const raw = window.localStorage.getItem(storageKey);
        return raw
          ? (
              JSON.parse(raw) as {
                workspace?: { fileBrowserSidebarCollapsed?: boolean };
              }
            ).workspace?.fileBrowserSidebarCollapsed
          : undefined;
      }, LOCAL_UI_PREFERENCES_STORAGE_KEY),
    )
    .toBe(true);

  await page.reload();
  await expect(page.getByText("Loading conversation…")).toBeHidden();
  await expect(expandFileBrowser).toBeVisible();
  await expandFileBrowser.click();
  await expect(workspaceTree).toBeVisible();
  await expect
    .poll(async () => (await workspaceTree.boundingBox())?.width ?? 0)
    .toBeCloseTo(resizedFileBrowserWidth, 0);
  await expect(
    page.getByRole("button", { name: "Collapse file browser" }),
  ).toBeFocused();

  await page
    .locator('[data-browser-url="http://localhost:3000/preview"]')
    .click();
  await expect.poll(() => browserOpenBody).toEqual({
    url: "http://localhost:3000/preview",
  });
  await expect(
    inspectorViews.getByRole("button", { name: "Browser", exact: true }),
  ).toHaveClass(/is-active/);
  await expect(
    page
      .frameLocator('iframe[title="Shared Environment browser"]')
      .getByText("Shared Browser fixture"),
  ).toBeVisible();

  const fileRequestsBeforeTabRoundTrip = fileRequests.length;
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
  expect(fileRequests).toHaveLength(fileRequestsBeforeTabRoundTrip);

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
  let rootReads = 0;
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
  await page.route("**/api/v1/environments/**/files?*", async (route) => {
    rootReads += 1;
    await route.fulfill({
      json: {
        data: {
          path: "/workspace",
          refreshedAt: now,
          entries: exposeLiveFile
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
      },
    });
  });
  await page.route("**/api/v1/environments/**/ide/git", async (route) => {
    await route.fulfill({ json: { data: { repositories: [] } } });
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
    timeout: 13_000,
  });
  expect(rootReads).toBeGreaterThan(1);
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
  await expect(
    page.locator('meta[name="sandpi-native-bottom-color"]'),
  ).toHaveAttribute("content", "#151715");
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
  await expect(
    page.locator('meta[name="sandpi-native-bottom-color"]'),
  ).toHaveAttribute("content", "#f7f6f2");

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

test("shows incremental Workspace loading and a matching Metrics skeleton", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const session = bootstrap.sessions.find((candidate) => !candidate.archived);
  const environment = bootstrap.environments.find(
    (candidate) => candidate.id === session?.environmentId,
  );
  expect(session).toBeTruthy();
  expect(environment).toBeTruthy();
  if (!session || !environment) return;
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = session.id;
  const browserErrors: string[] = [];
  let releaseFiles: () => void = () => undefined;
  let releaseMetrics: () => void = () => undefined;
  let releaseRangeMetrics: () => void = () => undefined;
  let metricsRequestCount = 0;
  const filesReleased = new Promise<void>((resolve) => {
    releaseFiles = resolve;
  });
  const metricsReleased = new Promise<void>((resolve) => {
    releaseMetrics = resolve;
  });
  const rangeMetricsReleased = new Promise<void>((resolve) => {
    releaseRangeMetrics = resolve;
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
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
    if (path.endsWith("/files")) {
      await filesReleased;
      await route.fulfill({
        json: {
          data: {
            path: "/workspace",
            entries: [],
            refreshedAt: Date.now() / 1_000,
          },
        },
      });
      return;
    }
    if (path.endsWith("/ide/git")) {
      await route.fulfill({ json: { data: { repositories: [] } } });
      return;
    }
    if (path.endsWith("/metrics")) {
      metricsRequestCount += 1;
      await (metricsRequestCount === 1
        ? metricsReleased
        : rangeMetricsReleased);
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

  const workspace = page.getByRole("region", { name: "Sandpi Web IDE" });
  await expect(workspace.getByText("Loading Workspace…")).toBeVisible();
  releaseFiles();
  await expect(workspace.getByText("Loading Workspace…")).toBeHidden();

  await tabs.getByRole("button", { name: "Metrics" }).click();
  const skeleton = page.locator(".inspector-skeleton-metrics");
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toContainText("Loading metrics…");
  releaseMetrics();
  await expect(skeleton).toBeHidden();

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
  releaseRangeMetrics();
  await expect(page.locator(".inspector-skeleton-metrics")).toBeHidden();
  await expect(page.getByText("Last 6 hours", { exact: true })).toBeVisible();
  await expect(page.locator(".metric-chart-pause-band")).toHaveCount(3);
  await expect(page.locator(".metric-chart-pause-legend")).toHaveCount(3);
  await expect(
    page.locator(".metric-chart-pause-legend").first(),
  ).toContainText("Sandpi idle pause");
  const metricChartEdges = await page
    .locator(".metric-card")
    .evaluateAll((cards) =>
      cards.map((card) => {
        const band = card.querySelector<SVGRectElement>(
          ".metric-chart-pause-band",
        );
        const segmentEdges = Array.from(
          card.querySelectorAll<SVGPathElement>(".metric-chart-line"),
        ).map((path) => {
          const length = path.getTotalLength();
          return {
            start: path.getPointAtLength(0).x,
            end: path.getPointAtLength(length).x,
          };
        });
        return {
          bandStart: band?.x.baseVal.value ?? Number.NaN,
          bandEnd:
            (band?.x.baseVal.value ?? Number.NaN) +
            (band?.width.baseVal.value ?? Number.NaN),
          segmentEdges,
        };
      }),
    );
  expect(metricChartEdges).toHaveLength(3);
  for (const chart of metricChartEdges) {
    for (let index = 0; index < chart.segmentEdges.length; index += 2) {
      expect(
        Math.abs(
          (chart.segmentEdges[index]?.end ?? Number.NaN) - chart.bandStart,
        ),
      ).toBeLessThan(0.2);
      expect(
        Math.abs(
          (chart.segmentEdges[index + 1]?.start ?? Number.NaN) - chart.bandEnd,
        ),
      ).toBeLessThan(0.2);
    }
  }

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

test("resizes the Inspector proportionally, reflows the composer, and restores the local split", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const session = bootstrap.sessions.find(
    (candidate) => candidate.harness === "codex" && !candidate.archived,
  );
  const environment = bootstrap.environments.find(
    (candidate) => candidate.id === session?.environmentId,
  );
  expect(session).toBeTruthy();
  expect(environment).toBeTruthy();
  if (!session || !environment || session.harness !== "codex") return;
  const codexSession = session as CodexSession;
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = session.id;

  await page.addInitScript((storageKey) => {
    if (window.localStorage.getItem(storageKey)) return;
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        workspace: {
          sidebarCollapsed: false,
          inspectorOpen: true,
          inspectorTab: "files",
          inspectorWidthRatio: 0.5,
        },
      }),
    );
  }, LOCAL_UI_PREFERENCES_STORAGE_KEY);
  await installControlledEventSource(page);
  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.route(
    "**/api/v1/environments/**/harnesses/codex/models",
    async (route) => {
      await route.fulfill({
        json: {
          data: {
            data: [
              {
                id: codexSession.harnessState.modelId,
                displayName: "E2E layout model",
                isDefault: true,
                supportedReasoningEfforts: [],
              },
            ],
          },
          meta: { availability: "available", source: "codex" },
        },
      });
    },
  );
  await page.route("**/api/v1/environments/**/metrics/current", async (route) => {
    await route.fulfill({
      json: {
        data: { cpuUtilization: 0.1, memoryUtilization: 0.2 },
      },
    });
  });
  await page.route("**/api/v1/environments/**/files?*", async (route) => {
    await route.fulfill({
      json: {
        data: {
          path: "/workspace",
          entries: [],
          refreshedAt: Date.now() / 1_000,
        },
      },
    });
  });
  await page.route("**/api/v1/environments/**/ide/git", async (route) => {
    await route.fulfill({ json: { data: { repositories: [] } } });
  });

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&session=${encodeURIComponent(session.id)}`,
  );
  const shell = page.locator(".app-shell");
  const sidebar = page.locator(".sidebar");
  const conversation = page.locator(".conversation-pane");
  const composer = page.locator(".composer-shell");
  const inspector = page.locator(".inspector");
  const resizeHandle = page.getByRole("separator", {
    name: "Resize Inspector",
  });
  await expect(resizeHandle).toBeVisible();
  await expect(composer).toBeVisible();

  const initialSidebarWidth = (await sidebar.boundingBox())!.width;
  const initialConversationWidth = (await conversation.boundingBox())!.width;
  const initialInspectorWidth = (await inspector.boundingBox())!.width;
  expect(
    initialInspectorWidth / (initialConversationWidth + initialInspectorWidth),
  ).toBeCloseTo(0.5, 2);
  const [
    initialComposerBox,
    initialComposerToolsBox,
    initialComposerTelemetryBox,
    initialComposerAgentBox,
    initialComposerActionsBox,
  ] = await Promise.all([
    composer.boundingBox(),
    composer.locator(".composer-tools").boundingBox(),
    composer.locator(".composer-telemetry").boundingBox(),
    composer.locator(".composer-agent-bound").boundingBox(),
    composer.locator(".composer-actions").boundingBox(),
  ]);
  expect(initialComposerBox).not.toBeNull();
  expect(initialComposerToolsBox).not.toBeNull();
  expect(initialComposerTelemetryBox).not.toBeNull();
  expect(initialComposerAgentBox).not.toBeNull();
  expect(initialComposerActionsBox).not.toBeNull();
  expect(initialComposerBox!.width).toBeCloseTo(
    initialConversationWidth - 20,
    0,
  );
  expect(
    Math.max(
      initialComposerToolsBox!.y + initialComposerToolsBox!.height,
      initialComposerTelemetryBox!.y + initialComposerTelemetryBox!.height,
    ),
  ).toBeLessThanOrEqual(
    Math.min(
      initialComposerAgentBox!.y,
      initialComposerActionsBox!.y,
    ) + 1,
  );
  for (const controlBox of [
    initialComposerToolsBox,
    initialComposerTelemetryBox,
    initialComposerAgentBox,
    initialComposerActionsBox,
  ]) {
    expect(controlBox!.x).toBeGreaterThanOrEqual(initialComposerBox!.x);
    expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(
      initialComposerBox!.x + initialComposerBox!.width,
    );
  }

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toBeHidden();
  const collapsedConversationWidth = (await conversation.boundingBox())!.width;
  const collapsedInspectorWidth = (await inspector.boundingBox())!.width;
  expect(collapsedConversationWidth).toBeGreaterThan(initialConversationWidth);
  expect(collapsedInspectorWidth).toBeGreaterThan(initialInspectorWidth);
  expect(collapsedConversationWidth - initialConversationWidth).toBeCloseTo(
    initialSidebarWidth / 2,
    0,
  );
  expect(collapsedInspectorWidth - initialInspectorWidth).toBeCloseTo(
    initialSidebarWidth / 2,
    0,
  );

  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2,
    handleBox!.y + 180,
  );
  await page.mouse.down();
  await page.mouse.move(handleBox!.x - 140, handleBox!.y + 180, { steps: 6 });
  await page.mouse.up();

  const resizedConversationWidth = (await conversation.boundingBox())!.width;
  const resizedInspectorWidth = (await inspector.boundingBox())!.width;
  expect(resizedInspectorWidth).toBeGreaterThan(collapsedInspectorWidth + 120);
  expect(resizedConversationWidth).toBeLessThan(
    collapsedConversationWidth - 120,
  );
  const persistedRatio = await page.evaluate((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    return raw
      ? (JSON.parse(raw) as {
          workspace?: { inspectorWidthRatio?: number };
        }).workspace?.inspectorWidthRatio
      : undefined;
  }, LOCAL_UI_PREFERENCES_STORAGE_KEY);
  expect(persistedRatio).toBeCloseTo(
    resizedInspectorWidth /
      (resizedConversationWidth + resizedInspectorWidth),
    3,
  );

  await page.reload();
  await expect(resizeHandle).toBeVisible();
  await expect(sidebar).toBeHidden();
  const restoredConversationWidth = (await conversation.boundingBox())!.width;
  const restoredInspectorWidth = (await inspector.boundingBox())!.width;
  expect(restoredConversationWidth).toBeCloseTo(resizedConversationWidth, 0);
  expect(restoredInspectorWidth).toBeCloseTo(resizedInspectorWidth, 0);
  expect((await shell.boundingBox())!.width).toBe(1_440);
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
  let fileReads = 0;
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
    if (directoryPath === "/workspace") {
      await route.fulfill({
        json: {
          data: {
            path: "/workspace",
            refreshedAt: now,
            entries: snapshot.files[0]?.children ?? [],
          },
        },
      });
      return;
    }
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
    fileReads += 1;
    await route.fulfill({ json: { data: remoteFile } });
  });
  await page.route("**/api/v1/environments/**/ide", async (route) => {
    await route.fulfill({ json: { data: snapshot } });
  });
  await page.route("**/api/v1/environments/**/ide/git", async (route) => {
    await route.fulfill({ json: { data: snapshot.git } });
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
  expect(fileReads).toBe(0);
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
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
  const previewOnly = page.getByRole("button", { name: "Preview only" });
  await expect(previewOnly).toHaveAttribute("aria-pressed", "false");
  await previewOnly.click();
  await expect(page.getByText("Read-only preview", { exact: true })).toBeVisible();
  await expect(
    editor.locator("textarea.inputarea"),
  ).toHaveAttribute("readonly", "");
  const editFile = page.getByRole("button", { name: "Edit file" });
  await expect(editFile).toHaveAttribute("aria-pressed", "true");
  await editFile.click();
  await expect(editor.locator("textarea.inputarea")).not.toHaveAttribute(
    "readonly",
    "",
  );
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
  await page.route("**/api/v1/environments/**/files?*", async (route) => {
    await route.fulfill({
      json: {
        data: {
          path: "/workspace",
          refreshedAt: now,
          entries: snapshot.files[0]?.children ?? [],
        },
      },
    });
  });
  await page.route("**/api/v1/environments/**/ide/git", async (route) => {
    await route.fulfill({ json: { data: snapshot.git } });
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
  await installDarkUiPreferences(page);

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

test("keeps pinned Session markers compact and removes sidebar shortcuts", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const environment = bootstrap.environments[0];
  const session = bootstrap.sessions.find(
    (candidate) =>
      candidate.environmentId === environment?.id &&
      candidate.status === "waiting",
  );
  expect(environment).toBeTruthy();
  expect(session).toBeTruthy();
  if (!environment || !session) return;
  session.pinned = true;
  session.unread = false;
  bootstrap.selectedEnvironmentId = environment.id;
  bootstrap.selectedSessionId = "";

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );

  await page.goto(
    `/?environment=${encodeURIComponent(environment.id)}&new=1`,
  );
  const sessionRow = page
    .locator(".session-row")
    .filter({ hasText: session.title });
  await expect(sessionRow.locator(".session-pinned-icon")).toBeVisible();
  await expect(sessionRow.locator(".session-state-indicator")).toHaveCount(0);
  const markerGap = await sessionRow.evaluate((row) => {
    const pin = row.querySelector<SVGElement>(".session-pinned-icon");
    const title = row.querySelector<HTMLElement>(".session-title");
    if (!pin || !title) throw new Error("Pinned Session layout is missing");
    return title.getBoundingClientRect().left - pin.getBoundingClientRect().right;
  });
  expect(markerGap).toBeLessThanOrEqual(10);

  await expect(page.locator(".keyboard-hint")).toHaveCount(0);
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "n",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(
    page.getByRole("dialog", { name: "Search sessions" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "New Environment" }),
  ).toHaveCount(0);
});

test("marks a Session complete independently from archiving and quiets its sidebar row", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const session = bootstrap.sessions.find(
    (candidate) => candidate.status === "waiting" && !candidate.archived,
  );
  expect(session).toBeTruthy();
  if (!session) return;
  session.completed = false;
  session.unread = true;
  bootstrap.selectedEnvironmentId = session.environmentId;
  bootstrap.selectedSessionId = session.id;

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.route(
    (url) =>
      url.pathname ===
      `/api/v1/sessions/${encodeURIComponent(session.id)}/metadata`,
    async (route) => {
      const metadata = route.request().postDataJSON() as {
        completed?: boolean;
        unread?: boolean;
      };
      Object.assign(session, metadata);
      await route.fulfill({ json: { data: session } });
    },
  );

  await page.goto(
    `/?environment=${encodeURIComponent(session.environmentId)}&session=${encodeURIComponent(session.id)}`,
  );
  const sessionRow = page
    .locator(".session-row")
    .filter({ hasText: session.title });
  await page.getByRole("button", { name: "Mark complete" }).click();

  await expect(page.getByRole("button", { name: "Mark incomplete" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(sessionRow).toHaveClass(/is-completed/);
  await expect(sessionRow.locator(".session-state-indicator")).toHaveCount(0);
  expect(session.archived).toBe(false);
  expect(session.completed).toBe(true);
});

test("keeps the New Environment summary on one mobile line", async ({ page }) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "New environment" }).click();

  const summary = page.getByText(
    "A shared workspace for all your Sessions.",
    { exact: true },
  );
  await expect(summary).toBeVisible();
  const metrics = await summary.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      whiteSpace: style.whiteSpace,
    };
  });
  expect(metrics.whiteSpace).toBe("nowrap");
  expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight + 1);
});

test("paginates each Environment Session list from six in batches of ten", async ({
  page,
}) => {
  const bootstrap = getMockBootstrap();
  useEnglishUi(bootstrap);
  const development = bootstrap.environments.find(
    (environment) => environment.id === "env-default",
  );
  const release = bootstrap.environments.find(
    (environment) => environment.id === "env-release",
  );
  const template = bootstrap.sessions[0];
  expect(development).toBeTruthy();
  expect(release).toBeTruthy();
  expect(template).toBeTruthy();
  if (!development || !release || !template) return;

  function sessionsFor(
    environment: Environment,
    label: string,
    count: number,
  ): CodingSession[] {
    return Array.from({ length: count }, (_, index) => ({
      ...structuredClone(template),
      id: `session-pagination-${environment.id}-${index + 1}`,
      environmentId: environment.id,
      environmentRevision: environment.revision,
      title: `${label} session ${String(index + 1).padStart(2, "0")}`,
      status: "waiting",
      unread: false,
      pinned: false,
      archived: false,
      updatedAt: template.updatedAt - index,
    }));
  }

  bootstrap.sessions = [
    ...sessionsFor(development, "Development", 29),
    ...sessionsFor(release, "Release", 12),
  ];
  bootstrap.selectedEnvironmentId = development.id;
  bootstrap.selectedSessionId = "";

  await page.route(
    (url) => url.pathname === "/api/v1/bootstrap",
    async (route) => {
      await route.fulfill({ json: { data: bootstrap } });
    },
  );

  await page.goto(
    `/?environment=${encodeURIComponent(development.id)}&new=1`,
  );
  const environmentGroup = (name: string) =>
    page.locator(".environment-group").filter({
      has: page.getByRole("button", { name, exact: true }),
    });
  const developmentGroup = environmentGroup(development.name);
  const releaseGroup = environmentGroup(release.name);

  await expect(developmentGroup.locator(".session-row")).toHaveCount(6);
  await expect(releaseGroup.locator(".session-row")).toHaveCount(6);
  await expect(
    developmentGroup.getByText("Development session 07", { exact: true }),
  ).toHaveCount(0);

  await developmentGroup
    .getByRole("button", {
      name: `Show 10 more sessions in ${development.name}`,
    })
    .click();
  await expect(developmentGroup.locator(".session-row")).toHaveCount(16);
  await expect(releaseGroup.locator(".session-row")).toHaveCount(6);

  await developmentGroup
    .getByRole("button", {
      name: `Show 10 more sessions in ${development.name}`,
    })
    .click();
  await expect(developmentGroup.locator(".session-row")).toHaveCount(26);
  await developmentGroup
    .getByRole("button", {
      name: `Show 3 more sessions in ${development.name}`,
    })
    .click();
  await expect(developmentGroup.locator(".session-row")).toHaveCount(29);
  await expect(
    developmentGroup.getByRole("button", {
      name: /Show \d+ more sessions/,
    }),
  ).toHaveCount(0);

  await developmentGroup
    .getByRole("button", {
      name: `Show fewer sessions in ${development.name}`,
    })
    .click();
  await expect(developmentGroup.locator(".session-row")).toHaveCount(6);

  await page.getByRole("button", { name: "Search sessions" }).click();
  await page
    .getByRole("searchbox", { name: "Search sessions or environments" })
    .fill("Development session 29");
  await expect(
    page.getByRole("option", { name: /Development session 29/ }),
  ).toBeVisible();
});

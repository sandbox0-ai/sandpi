import { expect, test, type Page } from "@playwright/test";

import {
  getMockBootstrap,
  mockSessions,
  mockTeamMemberships,
} from "../src/lib/mock-data";
import type {
  CodingSession,
  EnvironmentWorkspaceBackup,
} from "../src/lib/types";

const modelCatalog = {
  data: {
    data: [
      {
        id: "gpt-e2e",
        displayName: "E2E Codex",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "Test model" },
        ],
      },
    ],
  },
};

interface MockTeamWorkspaceOptions {
  viewerId?: string;
  pins?: Map<string, Set<string>>;
}

async function mockTeamWorkspace(
  page: Page,
  options: MockTeamWorkspaceOptions = {},
) {
  const viewerId = options.viewerId ?? "user-yan";
  const pins = options.pins ?? new Map<string, Set<string>>();
  const environmentUpdates: Array<Record<string, unknown>> = [];
  const workspaceBackupCreates: string[] = [];
  const workspaceRestores: Array<{
    environmentId: string;
    snapshotId: string;
    confirmation: string;
  }> = [];
  const workspaceBackups = new Map<string, EnvironmentWorkspaceBackup[]>();
  const viewer = mockTeamMemberships.find(
    (membership) => membership.user.id === viewerId,
  )?.user;
  if (!viewer) throw new Error(`Unknown mock viewer ${viewerId}.`);
  const activeTeamIds = new Set(
    mockTeamMemberships
      .filter(
        (membership) =>
          membership.user.id === viewerId && membership.status === "active",
      )
      .map((membership) => membership.teamId),
  );
  const visibleEnvironmentIds = new Set(
    getMockBootstrap().environments
      .filter(
        (environment) =>
          activeTeamIds.has(environment.teamId) &&
          (environment.visibility === "team" || environment.ownerId === viewerId),
      )
      .map((environment) => environment.id),
  );
  const sessionForViewer = <T extends CodingSession>(session: T): T => ({
    ...structuredClone(session),
    pinned: pins.get(viewerId)?.has(session.id) ?? false,
  });

  await page.addInitScript(() => {
    class QuietEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;

      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials: boolean;
      readyState = QuietEventSource.OPEN;

      constructor(url: string | URL, init?: EventSourceInit) {
        super();
        this.url = String(url);
        this.withCredentials = init?.withCredentials ?? false;
      }

      close() {
        this.readyState = QuietEventSource.CLOSED;
      }
    }

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: QuietEventSource,
    });
  });

  await page.route("**/api/v1/bootstrap**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const bootstrap = getMockBootstrap(
      requestUrl.searchParams.get("team") ?? "team-sandpi-labs",
    );
    bootstrap.viewer = structuredClone(viewer);
    bootstrap.viewerMemberships = bootstrap.teamMemberships.filter(
      (membership) =>
        membership.user.id === viewerId && membership.status === "active",
    );
    const viewerTeamIds = new Set(
      bootstrap.viewerMemberships.map((membership) => membership.teamId),
    );
    bootstrap.teams = bootstrap.teams.filter((team) => viewerTeamIds.has(team.id));
    bootstrap.environments = bootstrap.environments.filter(
      (environment) =>
        viewerTeamIds.has(environment.teamId) &&
        (environment.visibility === "team" || environment.ownerId === viewerId),
    );
    const selectedVisibleEnvironmentIds = new Set(
      bootstrap.environments.map((environment) => environment.id),
    );
    bootstrap.selectedSessionId = "";
    bootstrap.sessions = bootstrap.sessions
      .filter(
        (session) =>
          session.id !== "session-harmony-shell" &&
          selectedVisibleEnvironmentIds.has(session.environmentId),
      )
      .map(sessionForViewer);
    await route.fulfill({
      json: { data: bootstrap, meta: { runtime: "mock" } },
    });
  });

  await page.route("**/api/v1/environments/*/harnesses/codex/models", (route) =>
    route.fulfill({ json: modelCatalog }),
  );
  await page.route(
    "**/api/v1/environments/*/harnesses/codex/device-login",
    (route) => route.fulfill({ json: { data: null } }),
  );
  await page.route(
    "**/api/v1/environments/*/workspace-backups/*/restore",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const match =
        /^\/api\/v1\/environments\/([^/]+)\/workspace-backups\/([^/]+)\/restore$/.exec(
          path,
        );
      if (route.request().method() !== "PUT" || !match) {
        await route.fallback();
        return;
      }
      const environmentId = match[1]!;
      const snapshotId = match[2]!;
      const body = route.request().postDataJSON() as { confirmation: string };
      workspaceRestores.push({
        environmentId,
        snapshotId,
        confirmation: body.confirmation,
      });
      const environment = getMockBootstrap(
        "team-sandpi-labs",
      ).environments.find((candidate) => candidate.id === environmentId);
      const backup = workspaceBackups
        .get(environmentId)
        ?.find((candidate) => candidate.id === snapshotId);
      if (!environment || !backup) {
        await route.fulfill({ status: 404, json: { error: "not found" } });
        return;
      }
      await route.fulfill({
        json: {
          data: {
            backup,
            environment: structuredClone(environment),
            unavailableSessionCount: 0,
          },
        },
      });
    },
  );
  await page.route(
    "**/api/v1/environments/*/workspace-backups",
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const match = /^\/api\/v1\/environments\/([^/]+)\/workspace-backups$/.exec(
        path,
      );
      if (!match) {
        await route.fallback();
        return;
      }
      const environmentId = match[1]!;
      if (route.request().method() === "GET") {
        await route.fulfill({
          json: { data: workspaceBackups.get(environmentId) ?? [] },
        });
        return;
      }
      if (route.request().method() === "POST") {
        workspaceBackupCreates.push(environmentId);
        const environment = getMockBootstrap(
          "team-sandpi-labs",
        ).environments.find((candidate) => candidate.id === environmentId);
        if (!environment) {
          await route.fulfill({ status: 404, json: { error: "not found" } });
          return;
        }
        const createdAt = Date.parse("2026-07-21T12:00:00.000Z") / 1_000;
        const backup: EnvironmentWorkspaceBackup = {
          id: "snapshot-e2e-manual",
          environmentId,
          name: "sandpi-workspace-e2e",
          sizeBytes: 128 * 1024 * 1024,
          kind: "manual",
          createdAt,
        };
        workspaceBackups.set(environmentId, [backup]);
        await route.fulfill({
          status: 201,
          json: {
            data: {
              backup,
              environment: {
                ...structuredClone(environment),
                workspaceBackup: {
                  ...environment.workspaceBackup,
                  lastBackupAt: createdAt,
                },
              },
            },
          },
        });
        return;
      }
      await route.fallback();
    },
  );
  await page.route("**/api/v1/environments/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const match = /^\/api\/v1\/environments\/([^/]+)$/.exec(path);
    if (route.request().method() === "PUT" && match) {
      const environment = getMockBootstrap("team-sandpi-labs").environments.find(
        (candidate) => candidate.id === match[1],
      );
      if (!environment) {
        await route.fulfill({ status: 404, json: { error: "not found" } });
        return;
      }
      const update = route.request().postDataJSON() as Record<string, unknown>;
      environmentUpdates.push(update);
      await route.fulfill({
        json: {
          data: {
            ...structuredClone(environment),
            ...update,
            revision: environment.revision + 1,
          },
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/sessions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        data: mockSessions
          .filter(
            (session) =>
              session.id !== "session-harmony-shell" &&
              visibleEnvironmentIds.has(session.environmentId),
          )
          .map(sessionForViewer),
      },
    });
  });
  await page.route("**/api/v1/sessions/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && path.endsWith("/models")) {
      await route.fulfill({ json: modelCatalog });
      return;
    }
    const metadataMatch = /^\/api\/v1\/sessions\/([^/]+)\/metadata$/.exec(path);
    if (route.request().method() === "PUT" && metadataMatch) {
      const session = mockSessions.find(
        (candidate) => candidate.id === metadataMatch[1],
      );
      if (!session) {
        await route.fulfill({ status: 404, json: { error: "not found" } });
        return;
      }
      const update = route.request().postDataJSON() as { pinned?: boolean };
      const viewerPins = pins.get(viewerId) ?? new Set<string>();
      if (update.pinned === true) viewerPins.add(session.id);
      if (update.pinned === false) viewerPins.delete(session.id);
      pins.set(viewerId, viewerPins);
      await route.fulfill({
        json: { data: { ...sessionForViewer(session), ...update } },
      });
      return;
    }
    const match = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path);
    const session = match
      ? mockSessions.find((candidate) => candidate.id === match[1])
      : undefined;
    if (route.request().method() === "GET" && session) {
      await route.fulfill({ json: { data: sessionForViewer(session) } });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/sessions/*/models", (route) =>
    route.fulfill({ json: modelCatalog }),
  );

  return { environmentUpdates, workspaceBackupCreates, workspaceRestores };
}

test("switches Team-visible and private Environments and shows Session owners", async ({
  page,
}) => {
  const workspace = await mockTeamWorkspace(page);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/?team=team-sandpi-labs&new=1");

  await expect(page.getByText("Development", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Release lab", { exact: true })).toBeVisible();
  const privateEnvironment = page
    .locator(".environment-group")
    .filter({ hasText: "Personal scratchpad" });
  await expect(privateEnvironment).toBeVisible();
  await expect(
    privateEnvironment.getByLabel("Private Environment"),
  ).toBeVisible();
  await privateEnvironment
    .getByRole("button", { name: "Personal scratchpad settings" })
    .click();
  const settingsDialog = page.getByRole("dialog", {
    name: "Personal scratchpad settings",
  });
  await expect(settingsDialog.getByLabel("Environment visibility")).toHaveValue(
    "private",
  );
  await expect(
    settingsDialog.getByRole("button", { name: "Agent harness", exact: true }),
  ).toBeVisible();
  await expect(
    settingsDialog.getByRole("button", { name: "Coding agent", exact: true }),
  ).toHaveCount(0);
  await expect(
    settingsDialog.getByLabel("Environment Sandbox memory"),
  ).toHaveCount(0);
  await settingsDialog
    .getByRole("button", { name: "Sandbox", exact: true })
    .click();
  const idleTimeout = settingsDialog.getByLabel(
    "Environment auto-pause timeout in minutes",
  );
  await expect(idleTimeout).toHaveValue("0");
  await expect(idleTimeout).toHaveAttribute("max", "43200");
  await expect(
    settingsDialog.getByText("Set 0 to keep it running with no time limit."),
  ).toBeVisible();
  await idleTimeout.fill("45");
  const sandboxMemory = settingsDialog.getByLabel(
    "Environment Sandbox memory",
  );
  await expect(sandboxMemory).toHaveValue("2048");
  await expect(sandboxMemory.locator("option")).toHaveText([
    "512 MiB",
    "1 GiB",
    "2 GiB",
    "4 GiB",
    "8 GiB",
  ]);
  const backupFrequency = settingsDialog.getByLabel(
    "Workspace backup frequency",
  );
  await expect(backupFrequency).toHaveValue("0");
  await expect(backupFrequency.locator("option")).toHaveText([
    "Off",
    "Every hour",
    "Every 6 hours",
    "Every 12 hours",
    "Daily",
    "Weekly",
  ]);
  const backupRetention = settingsDialog.getByLabel(
    "Workspace backup retention",
  );
  await expect(backupRetention).toHaveValue("7");
  await settingsDialog.getByRole("button", { name: "Back up now" }).click();
  await expect(
    settingsDialog.getByLabel("Workspace backups").getByText("Manual backup"),
  ).toBeVisible();
  expect(workspace.workspaceBackupCreates).toEqual(["env-personal"]);
  await settingsDialog
    .getByRole("button", { name: /Restore backup from/ })
    .click();
  const restoreConfirmation = settingsDialog.getByRole("group", {
    name: "Confirm Workspace restore",
  });
  await expect(
    restoreConfirmation.getByText("Restore the entire shared Workspace?"),
  ).toBeVisible();
  const restoreSubmit = restoreConfirmation.getByRole("button", {
    name: "Restore Workspace",
  });
  await expect(restoreSubmit).toBeDisabled();
  await restoreConfirmation
    .getByLabel("Environment name confirmation for Workspace restore")
    .fill("Personal scratchpad");
  await restoreSubmit.click();
  await expect(
    settingsDialog.getByText(
      "Workspace restored. The shared Sandbox is ready with the selected backup.",
    ),
  ).toBeVisible();
  expect(workspace.workspaceRestores).toEqual([
    {
      environmentId: "env-personal",
      snapshotId: "snapshot-e2e-manual",
      confirmation: "Personal scratchpad",
    },
  ]);
  await backupFrequency.selectOption("86400");
  await backupRetention.selectOption("3");
  await sandboxMemory.selectOption("4096");
  await settingsDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("dialog", { name: /Personal scratchpad settings/ }),
  ).toHaveCount(0);
  expect(workspace.environmentUpdates.at(-1)?.idlePauseTimeoutSeconds).toBe(
    45 * 60,
  );
  expect(workspace.environmentUpdates.at(-1)?.sandboxMemoryMiB).toBe(4 * 1024);
  expect(workspace.environmentUpdates.at(-1)?.workspaceBackup).toEqual({
    intervalSeconds: 86_400,
    retentionCount: 3,
  });

  const teammateSession = page
    .locator(".session-row")
    .filter({ hasText: "Prepare sdk-js release" });
  await expect(teammateSession).toBeVisible();
  await expect(
    teammateSession.getByLabel("Owner: Mira Chen"),
  ).toHaveText("MC");
  const ownSession = page
    .locator(".session-row")
    .filter({ hasText: "Fix auth callback race" });
  await expect(ownSession).toBeVisible();
  await expect(ownSession.locator(".session-owner-avatar")).toHaveCount(0);

  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(
    page.getByRole("menuitemradio", { name: /Sandpi Labs.*Max/ }),
  ).toBeVisible();
  await page
    .getByRole("menuitemradio", { name: /Side Projects.*Pro/ })
    .click();

  await expect(page.getByText("Experiments", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Development", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Personal scratchpad", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "New Environment" }).click();
  await expect(page.getByRole("radio", { name: "Team" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Private" })).not.toBeChecked();
  await expect(
    page.getByText("New Environments are Team-visible by default."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close New Environment dialog" }).click();

  expect(browserErrors).toEqual([]);
});

test("renders a distinct Plan and shared quota pool for each Team", async ({
  page,
}) => {
  await mockTeamWorkspace(page);

  await page.goto("/team?team=team-sandpi-labs");
  await page.getByRole("button", { name: "Billing & plan" }).click();
  await expect(
    page.getByRole("heading", { name: "Max", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Plan for Sandpi Labs")).toHaveValue("max");
  await expect(page.getByLabel("Team weekly execution quota")).toHaveAttribute(
    "aria-valuemax",
    "7200",
  );
  await expect(page.getByText("Team concurrent Sessions")).toBeVisible();

  await page.goto("/team?team=team-side-projects");
  await page.getByRole("button", { name: "Billing & plan" }).click();
  await expect(
    page.getByRole("heading", { name: "Pro", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Plan for Side Projects")).toHaveValue("pro");
  await expect(page.getByLabel("Team weekly execution quota")).toHaveAttribute(
    "aria-valuemax",
    "1800",
  );
});

test("keeps Session pins personal and shows avatars only for teammates", async ({
  page,
}) => {
  const pins = new Map<string, Set<string>>();
  await mockTeamWorkspace(page, { viewerId: "user-yan", pins });
  const miraPage = await page.context().newPage();
  await mockTeamWorkspace(miraPage, { viewerId: "user-mira", pins });

  await page.goto("/?team=team-sandpi-labs&new=1");
  const yanView = page
    .locator(".session-row")
    .filter({ hasText: "Prepare sdk-js release" });
  await expect(yanView.getByLabel("Owner: Mira Chen")).toHaveText("MC");
  await yanView.hover();
  await yanView
    .getByRole("button", {
      name: "Session actions for Prepare sdk-js release",
    })
    .click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(yanView.getByLabel("Pinned")).toBeVisible();

  await miraPage.goto("/?team=team-sandpi-labs&new=1");
  const miraView = miraPage
    .locator(".session-row")
    .filter({ hasText: "Prepare sdk-js release" });
  await expect(miraView).toBeVisible();
  await expect(miraView.getByLabel("Pinned")).toHaveCount(0);
  await expect(miraView.locator(".session-owner-avatar")).toHaveCount(0);

  await miraPage.close();
});

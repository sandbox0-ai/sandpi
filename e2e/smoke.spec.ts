import { expect, test, type Page } from "@playwright/test";

import type { ApiEnvelope } from "../src/lib/api-client";
import type { SandpiBootstrap } from "../src/lib/types";

async function pageBlocksUnload(page: Page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    return !window.dispatchEvent(event) && event.defaultPrevented;
  });
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
  const response = await request.get("/api/v1/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = (await response.json()) as ApiEnvelope<SandpiBootstrap>;
  const session = bootstrap.data.sessions.find((candidate) => !candidate.archived);
  const environment = bootstrap.data.environments.find(
    (candidate) => candidate.id === session?.environmentId,
  );

  test.skip(!session || !environment, "An active Session is required for this check.");
  if (!session || !environment) return;

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

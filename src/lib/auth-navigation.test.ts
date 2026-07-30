import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_AUTH_REQUEST_EVENT,
  PENDING_GUEST_PROMPT_STORAGE_KEY,
  authLoginUrl,
  consumePendingGuestPrompt,
  loggedOutHomeUrl,
  navigateToAuthLogin,
  newSessionAuthLoginUrl,
  storePendingGuestPrompt,
} from "./auth-navigation";

function navigationWindow() {
  const navigations: Array<{ mode: "assign" | "replace"; url: string }> = [];
  const target = new EventTarget() as EventTarget & {
    location: {
      assign(url: string): void;
      replace(url: string): void;
    };
  };
  target.location = {
    assign(url) {
      navigations.push({ mode: "assign", url });
    },
    replace(url) {
      navigations.push({ mode: "replace", url });
    },
  };
  return { navigations, target };
}

function promptStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set(PENDING_GUEST_PROMPT_STORAGE_KEY, initial);
  }
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

test("builds login URLs that return to the current app location", () => {
  assert.equal(
    authLoginUrl(
      "https://sandpi.ai/?environment=env-one",
      "/api/v1/auth/login",
    ),
    "https://sandpi.ai/api/v1/auth/login?return_to=https%3A%2F%2Fsandpi.ai%2F%3Fenvironment%3Denv-one",
  );
  assert.equal(
    authLoginUrl(
      "https://sandpi.ai/",
      "/api/v1/auth/login?return_to=%2Fpreferences%2F",
    ),
    "https://sandpi.ai/api/v1/auth/login?return_to=%2Fpreferences%2F",
  );
});

test("guest messages return to an authenticated new Session", () => {
  assert.equal(
    newSessionAuthLoginUrl(
      "https://sandpi.ai/api/v1/auth/login?return_to=https%3A%2F%2Fsandpi.ai%2F",
      "https://sandpi.ai/?session=session-private",
    ),
    "https://sandpi.ai/api/v1/auth/login?return_to=https%3A%2F%2Fsandpi.ai%2F%3Fnew%3D1",
  );
});

test("native shells can handle login without changing browser behavior", () => {
  const native = navigationWindow();
  native.target.addEventListener(NATIVE_AUTH_REQUEST_EVENT, (event) => {
    assert.equal(
      (event as CustomEvent<{ loginUrl: string }>).detail.loginUrl,
      "https://sandpi.ai/api/v1/auth/login",
    );
    event.preventDefault();
  });
  assert.equal(
    navigateToAuthLogin(
      "https://sandpi.ai/api/v1/auth/login",
      "assign",
      native.target,
    ),
    "native",
  );
  assert.deepEqual(native.navigations, []);

  const web = navigationWindow();
  assert.equal(
    navigateToAuthLogin(
      "https://sandpi.ai/api/v1/auth/login",
      "replace",
      web.target,
    ),
    "web",
  );
  assert.deepEqual(web.navigations, [
    {
      mode: "replace",
      url: "https://sandpi.ai/api/v1/auth/login",
    },
  ]);
});

test("logout returns to the public home without private workspace coordinates", () => {
  assert.equal(
    loggedOutHomeUrl(
      "https://sandpi.ai/?environment=env-private&session=session-private&path=%2Fworkspace%2Fsecret",
    ),
    "https://sandpi.ai/",
  );
});

test("pending guest prompts are bounded and consumed once", () => {
  const storage = promptStorage();
  assert.equal(storePendingGuestPrompt(storage, "Inspect the workspace"), true);
  assert.equal(consumePendingGuestPrompt(storage), "Inspect the workspace");
  assert.equal(consumePendingGuestPrompt(storage), undefined);

  assert.equal(storePendingGuestPrompt(storage, "   "), false);
  assert.equal(consumePendingGuestPrompt(storage), undefined);

  assert.equal(storePendingGuestPrompt(storage, "x".repeat(100_001)), true);
  assert.equal(consumePendingGuestPrompt(storage)?.length, 100_000);
});

import { apiUrl } from "./api-client";

export const PENDING_GUEST_PROMPT_STORAGE_KEY =
  "sandpi.pending-guest-prompt.v1";

interface PromptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Build the deployment login URL without changing the current page. */
export function authLoginUrl(currentUrl: string, configuredLoginUrl?: string) {
  const target = new URL(
    apiUrl(configuredLoginUrl ?? "/api/v1/auth/login"),
    currentUrl,
  );
  if (!target.searchParams.has("return_to")) {
    target.searchParams.set("return_to", currentUrl);
  }
  return target.toString();
}

/** Route a guest message back to an authenticated new-Session surface. */
export function newSessionAuthLoginUrl(loginUrl: string, currentUrl: string) {
  const returnTo = new URL("/", currentUrl);
  returnTo.searchParams.set("new", "1");
  const target = new URL(loginUrl, currentUrl);
  target.searchParams.set("return_to", returnTo.toString());
  return target.toString();
}

/** Return to the public home surface without retaining private workspace coordinates. */
export function loggedOutHomeUrl(currentUrl: string) {
  return new URL("/", currentUrl).toString();
}

export function storePendingGuestPrompt(
  storage: PromptStorage,
  prompt: string,
) {
  if (!prompt.trim()) {
    storage.removeItem(PENDING_GUEST_PROMPT_STORAGE_KEY);
    return false;
  }
  storage.setItem(PENDING_GUEST_PROMPT_STORAGE_KEY, prompt.slice(0, 100_000));
  return true;
}

export function consumePendingGuestPrompt(storage: PromptStorage) {
  const prompt = storage.getItem(PENDING_GUEST_PROMPT_STORAGE_KEY);
  storage.removeItem(PENDING_GUEST_PROMPT_STORAGE_KEY);
  return prompt?.trim() ? prompt : undefined;
}

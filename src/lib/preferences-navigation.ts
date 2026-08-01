export const PREFERENCES_PATH = "/preferences";
export const PREFERENCES_RETURN_TO_PARAM = "return_to";

/** Builds a Preferences URL that can return to the caller's current page. */
export function preferencesUrl(
  returnTo: string,
  parameters: Record<string, string> = {},
) {
  const search = new URLSearchParams(parameters);
  search.set(PREFERENCES_RETURN_TO_PARAM, returnTo);
  return `${PREFERENCES_PATH}?${search.toString()}`;
}

/** Accepts only local, non-Preferences paths as Preferences return targets. */
export function safePreferencesReturnTo(value: string | null | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";

  try {
    const target = new URL(value, "https://sandpi.local");
    if (target.origin !== "https://sandpi.local") return "/";
    if (
      target.pathname === PREFERENCES_PATH ||
      target.pathname.startsWith(`${PREFERENCES_PATH}/`)
    ) {
      return "/";
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

export async function copyTextToClipboard(content: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(content);
    return;
  }

  // navigator.clipboard is unavailable on the HTTP address used by local
  // device previews. Keep copy actions usable there without storing content.
  const fallback = document.createElement("textarea");
  fallback.value = content;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.appendChild(fallback);
  try {
    fallback.focus();
    fallback.select();
    if (!document.execCommand("copy")) {
      throw new Error("The browser rejected the clipboard operation.");
    }
  } finally {
    fallback.remove();
  }
}

export function randomToken(length = 16) {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID().replaceAll("-", "").slice(0, length);
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, length);
  }

  const fallback = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return fallback.padEnd(length, "0").slice(0, length);
}

export function createId(prefix: string, length = 16) {
  return `${prefix}-${randomToken(length)}`;
}

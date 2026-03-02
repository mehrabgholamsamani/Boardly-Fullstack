const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeWsUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  if (value.startsWith("ws://") || value.startsWith("wss://")) return value;
  if (value.startsWith("http://")) return `ws://${value.slice("http://".length)}`;
  if (value.startsWith("https://")) return `wss://${value.slice("https://".length)}`;
  if (!value.includes("://")) return `wss://${value}`;
  return value;
}

export function isDebugEnabled(): boolean {
  return import.meta.env.VITE_DEBUG === "1";
}

export function debugLog(...args: unknown[]): void {
  if (!isDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.log("[ws]", ...args);
}

export function getWsUrl(): string {
  const fromEnv = normalizeWsUrl(import.meta.env.VITE_WS_URL ?? "");
  if (fromEnv) {
    debugLog("resolved url from VITE_WS_URL", fromEnv);
    return fromEnv;
  }

  const hostname = window.location.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(hostname)) {
    const localUrl = "ws://localhost:8787";
    debugLog("resolved local fallback url", localUrl);
    return localUrl;
  }

  throw new Error("Missing VITE_WS_URL in non-local environment.");
}

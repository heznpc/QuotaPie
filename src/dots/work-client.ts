import type { AppConfig } from "../config";
import type { WorkPolicy } from "../work/types";
export type SharedWorkPolicy = WorkPolicy & { admission: { ready: boolean; reason: string } };
export interface SharedWorkClient {
  list(): Promise<{ policies: SharedWorkPolicy[]; [key: string]: unknown }>;
  preferences(): Promise<unknown>;
  savePreferences(input: unknown): Promise<unknown>;
  targets(provider: string, account: string): Promise<unknown>;
  save(input: unknown): Promise<unknown>;
  setEnabled(input: unknown): Promise<unknown>;
  execute(input: unknown): Promise<unknown>;
}
/** Dots delegates to the resident collector. It has no second policy database,
 * budget counter, lease or provider execution path. Tokens never leave here. */
export function createSharedWorkClient(config: AppConfig, fetcher: typeof fetch = fetch): SharedWorkClient {
  const host = config.dashboard.host;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error("shared-work-loopback-required");
  const base = `http://${host === "::1" ? "[::1]" : host}:${config.dashboard.port}`;
  async function request(path: string, body?: unknown): Promise<any> {
    let token: string | undefined;
    {
      const response = await fetcher(base + "/api/status", { redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("shared-work-unavailable");
      const status = await response.json() as any;
      if (typeof status.actionToken !== "string" || !status.actionToken) throw new Error("shared-work-auth-unavailable");
      token = status.actionToken;
    }
    const response = await fetcher(base + path, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-quotapie-action-token": token! },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const value = await response.json() as any;
    if (!response.ok) {
      const reason = typeof value?.error === "string" && /^[a-z-]{3,80}$/.test(value.error) ? value.error : "shared-work-request-failed";
      throw new Error(reason);
    }
    return value;
  }
  return { list: () => request("/api/work"),
    preferences: () => request("/api/work/preferences"),
    savePreferences: input => request("/api/work/preferences", input),
    targets: (provider, account) => request("/api/work/targets?" + new URLSearchParams({ provider, account })),
    save: input => request("/api/work", { ...(input as object), action: "save" }),
    setEnabled: input => request("/api/work", { ...(input as object), action: "enabled" }),
    execute: input => request("/api/work/execute", input) };
}

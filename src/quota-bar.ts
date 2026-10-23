import type { AppConfig } from "./config";
import { resolveLocale, t, type Locale } from "./i18n";

export interface BarWindow { bucket: string; label: string; freshness: string; remainingPercent: number | null; resetsAtMs: number | null }
export interface BarAccount {
  provider: string; account: string; accountLabel: string; enabled: boolean;
  plan?: {kind: string}; claudeAccess?: {organizationName?: string};
  collection: {health: string; errorCategory?: string | null}; windows: BarWindow[];
}
export function quotaBar(percent: number | null, width = 10): string {
  if (percent == null || !Number.isFinite(percent)) return "[" + "·".repeat(width) + "] —";
  const value = Math.max(0, Math.min(100, percent)), fill = Math.floor(value * width / 100);
  return "[" + "━".repeat(fill) + "·".repeat(width - fill) + "] " + Math.round(value) + "%";
}
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 100);
export function accountQuotaBar(account: BarAccount, now = Date.now(), locale: Locale = "en"): string {
  const name = clean(account.claudeAccess?.organizationName ?? account.accountLabel);
  const plan = account.plan?.kind === "team" ? " Team" : "";
  const healthy = account.collection.health === "recent-success";
  const windows = account.windows.filter(w => w.bucket !== "extra_usage").map(w => {
    const fresh = healthy && w.freshness === "fresh" && (w.resetsAtMs == null || w.resetsAtMs > now);
    const label = clean(w.label.replace(/^Claude\s*/i, "").replace(/weekly/i, "7d"));
    return `${label} ${quotaBar(fresh ? w.remainingPercent : null)}`;
  });
  return `QuotaPie · ${name}${plan} · ${windows.length ? windows.join(" | ") : "—"} · ${t(healthy ? "cli.quota-bar.remaining" : "cli.quota-bar.check", {}, locale)}`;
}
export async function runQuotaBar(config: AppConfig, args: string[], output = console.log): Promise<number> {
  const locale = resolveLocale(config.profile.locale);
  try {
    const arg = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    const account = arg("--account"), provider = arg("--provider") ?? "claude";
    if (args.some((a,i) => (a === "--account" || a === "--provider") && (!args[i+1] || args[i+1]!.startsWith("--")))) throw new Error("invalid_selection");
    const host = config.dashboard.host.replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("nonlocal_service");
    const response = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${config.dashboard.port}/api/quota`,
      {signal: AbortSignal.timeout(1200), redirect: "error"});
    if (!response.ok) throw new Error("status_unavailable");
    const payload = await response.json() as { accounts: BarAccount[] };
    const accounts = payload.accounts.filter(a => a.enabled && a.provider === provider && (account == null || a.account === account));
    if (!accounts.length) { output(`QuotaPie · ${t("cli.quota-bar.no-account", {}, locale)}`); return 0; }
    output(accounts.map(a => accountQuotaBar(a, Date.now(), locale)).join("\n"));
  } catch { output(`QuotaPie · ${t("cli.quota-bar.unavailable", {}, locale)}`); }
  // Claude Code removes a status line entirely on nonzero exit.
  return 0;
}

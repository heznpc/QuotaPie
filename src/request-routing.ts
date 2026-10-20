import type { CompactionRequestEvent } from "../packages/quota-core/src/events.js";

const ongoing = (phase: string) => phase === "started" || phase === "response_headers";
const accountID = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);

export interface RequestRoute {
  requestId: string; threadId: string | null; turnId: string | null;
  kind: "compaction" | "response"; model: string; phase: string; status: number;
  startedAtMs: number; observedAtMs: number; finishedAtMs: number | null;
  sourceAccount: string | null; account: string | null;
  attribution: "pool-selection" | "relay-source" | "unknown";
  reason: string | null; switched: boolean | null; active: boolean;
  upstreamResponseObserved: boolean;
  activityUncertain?: boolean;
}
export interface RoutingSummary {
  checkedAtMs: number; freshness: "fresh" | "stale" | "unknown";
  activityUncertain: boolean;
  active: RequestRoute[]; recent: RequestRoute[];
  history?: RequestRoute[];
}
interface Generation {
  reachable: boolean; records: CompactionRequestEvent[]; health: any;
  healthRequestIds: Set<string>; activeIds: Set<string>;
}

export function summarizeRouting(generations: Generation[], nowMs: number, previous: RequestRoute[] = []): RoutingSummary {
  const retained = new Map<string, RequestRoute>(previous.map(row => [row.requestId, { ...row, active: false,
    activityUncertain: row.active || row.activityUncertain === true,
    ...(row.active ? { phase: "unverified" } : {}) }]));
  const observed = new Map<string, RequestRoute>();
  const conflicts = new Set<string>();
  for (const generation of generations) {
    const guard = generation.reachable && generation.health?.subscriptionGuardVersion === 1 && generation.health?.subscriptionGuard?.version === 1
      ? generation.health.subscriptionGuard : null;
    for (const event of generation.records) {
      const observedAtMs = Date.parse(event.at);
      if (observedAtMs > nowMs) continue;
      const saved = retained.get(event.requestId), selected = event.accountRouting;
      // Only an event present in this exact live health response can inherit its
      // source. A log file's location or a missing pool route cannot name a login.
      const source = generation.healthRequestIds.has(event.requestId) && accountID(guard?.account) ? guard.account as string : null;
      const verified = event.processingAccount?.evidence === "validated-outgoing-credentials" && accountID(event.processingAccount.account) ? event.processingAccount.account : null;
      const invalid = event.accountRoutingUnverified || !!(verified && selected && verified !== selected.account);
      const sourceAccount = invalid ? null : selected?.sourceAccount ?? verified ?? saved?.sourceAccount ?? source;
      const account = invalid ? null : verified ?? selected?.account ?? saved?.account ?? source;
      const attribution = invalid ? "unknown" : selected ? "pool-selection" : verified ? "relay-source" : saved?.account ? saved.attribution : source ? "relay-source" : "unknown";
      const active = generation.reachable && generation.activeIds.has(event.requestId) && ongoing(event.phase);
      const row: RequestRoute = { requestId: event.requestId, threadId: event.threadId, turnId: event.turnId,
        kind: event.kind, model: event.to, phase: ongoing(event.phase) && !active ? "unverified" : event.phase,
        status: event.status, startedAtMs: observedAtMs - event.durationMs, observedAtMs,
        finishedAtMs: ongoing(event.phase) ? null : observedAtMs, sourceAccount, account, attribution,
        reason: selected?.reason ?? saved?.reason ?? null,
        switched: sourceAccount && account ? sourceAccount !== account : null, active,
        activityUncertain: !active && ongoing(event.phase) && saved?.activityUncertain === true,
        upstreamResponseObserved: event.phase === "response_headers" || event.phase === "completed" && event.status >= 200 && event.status < 300 ||
          event.failureOrigin === "provider_http" || event.failureOrigin === "provider_protocol" || !!event.upstreamRequestIds };
      const prior = observed.get(row.requestId);
      if (conflicts.has(row.requestId) || prior && prior.account && row.account && (prior.account !== row.account || prior.sourceAccount !== row.sourceAccount)) {
        conflicts.add(row.requestId);
        // Conflicting generation evidence cannot silently pick one account.
        observed.set(row.requestId, { ...(prior && prior.observedAtMs > observedAtMs ? prior : row),
          sourceAccount: null, account: null, attribution: "unknown", reason: null, switched: null });
      } else if (!prior || observedAtMs >= prior.observedAtMs) observed.set(row.requestId, row);
    }
  }
  for (const [id, row] of observed) {
    const prior = retained.get(id);
    if (!prior || row.observedAtMs >= prior.observedAtMs) retained.set(id, row);
  }
  const rows = [...retained.values()].sort((a, b) => b.observedAtMs - a.observedAtMs);
  const uncertain = rows.filter(row => !row.active && row.activityUncertain);
  const history = new Map<string, RequestRoute>();
  for (const row of rows) {
    if (!row.threadId || !row.sourceAccount || !row.account || !row.upstreamResponseObserved || row.attribution === "unknown") continue;
    const key = row.threadId + ":" + row.sourceAccount;
    if (!history.has(key) && history.size < 1000) history.set(key, { ...row, active: false });
  }
  return { checkedAtMs: nowMs, freshness: generations.some(g => g.reachable) ? "fresh" : rows.length ? "stale" : "unknown",
    activityUncertain: uncertain.length > 0, history: [...history.values()],
    // Do not age out an unconfirmed live request merely because newer completed
    // requests arrived. A terminal observation or live reobservation resolves it.
    active: rows.filter(row => row.active).slice(0, 100),
    recent: [...uncertain, ...rows.filter(row => !row.active && !row.activityUncertain).slice(0, 50)] };
}

export function staleRouting(summary: RoutingSummary): RoutingSummary {
  return { ...summary, freshness: summary.checkedAtMs ? "stale" : "unknown", active: [],
    activityUncertain: summary.activityUncertain || summary.active.length > 0,
    recent: [...summary.active.map(row => ({ ...row, active: false, phase: "unverified", activityUncertain: true })), ...summary.recent] };
}

export interface CompactionRoute {
  from: string;
  to: string;
  /** Independent of the work model's reasoning effort. Older settings default to Low. */
  effort?: "low";
}

export const DEFAULT_COMPACTION_ROUTE: CompactionRoute = {
  from: "gpt-6-astra", to: "gpt-5.6-sol", effort: "low",
};

// Native v2 compaction was exercised with these targets at Low. A model's
// presence in the ordinary model picker does not establish this capability.
const TESTED_TARGETS = new Set(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]);

export function validateCompactionRoute(value: unknown): CompactionRoute {
  if (!value || typeof value !== "object") throw new Error("Invalid compaction policy");
  const route = value as CompactionRoute;
  for (const model of [route.from, route.to]) {
    if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) {
      throw new Error("Invalid model name");
    }
  }
  if (route.effort !== undefined && route.effort !== "low") {
    throw new Error("Only Low compaction effort has been validated");
  }
  if (route.from !== route.to && (route.from !== "gpt-6-astra" || !TESTED_TARGETS.has(route.to))) {
    throw new Error("This native compaction model pair has not been validated");
  }
  return { from: route.from, to: route.to, effort: "low" };
}

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCompaction(path: string, body: JsonObject): boolean {
  const last = Array.isArray(body.input) ? body.input.at(-1) : null;
  return path === "/responses/compact" || (
    path === "/responses" && object(last) && last.type === "compaction_trigger"
  );
}

/** The work request and Codex's saved settings are never mutated. */
export function routeCompaction(path: string, body: unknown, policy: CompactionRoute) {
  if (!object(body) || body.model !== policy.from || policy.from === policy.to || !isCompaction(path, body)) {
    return { body, routed: false };
  }
  const route = validateCompactionRoute(policy);
  return {
    body: { ...body, model: route.to, reasoning: { ...(object(body.reasoning) ? body.reasoning : {}), effort: route.effort } },
    routed: true,
  };
}

export function safeEffort(value: unknown): string | null {
  return typeof value === "string" && ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value)
    ? value : null;
}

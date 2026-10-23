const dependencies: Record<string, string[]> = {
  "request-account-selected": ["request-account-picker"],
  "request-account-apply": ["request-account-selected"],
  "request-account-choose-other": ["request-account-apply"],
  "request-account-switch-context": ["request-account-choose-other"],
  "request-account-current": ["request-account-picker"],
  "request-account-explicit-current": ["request-account-picker"],
  "request-account-scheduled": ["request-account-picker"],
  "request-account-unavailable": ["request-account-picker"],
  "account-action-switch": ["account-action-list"],
  "account-action-repeat": ["account-action-list"],
  "credit-recovery-allow": ["credit-recovery-blocked"],
  "account-list-navigation": ["account-list-mixed", "account-detail-second"],
};

/** Click coordinates come from earlier rendered observations, not constants. */
export function verificationScenarios<T extends { name: string }>(scenarios: T[], selection?: string): T[] {
  if (selection === undefined) return scenarios;
  const known = new Set(scenarios.map(s => s.name)), wanted = new Set<string>();
  function include(name: string) {
    if (!known.has(name)) throw new Error(`Unknown verification scenario: ${name || "(empty)"}`);
    if (wanted.has(name)) return;
    wanted.add(name);
    for (const prerequisite of dependencies[name] ?? []) include(prerequisite);
  }
  for (const name of selection.split(",")) include(name.trim());
  return scenarios.filter(s => wanted.has(s.name));
}

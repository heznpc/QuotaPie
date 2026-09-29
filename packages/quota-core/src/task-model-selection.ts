/** Explicit host choices only. This module never discovers capabilities or runs work. */
export interface TaskModelChoice {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

export interface TaskModelCapability {
  readonly provider: string;
  readonly model: string;
  readonly efforts: readonly string[];
}

export interface SelectTaskModelInput {
  readonly phase: string;
  readonly manualSelection?: TaskModelChoice | null;
  readonly phasePreferences?: Readonly<Record<string, TaskModelChoice | null | undefined>>;
  readonly defaultSelection?: TaskModelChoice | null;
  readonly capabilities: readonly TaskModelCapability[];
}

export type TaskModelSelectionSource = "manual" | "phase" | "default";
export type TaskModelSelectionReason =
  | "manual_selection" | "phase_preference" | "default_selection";
export type TaskModelUnavailableReason =
  | "invalid_phase" | "invalid_selection" | "no_selection"
  | "unsupported_provider" | "unsupported_model" | "unsupported_effort";

export type TaskModelSelectionResult =
  | {
      readonly status: "selected";
      readonly phase: string;
      readonly source: TaskModelSelectionSource;
      readonly selection: TaskModelChoice;
      readonly reason: TaskModelSelectionReason;
    }
  | {
      readonly status: "unavailable";
      readonly phase: string;
      readonly source: TaskModelSelectionSource | null;
      readonly selection: null;
      readonly requested: TaskModelChoice | null;
      readonly reason: TaskModelUnavailableReason;
    };

const reasons: Readonly<Record<TaskModelSelectionSource, TaskModelSelectionReason>> = {
  manual: "manual_selection",
  phase: "phase_preference",
  default: "default_selection",
};

/** Validate the highest-priority configured choice, without silent fallback. */
export function selectTaskModel(input: SelectTaskModelInput): TaskModelSelectionResult {
  const { phase, capabilities } = input;
  const unavailable = (
    reason: TaskModelUnavailableReason,
    source: TaskModelSelectionSource | null = null,
    requested: TaskModelChoice | null = null,
  ): TaskModelSelectionResult => ({ status: "unavailable", phase, source, selection: null, requested, reason });

  if (!phase.trim()) return unavailable("invalid_phase");
  const phaseChoice = input.phasePreferences && Object.hasOwn(input.phasePreferences, phase)
    ? input.phasePreferences[phase] : undefined;
  const source = input.manualSelection != null ? "manual"
    : phaseChoice != null ? "phase"
    : input.defaultSelection != null ? "default" : null;
  const choice = input.manualSelection ?? phaseChoice ?? input.defaultSelection;
  if (source === null || choice == null) return unavailable("no_selection");

  // Project only the contract fields; neither return nor retain a host settings object.
  const selection: TaskModelChoice = {
    provider: choice.provider,
    model: choice.model,
    ...(choice.effort !== undefined ? { effort: choice.effort } : {}),
  };
  if (!selection.provider.trim() || !selection.model.trim() ||
      (selection.effort !== undefined && !selection.effort.trim())) {
    return unavailable("invalid_selection", source, selection);
  }
  const provider = capabilities.filter(row => row.provider === selection.provider);
  if (!provider.length) return unavailable("unsupported_provider", source, selection);
  const models = provider.filter(row => row.model === selection.model);
  if (!models.length) return unavailable("unsupported_model", source, selection);
  const effort = selection.effort;
  if (effort !== undefined && !models.some(row => row.efforts.includes(effort))) {
    return unavailable("unsupported_effort", source, selection);
  }
  return { status: "selected", phase, source, selection, reason: reasons[source] };
}

import { createHash } from "node:crypto";
import { selectTaskModel } from "./task-model-selection.js";
import { object, safeEffort } from "./codex-compaction-policy.js";

export interface TaskSavingsPolicy { enabled: boolean; model: "gpt-5.6-luna"; effort: "low"; bypassThreads?: string[]; testOnly?: boolean }
export const DEFAULT_TASK_SAVINGS: TaskSavingsPolicy = { enabled: true, model: "gpt-5.6-luna", effort: "low" };
export function validateTaskSavings(value: unknown): TaskSavingsPolicy {
  if (!object(value) || typeof value.enabled !== "boolean" || value.model !== "gpt-5.6-luna" || value.effort !== "low") {
    throw new Error("invalid_savings_policy");
  }
  if (value.testOnly !== undefined && typeof value.testOnly !== "boolean") throw new Error("invalid_savings_policy");
  if (value.bypassThreads !== undefined && (!Array.isArray(value.bypassThreads) || value.bypassThreads.length > 256 || value.bypassThreads.some(id => typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)))) throw new Error("invalid_savings_policy");
  return { enabled: value.enabled, model: value.model, effort: value.effort, bypassThreads: value.bypassThreads ?? [], testOnly: value.testOnly ?? false };
}
export type SavingsReason = "disabled" | "simple_text_edit" | "test_only" | "uncertain_task" | "keep_setting" | "manual_change" | "extended_work" | "failure_fallback" | "unsupported_model" | "unidentified_task" | "task_disabled";
export interface SavingsDecision { body: unknown; routed: boolean; reason: SavingsReason }
export interface TaskState { prompt: string; setting: string; requests: number; fallback: SavingsReason | null }

/** Local, conservative pre-request classification. No extra model calls or saved prompts. */
export class TaskSavingsRouter {
  constructor(private supported: () => boolean = () => false,
    private tasks = new Map<string, TaskState>()) {}

  route(input: unknown, policy: TaskSavingsPolicy, threadId: string | null): SavingsDecision {
    const keep = (reason: SavingsReason): SavingsDecision => ({ body: input, routed: false, reason });
    if (!policy.enabled) { this.tasks.clear(); return keep("disabled"); }
    if (!object(input) || !Array.isArray(input.input)) return keep("uncertain_task");
    if (!threadId) return keep("unidentified_task");
    if (policy.bypassThreads?.includes(threadId)) return keep("task_disabled");
    let lastUser = input.input.length - 1;
    while (lastUser >= 0 && !(object(input.input[lastUser]) && input.input[lastUser].role === "user")) lastUser--;
    const message = input.input[lastUser];
    if (!object(message)) return keep("uncertain_task");
    const content = message.content;
    // Images/files and ambiguous long prompts require the user's chosen model.
    if (!Array.isArray(content) || content.some(part => !object(part) || !["input_text", "text"].includes(String(part.type)))) return keep("uncertain_task");
    const text = content.map(part => part.text ?? "").join("\n").trim();
    const fingerprint = createHash("sha256").update(text).digest("hex");
    const setting = `${input.model}:${safeEffort(object(input.reasoning) ? input.reasoning.effort : null)}`;
    let state = this.tasks.get(threadId);
    if (!state || state.prompt !== fingerprint) {
      // A changed composer choice between turns is also a manual override.
      const manual = state && (state.setting !== setting || state.fallback === "manual_change");
      state = { prompt: fingerprint, setting, requests: 0, fallback: manual ? "manual_change" : null };
      this.tasks.delete(threadId); this.tasks.set(threadId, state);
      if (this.tasks.size > 256) this.tasks.delete(this.tasks.keys().next().value!);
    }
    if (state.setting !== setting) state.fallback = "manual_change";
    if (state.fallback) return keep(state.fallback);
    if (input.model !== "gpt-6-astra" || !["high", "xhigh", "max", "ultra"].includes(String(object(input.reasoning) ? input.reasoning.effort : ""))) return keep("keep_setting");
    if (!this.supported()) return keep("unsupported_model");
    const phase = text.length <= 600 && simpleTextEdit(text) ? "simple_text_edit"
      : policy.testOnly && testOnly(text) ? "test_only" : null;
    if (!phase) return keep("uncertain_task");
    const selection = selectTaskModel({ phase,
      phasePreferences: { [phase]: { provider: "codex", model: policy.model, effort: policy.effort } },
      capabilities: [{ provider: "codex", model: policy.model, efforts: [policy.effort] }] });
    if (selection.status !== "selected") return keep("unsupported_model");
    // Only outputs following this request count. Old failures in history do not.
    const outputs = input.input.slice(lastUser + 1).filter((item: unknown) => object(item) && ["function_call_output", "custom_tool_call_output"].includes(String(item.type)));
    if (outputs.some(item => /(?:exit(?:ed with)?(?:_code| code)?[":\s]+[1-9]|\b(?:FAIL|FAILED|error:|tests? failed)\b)/i.test(typeof item.output === "string" ? item.output.slice(0,16000) : ""))) {
      state.fallback = "failure_fallback"; return keep(state.fallback);
    }
    if (++state.requests > 8) { state.fallback = "extended_work"; return keep(state.fallback); }
    return { body: { ...input, model: selection.selection.model, reasoning: { ...(object(input.reasoning) ? input.reasoning : {}), effort: selection.selection.effort } }, routed: true, reason: phase };
  }

  failed(threadId: string | null) {
    const state = threadId ? this.tasks.get(threadId) : undefined;
    if (state && !state.fallback) state.fallback = "failure_fallback";
  }
}

function simpleTextEdit(text: string): boolean {
  if (/```|https?:|\b(?:auth|payment|database|security|architecture|refactor|implement|build|deploy|migrate|api|model|reasoning|astra|luna|terra|sol)\b|인증|결제|데이터베이스|보안|설계|리팩터|모델|추론|오류|버그|기능 추가|전체|여러 파일/i.test(text)) return false;
  const scope = /\b(?:button|label|heading|title|placeholder|typo|wording)\b|버튼|라벨|제목|문구|오타|글자|플레이스홀더/i.test(text);
  const change = /\b(?:change|replace|rename|fix|correct)\b|바꿔|바꾸|변경|수정|고쳐|교체/i.test(text);
  const bounded = /["“'‘「][^"”'’」\n]{1,100}["”'’」]|\btypo\b|오타/.test(text);
  return scope && change && bounded;
}

// Only standalone requests to run existing tests. Fixes, deployments, arbitrary
// commands and conditional follow-up work retain the original model.
function testOnly(text: string): boolean {
  return /^(?:please )?run (?:the )?(?:existing )?(?:tests?|test suite|npm test|bun test|swift test|pytest)(?: (?:and report (?:the )?results?|only))?[.!]?$/i.test(text)
    || /^(?:기존 )?테스트만 (?:실행해|실행해줘|돌려줘|실행해 주세요)(?:[.,]? 결과(?:만)? (?:알려줘|보고해줘))?[.!]?$/.test(text);
}

import { createHash } from "node:crypto";
import { t, type Locale } from "../i18n";
import type { TriggerDecision } from "../types";

export interface ResumeNoticeIncident {
  id: string; account: string; threadId: string; projectLabel: string; state: string; reason?: string;
  quotaAccount?: string; quotaAccountLabel?: string; quotaTargetState?: "candidate" | "confirmed" | "used";
  localRepairChildIncidentId?: string; localRepairParentIncidentId?: string;
  localRepairReason?: string; repairReason?: string;
}

/** Follow only the bounded, reciprocal repair chain. Display grouping never grants execution authority. */
export function resumeNoticeFamily(incident: ResumeNoticeIncident, incidents: ResumeNoticeIncident[]): ResumeNoticeIncident[] {
  const chain = [incident], seen = new Set([incident.id]);
  const edge = (parent: ResumeNoticeIncident, child: ResumeNoticeIncident) => parent.id !== child.id &&
    parent.state === "needs-review" && parent.reason === "host-queue-turn-failed" &&
    parent.localRepairReason === "local-before-send-repair-linked" && child.repairReason === "local-before-send-repair" &&
    parent.localRepairChildIncidentId === child.id && child.localRepairParentIncidentId === parent.id &&
    parent.account === child.account && parent.threadId === child.threadId;
  let current = incident;
  while (current.localRepairParentIncidentId) {
    const parent = incidents.find(item => item.id === current.localRepairParentIncidentId);
    if (!parent || !edge(parent, current) || seen.has(parent.id) || chain.length >= 3) return [incident];
    chain.unshift(parent); seen.add(parent.id); current = parent;
  }
  current = incident;
  while (current.localRepairChildIncidentId) {
    const child = incidents.find(item => item.id === current.localRepairChildIncidentId);
    if (!child || !edge(current, child) || seen.has(child.id) || chain.length >= 3) return [incident];
    chain.push(child); seen.add(child.id); current = child;
  }
  return chain;
}

export function autoResumeIncidentNotice(incident: ResumeNoticeIncident, sourceAccount: string, familyId: string, locale: Locale): TriggerDecision {
  const stage = incident.state === "running" || incident.state === "queued" ? "queued" :
    incident.state === "resumed" ? "resumed" : incident.state === "needs-review" ? "review" : "waiting";
  const titleKey = "alert.resume.auto.incident.title";
  const messageKey = `alert.resume.auto.incident.${stage}.message` as const;
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80);
  const params = { label: clean(incident.projectLabel), sourceAccount: clean(sourceAccount),
    ...(incident.quotaAccount && ["candidate", "confirmed", "used"].includes(incident.quotaTargetState ?? "") ? {
      quotaAccountLabel: clean(incident.quotaAccountLabel || incident.quotaAccount), quotaTargetState: incident.quotaTargetState,
    } : {}),
    notificationGroup: createHash("sha256").update(JSON.stringify([incident.account, incident.threadId, familyId])).digest("hex"),
    provider: "codex", accountId: incident.account, incidentId: incident.id };
  return { key: `auto-resume:incident:${incident.id}:${stage === "queued" ? "accepted" : incident.state}`,
    title: t(titleKey, params, locale), message: t(messageKey, params, locale),
    presentation: { title: { key: titleKey, params: { label: params.label } }, message: { key: messageKey, params } },
    severity: incident.state === "needs-review" ? "warning" : "info" };
}

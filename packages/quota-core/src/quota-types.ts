export type Provider = "codex" | "claude";

export type SourceQuality = "authoritative" | "fallback" | "derived";

export interface QuotaObservation {
  provider: Provider;
  account: string;
  bucket: string;
  label: string;
  windowSeconds: number | null;
  usedPercent: number | null;
  resetsAtMs: number | null;
  observedAtMs: number;
  source: string;
  quality: SourceQuality;
  creditBalance?: number | null;
  resetCreditsAvailable?: number | null;
  metadata?: Record<string, string | number | boolean | null>;
}

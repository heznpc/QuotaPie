import type { Locale } from "../i18n";
import type { ResetSignal } from "./classify";

type Schedule = { targetAtMs: number; sourceZone: string; qualifier: "at" | "by" | "around" };
// Abbreviations explicitly supplied by the author are fixed offsets. PT/ET
// mean regional civil time, including DST; never silently treat PST as PT.
const zones: Record<string, number | string> = {
  PST: -480, PDT: -420, PT: "America/Los_Angeles", EST: -300, EDT: -240, ET: "America/New_York",
  UTC: 0, GMT: 0, KST: 540, JST: 540, CET: 60, CEST: 120,
};
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const endOfDayPattern = /\b(?:EOD|end\s+of\s+(?:the\s+)?day)\b/i;
export function announcementTimeHint(text: string): string | null {
  const deadline = text.match(/[^.!?\n]*\b(?:EOD|end\s+of\s+(?:the\s+)?day)\b[^.!?\n]*/i)?.[0]?.trim();
  if (deadline) return deadline.slice(0, 300);
  return text.match(/[^.!?\n]*(?:\btomorrow\b|\btoday\b|\bmidnight\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|PST|PDT|PT|UTC)\b|\bin\s+(?:~\s*)?(?:\d+|one|an?)\s+hours?\b)[^.!?\n]*/i)?.[0]?.trim().slice(0, 300) ?? null;
}

function signalTimeText(signal: ResetSignal): string {
  return signal.sourcePostId ? signal.change?.evidence ?? "" : signal.timeHint ?? signal.text;
}
function parts(ms: number, zone: number | string) {
  if (typeof zone === "number") {
    const d = new Date(ms + zone * 60_000);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
  }
  const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(ms);
  return ["year", "month", "day", "hour", "minute"].map(key => Number(p.find(x => x.type === key)!.value));
}
function instant(wall: number[], zone: number | string): number | null {
  const [y, m, d, h, min] = wall as [number, number, number, number, number];
  const utc = Date.UTC(y, m - 1, d, h, min);
  if (typeof zone === "number") return utc - zone * 60_000;
  // Check offsets on both sides of DST transitions and round-trip. A missing
  // (spring) or repeated (autumn) clock time is not an unambiguous instant.
  const offsets = new Set([-36, 0, 36].map(hours => {
    const probe = utc + hours * 3600_000;
    const [py, pm, pd, ph, pmin] = parts(probe, zone) as [number, number, number, number, number];
    return Date.UTC(py, pm - 1, pd, ph, pmin) - probe;
  }));
  const candidates = [...offsets].map(offset => utc - offset).filter(ms => parts(ms, zone).every((v, i) => v === wall[i]));
  return candidates.length === 1 ? candidates[0]! : null;
}

function sourceTimeZone(text: string): string | null {
  const zoneNames = [...text.matchAll(/\b(PST|PDT|PT|EST|EDT|ET|UTC|GMT|KST|JST|CET|CEST)\b/gi)].map(m => m[1]!.toUpperCase());
  return new Set(zoneNames).size === 1 ? zoneNames[0]! : null;
}

function sourceDate(text: string, publishedAtMs: number, zone: number | string, implicitToday = false): number[] | null {
  let [year, month, day] = parts(publishedAtMs, zone) as [number, number, number];
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const named = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
  const relative = text.match(/\b(today|tomorrow)\b/i);
  const weekday = text.match(/\b(next\s+)?(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i);
  if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (named) {
    month = months.indexOf(named[1]!.slice(0, 3).toLowerCase()) + 1; day = Number(named[2]);
    if (named[3]) year = Number(named[3]);
    // A yearless December/January date can refer to either year. Do not guess.
    else if (Math.abs(month - parts(publishedAtMs, zone)[1]!) > 6) return null;
  } else if (relative || weekday) {
    const base = new Date(Date.UTC(year, month - 1, day));
    let offset = relative ? (relative[1]!.toLowerCase() === "tomorrow" ? 1 : 0)
      : (weekdays.indexOf(weekday![2]!.toLowerCase()) - base.getUTCDay() + 7) % 7;
    if (weekday?.[1] && offset === 0) offset = 7;
    base.setUTCDate(base.getUTCDate() + offset);
    [year, month, day] = [base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()];
  } else if (!implicitToday || /\d|\b(?:day|week|month|year|mon|tue|wed|thu|fri|sat|sun|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\b/i.test(text.replace(endOfDayPattern, ""))) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return [year, month, day];
}

const clocksIn = (text: string) => [...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})(?!\d)|\b(noon)\b/gi)];

export function parseAnnouncementTime(text: string, publishedAtMs: number): Schedule | null {
  if (!Number.isFinite(publishedAtMs)) return null;
  const sourceZone = sourceTimeZone(text);
  if (!sourceZone) return null;
  const zone = zones[sourceZone]!;
  const clocks = clocksIn(text);
  if (clocks.length !== 1) return null;
  const clock = clocks[0]!;
  let hour = clock[6] ? 12 : Number(clock[1] ?? clock[4]);
  const minute = Number(clock[2] ?? clock[5] ?? 0);
  if (minute > 59 || hour > (clock[3] ? 12 : 23) || clock[3] && hour < 1) return null;
  if (clock[3]) hour = hour % 12 + (clock[3].toLowerCase() === "pm" ? 12 : 0);
  const date = sourceDate(text, publishedAtMs, zone);
  if (!date) return null;
  const targetAtMs = instant([...date, hour, minute], zone);
  if (targetAtMs == null) return null;
  return { targetAtMs, sourceZone, qualifier: /\b(?:around|about|approximately)\b/i.test(text) ? "around" : /\bby\b/i.test(text) ? "by" : "at" };
}

/** A calendar-day boundary for display only, never a scheduled reset instant. */
function endOfDayBoundary(text: string, publishedAtMs: number): Schedule | null {
  if (!Number.isFinite(publishedAtMs) || !endOfDayPattern.test(text) || clocksIn(text).length) return null;
  // Do not turn unsupported or conflicting date references into "today".
  if (/\b(?:yesterday|day\s+(?:after|before)|next\s+(?:week|month|year)|in\s+\d+\s+days?)\b/i.test(text) ||
      /\btoday\b/i.test(text) && /\btomorrow\b/i.test(text)) return null;
  const sourceZone = sourceTimeZone(text);
  if (!sourceZone) return null;
  const zone = zones[sourceZone]!;
  const date = sourceDate(text, publishedAtMs, zone, true);
  if (!date) return null;
  const next = new Date(Date.UTC(date[0]!, date[1]! - 1, date[2]! + 1));
  const targetAtMs = instant([next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0], zone);
  return targetAtMs == null ? null : { targetAtMs, sourceZone, qualifier: "by" };
}

export function withAnnouncementTime(signal: ResetSignal): ResetSignal {
  const schedule = parseAnnouncementTime(signalTimeText(signal), signal.publishedAtMs);
  return schedule ? { ...signal, targetAtMs: schedule.targetAtMs } : { ...signal, targetAtMs: null };
}

export function localAnnouncementTime(signal: ResetSignal, locale: Locale, timeZone: string): string | null {
  const text = signalTimeText(signal);
  const explicit = parseAnnouncementTime(text, signal.publishedAtMs);
  const boundary = explicit ? null : endOfDayBoundary(text, signal.publishedAtMs);
  const schedule = explicit ?? boundary;
  const target = schedule?.targetAtMs;
  if (target == null || !Number.isFinite(target)) return null;
  const dateFormatter = new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    timeZone, year: "numeric", month: "short", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const date = dateFormatter.formatToParts(target).map(part =>
    part.type === "timeZoneName" && timeZone === "Asia/Seoul" ? "KST" : part.value).join("");
  if (boundary) {
    const source = parts(target - 1, zones[boundary.sourceZone]!);
    const local = parts(target, timeZone);
    const localZone = timeZone === "Asia/Seoul" ? "KST" : new Intl.DateTimeFormat("en-US", {
      timeZone, timeZoneName: "short",
    }).formatToParts(target).find(p => p.type === "timeZoneName")!.value;
    const stamp = (p: number[]) => `${p[0] !== parts(signal.publishedAtMs, zones[boundary.sourceZone]!)[0] ? `${p[0]}/` : ""}${p[1]}/${p[2]}`;
    const time = `${String(local[3]).padStart(2, "0")}:${String(local[4]).padStart(2, "0")}`;
    return `${boundary.sourceZone} ${stamp(source)} EOD → ${localZone} ${stamp(local)} ${time}${locale === "ko" ? " 전 · 시각 미정" : " latest · time unknown"}`;
  }
  const qualifier = schedule?.qualifier === "by" ? (locale === "ko" ? "까지" : "By ") : schedule?.qualifier === "around" ? (locale === "ko" ? "경" : "Around ") : "";
  const label = locale === "ko" ? `${date}${qualifier}` : `${qualifier}${date}`;
  const source = parts(target, zones[schedule!.sourceZone]!);
  return `${schedule!.sourceZone} ${source[1]}/${source[2]} ${String(source[3]).padStart(2, "0")}:${String(source[4]).padStart(2, "0")} → ${label}`;
}

import { describe, expect, test } from "bun:test";
import { DEFAULT_LOCALE, humanGap, LOCALES, resolveLocale, t, windowKindOf } from "../src/i18n";
import { ALERTABLE_EVENT_KINDS } from "../src/types";

describe("locale resolution", () => {
  test("English is the default when nothing recognisable is set", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(resolveLocale("auto", {})).toBe("en");
    expect(resolveLocale("auto", { LANG: "fr_FR.UTF-8" })).toBe("en");
    expect(resolveLocale(null, {})).toBe("en");
  });

  test("an explicit locale wins over the environment", () => {
    expect(resolveLocale("ko", { LANG: "en_US.UTF-8" })).toBe("ko");
    expect(resolveLocale("en", { LANG: "ko_KR.UTF-8" })).toBe("en");
  });

  test("auto reads the environment in the order a shell sets it", () => {
    expect(resolveLocale("auto", { LANG: "ko_KR.UTF-8" })).toBe("ko");
    expect(resolveLocale("auto", { LC_ALL: "ko-KR" })).toBe("ko");
    expect(resolveLocale("auto", { QUOTAPIE_LOCALE: "ko", LANG: "en_US" })).toBe("ko");
    // Only the language subtag matters.
    expect(resolveLocale("auto", { LANG: "ko" })).toBe("ko");
  });
});

describe("message catalog", () => {
  test("every alertable event kind has a sentence in every locale", () => {
    for (const kind of ALERTABLE_EVENT_KINDS) {
      for (const locale of LOCALES) {
        const rendered = t(`event.${kind}`, { label: "W", provider: "codex", limitId: "x", lane: "y" }, locale);
        expect(rendered).not.toBe(`event.${kind}`);
        expect(rendered.length).toBeGreaterThan(0);
      }
    }
  });

  test("every collection state has a sentence in every locale", () => {
    const keys = [
      "auth-required", "auth-expired", "rate-limited", "network", "not-configured",
      "isolation-unsafe", "provider-error", "no-windows",
      "never-attempted", "stale-success", "attempted-then-failed",
    ];
    for (const key of keys) {
      for (const locale of LOCALES) {
        expect(t(`collection.${key}`, {}, locale)).not.toBe(`collection.${key}`);
      }
    }
  });

  test("an unknown key surfaces itself rather than rendering as empty", () => {
    expect(t("nope.not.here", {}, "en")).toBe("nope.not.here");
  });

  test("the same key says different things in different locales", () => {
    expect(t("headline.setup", {}, "en")).toBe("Setup needed");
    expect(t("headline.setup", {}, "ko")).toBe("설정 필요");
  });
});

describe("window kinds and gaps", () => {
  test("window kind is derived from length, longest first", () => {
    expect(windowKindOf(30 * 86_400)).toBe("monthly");
    expect(windowKindOf(7 * 86_400)).toBe("weekly");
    expect(windowKindOf(18_000)).toBe("five-hour");
    expect(windowKindOf(2 * 86_400)).toBe("other");
    expect(windowKindOf(null)).toBe("other");
  });

  test("a gap is spoken in each locale's units", () => {
    expect(humanGap(8_259, "en")).toBe("5 days 17 hours");
    expect(humanGap(8_259, "ko")).toBe("5일 17시간");
    expect(humanGap(90, "en")).toBe("1 hour 30 minutes");
    expect(humanGap(1, "en")).toBe("1 minute");
    expect(humanGap(2, "en")).toBe("2 minutes");
  });
});

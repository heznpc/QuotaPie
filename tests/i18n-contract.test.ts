import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MESSAGE_KEYS } from "../src/i18n";

function stringsKeys(locale: "en" | "ko"): Set<string> {
  const source = readFileSync(
    resolve(import.meta.dir, `../macos/QuotaPie/Resources/${locale}.lproj/Localizable.strings`),
    "utf8",
  );
  return new Set(
    [...source.matchAll(/^"((?:[^"\\]|\\.)+)"\s*=/gm)].map((match) => match[1]!),
  );
}

describe("semantic localization contract", () => {
  test("every semantic key consumed by the app exists in both native catalogs", () => {
    const wireKeys = MESSAGE_KEYS.filter((key) =>
      key.startsWith("event.") || key.startsWith("alert.") || key.startsWith("collection.")
    );
    expect(wireKeys.length).toBeGreaterThan(0);

    for (const locale of ["en", "ko"] as const) {
      const catalog = stringsKeys(locale);
      expect(wireKeys.filter((key) => !catalog.has(key))).toEqual([]);
    }
  });

  test("every semantic event key exists in both browser locale catalogs", () => {
    const dashboard = readFileSync(resolve(import.meta.dir, "../src/dashboard.html"), "utf8");
    const eventKeys = MESSAGE_KEYS.filter((key) => key.startsWith("event."));

    for (const key of eventKeys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(dashboard.match(new RegExp(`"${escaped}"\\s*:`, "g"))?.length ?? 0).toBe(2);
    }
  });
});

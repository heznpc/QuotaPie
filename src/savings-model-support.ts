import { readFileSync, statSync } from "node:fs";

function fileIdentity(path: string) {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error("invalid_catalog");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** Health checks share a catalog parse until the file changes. Missing or
 * malformed catalogs never retain a previously supported model. */
export function createSavingsModelSupport(path: string, read = (path: string) => readFileSync(path, "utf8")) {
  let identity: string | undefined;
  let supported = false;
  return () => {
    try {
      const nextIdentity = fileIdentity(path);
      if (nextIdentity === identity) return supported;
      let nextSupported = false;
      try {
        const catalog = JSON.parse(read(path));
        nextSupported = Array.isArray(catalog?.models) && catalog.models.some((model: any) =>
          model?.slug === "gpt-5.6-luna" && Array.isArray(model.supported_reasoning_levels) &&
          model.supported_reasoning_levels.some((level: any) => level?.effort === "low"));
      } catch { /* Cache malformed contents only for this exact file version. */ }
      if (fileIdentity(path) !== nextIdentity) {
        identity = undefined;
        supported = false;
        return false;
      }
      identity = nextIdentity;
      supported = nextSupported;
      return supported;
    } catch {
      identity = undefined;
      supported = false;
      return false;
    }
  };
}

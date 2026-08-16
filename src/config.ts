import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Provider } from "./types";

export interface TimeRange {
  start: string;
  end: string;
}

export interface CodexAccountConfig {
  id: string;
  label: string;
  codexHome: string | null;
  enabled: boolean;
}

export interface ClaudeAccountConfig {
  id: string;
  label: string;
  configDir: string;
  enabled: boolean;
}

export interface AppConfig {
  profile: {
    timeZone: string;
    recentLookbackMinutes: number;
    historyDays: number;
    recentWeight: number;
    workSchedule: {
      weekday: TimeRange[];
      weekend: TimeRange[];
    };
  };
  reservePercent: Record<Provider, { short: number; weekly: number; other: number }>;
  accounts: {
    codex: CodexAccountConfig[];
    claude: ClaudeAccountConfig[];
  };
  collection: {
    pollSeconds: number;
    staleAfterSeconds: number;
    codexCommand: string;
    codexEnabled: boolean;
    claudeSessionTtlSeconds: number;
  };
  alerts: {
    enabled: boolean;
    staleProviders: Provider[];
    remainingThresholds: number[];
    predictedEarlyMinutes: number;
    cooldownMinutes: number;
    deliveryTimeoutSeconds: number;
    macOSNotifications: boolean;
    command: string[] | null;
  };
  dashboard: {
    host: string;
    port: number;
  };
  detection: {
    reliefDropPercent: number;
    meterCorrectionPercent: number;
    resetToleranceMinutes: number;
    rebaseToleranceMinutes: number;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  profile: {
    timeZone: "Asia/Seoul",
    recentLookbackMinutes: 120,
    historyDays: 28,
    recentWeight: 0.7,
    workSchedule: {
      weekday: [{ start: "09:00", end: "02:00" }],
      weekend: [{ start: "11:00", end: "01:00" }],
    },
  },
  reservePercent: {
    codex: { short: 10, weekly: 15, other: 10 },
    claude: { short: 10, weekly: 15, other: 10 },
  },
  accounts: {
    codex: [{ id: "default", label: "Main", codexHome: null, enabled: true }],
    claude: [{ id: "default", label: "Main", configDir: "~/.claude", enabled: true }],
  },
  collection: {
    pollSeconds: 60,
    staleAfterSeconds: 600,
    codexCommand: "codex",
    codexEnabled: true,
    claudeSessionTtlSeconds: 900,
  },
  alerts: {
    enabled: true,
    staleProviders: ["codex"],
    remainingThresholds: [20, 10, 5],
    predictedEarlyMinutes: 30,
    cooldownMinutes: 30,
    deliveryTimeoutSeconds: 30,
    macOSNotifications: true,
    command: null,
  },
  dashboard: {
    host: "127.0.0.1",
    port: 47831,
  },
  detection: {
    reliefDropPercent: 15,
    meterCorrectionPercent: 3,
    resetToleranceMinutes: 15,
    rebaseToleranceMinutes: 2,
  },
};

export function configPath(): string {
  return process.env.TIMEQUOTA_CONFIG
    ? resolve(process.env.TIMEQUOTA_CONFIG)
    : resolve(homedir(), ".config", "timequota", "config.json");
}

export function dataDirectory(): string {
  return process.env.TIMEQUOTA_HOME
    ? resolve(process.env.TIMEQUOTA_HOME)
    : resolve(homedir(), ".local", "share", "timequota");
}

export function resolveUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

export function codexProfileRoot(profile: CodexAccountConfig): string {
  return resolveUserPath(profile.codexHome ?? process.env.CODEX_HOME ?? "~/.codex");
}

export function codexUsesFileCredentials(profile: CodexAccountConfig): boolean {
  try {
    const contents = readFileSync(resolve(codexProfileRoot(profile), "config.toml"), "utf8");
    return /(^|\n)\s*cli_auth_credentials_store\s*=\s*["']file["']/m.test(contents);
  } catch {
    return false;
  }
}

function mergeConfig(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return {
    ...base,
    ...patch,
    profile: {
      ...base.profile,
      ...patch.profile,
      workSchedule: {
        ...base.profile.workSchedule,
        ...patch.profile?.workSchedule,
      },
    },
    reservePercent: {
      codex: { ...base.reservePercent.codex, ...patch.reservePercent?.codex },
      claude: { ...base.reservePercent.claude, ...patch.reservePercent?.claude },
    },
    accounts: {
      codex: patch.accounts?.codex ?? base.accounts.codex,
      claude: patch.accounts?.claude ?? base.accounts.claude,
    },
    collection: { ...base.collection, ...patch.collection },
    alerts: { ...base.alerts, ...patch.alerts },
    dashboard: { ...base.dashboard, ...patch.dashboard },
    detection: { ...base.detection, ...patch.detection },
  };
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;

function validateAccounts(config: AppConfig): void {
  for (const provider of ["codex", "claude"] as const) {
    const profiles: unknown = config.accounts[provider];
    if (!Array.isArray(profiles)) throw new Error(`${provider} accounts must be an array`);
    const ids = new Set<string>();
    const activeHomes = new Map<string, string>();
    for (const rawProfile of profiles) {
      if (!rawProfile || typeof rawProfile !== "object") {
        throw new Error(`${provider} account entries must be objects`);
      }
      const profile = rawProfile as Record<string, unknown>;
      const id = typeof profile.id === "string" ? profile.id : "";
      if (!ACCOUNT_ID.test(id)) {
        throw new Error(
          `${provider} account id ${JSON.stringify(profile.id)} must match ${ACCOUNT_ID.source}`,
        );
      }
      if (ids.has(id)) throw new Error(`duplicate ${provider} account id: ${id}`);
      ids.add(id);
      if (typeof profile.label !== "string" || profile.label.trim() === "") {
        throw new Error(`${provider} account ${id} requires a non-empty label`);
      }
      if (typeof profile.enabled !== "boolean") {
        throw new Error(`${provider} account ${id} requires a boolean enabled value`);
      }
      let home: string;
      if (provider === "codex") {
        if (profile.codexHome !== null && (
          typeof profile.codexHome !== "string" || profile.codexHome.trim() === ""
        )) {
          throw new Error(`codex account ${id} has an invalid codexHome`);
        }
        home = codexProfileRoot(profile as unknown as CodexAccountConfig);
      } else {
        if (typeof profile.configDir !== "string" || profile.configDir.trim() === "") {
          throw new Error(`claude account ${id} has an invalid configDir`);
        }
        home = resolveUserPath(profile.configDir);
      }
      if (!profile.enabled) continue;
      const previous = activeHomes.get(home);
      if (previous) {
        throw new Error(
          `${provider} accounts ${previous} and ${id} use the same profile directory`,
        );
      }
      activeHomes.set(home, id);
    }
  }
}

export function loadConfig(path = configPath()): AppConfig {
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
  const config = mergeConfig(DEFAULT_CONFIG, parsed);
  validateAccounts(config);
  return config;
}

export function writeDefaultConfig(path = configPath(), force = false): string {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existsSync(path) && !force) {
    chmodSync(path, 0o600);
    return path;
  }
  writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

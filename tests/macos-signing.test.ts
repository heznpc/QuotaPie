import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_HELPER_IDENTIFIER, developerIdentities, hasStableHelperDesignatedRequirement, signingIdentity, signMacOSApp, verifyPrebuiltClaudeHelper, type SigningRun } from "../script/sign-macos";

const hash = "A".repeat(40), renewedHash = "B".repeat(40), otherHash = "C".repeat(40);
const team = "FIXTURE123", otherTeam = "OTHERTEAM1";
const identity = (hash: string, team: string) => `1) ${hash} "Developer ID Application: Fixture (${team})"`;
const stableRequirement = `designated => identifier "${CLAUDE_HELPER_IDENTIFIER}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${team}`;

function fixture(previousSignature = `TeamIdentifier=${team}`) {
  const root = mkdtempSync(join(tmpdir(), "quotapie-signing-"));
  const app = join(root, "new/QuotaPie.app"), previous = join(root, "old/QuotaPie.app");
  for (const path of [app, previous]) {
    mkdirSync(join(path, "Contents/Helpers"), { recursive: true });
    writeFileSync(join(path, "Contents/Helpers/QuotaPieClaudeSessionHelper"), "fixture code");
  }
  const calls: string[][] = [];
  let identities = identity(hash, team);
  const run: SigningRun = async command => {
    calls.push(command);
    if (command[0] === "/usr/bin/security") return identities;
    if (command.includes("-r-")) return stableRequirement;
    if (command.includes("--display")) return command.at(-1)?.startsWith(previous) ? previousSignature
      : `TeamIdentifier=${team}\nIdentifier=${CLAUDE_HELPER_IDENTIFIER}`;
    return "";
  };
  return { app, previous, calls, run, setIdentities: (value: string) => { identities = value; },
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("helper signing fixes identity across code changes while retaining Apple's anchored requirement", async () => {
  const f = fixture();
  try {
    for (const code of ["first binary", "updated binary"]) {
      writeFileSync(join(f.app, "Contents/Helpers/QuotaPieClaudeSessionHelper"), code);
      await signMacOSApp(f.app, { run: f.run, previousApp: f.previous });
    }
    const helperSigns = f.calls.filter(command => command.includes("--sign") && command.at(-1)?.endsWith("/QuotaPieClaudeSessionHelper"));
    expect(helperSigns).toHaveLength(2);
    expect(helperSigns[0]).toEqual(helperSigns[1]);
    expect(helperSigns[0]).toContain(CLAUDE_HELPER_IDENTIFIER);
    expect(helperSigns[0]).toContain(hash);
    expect(helperSigns[0]).toContain("--timestamp");
    expect(helperSigns[0]).not.toContain("--requirements");
    expect(helperSigns[0]).not.toContain("-");
    const checks = f.calls.filter(command => command.includes("-R"));
    expect(checks).toHaveLength(2);
    const requirement = checks[0]![checks[0]!.indexOf("-R") + 1]!;
    expect(requirement.startsWith("=identifier ")).toBe(true);
    expect(requirement).toContain(`identifier "${CLAUDE_HELPER_IDENTIFIER}" and anchor apple generic`);
    expect(requirement).toContain("certificate leaf[field.1.2.840.113635.100.6.1.13] exists");
    expect(requirement).toContain(`certificate leaf[subject.OU] = "${team}"`);
    expect(f.calls.at(-1)).toEqual(["/usr/bin/codesign", "--verify", "--deep", "--strict", f.app]);
  } finally { f.close(); }
});

test("actual designated requirement must be stable, not merely code satisfying an external requirement", async () => {
  expect(hasStableHelperDesignatedRequirement(stableRequirement, team)).toBe(true);
  expect(hasStableHelperDesignatedRequirement(stableRequirement.replaceAll("/* exists */", "exists").replace(`= ${team}`, `= "${team}"`), team)).toBe(true);
  const unstable = [`designated => cdhash H"${"a".repeat(40)}"`, "designated => true",
    `${stableRequirement} or true`, `${stableRequirement} and cdhash H"${"b".repeat(40)}"`,
    stableRequirement.replace(team, otherTeam), stableRequirement + "\n" + stableRequirement];
  const f = fixture();
  try {
    for (const requirement of unstable) {
      expect(hasStableHelperDesignatedRequirement(requirement, team)).toBe(false);
      const run: SigningRun = command => command.includes("-r-") ? Promise.resolve(requirement) : f.run(command);
      await expect(verifyPrebuiltClaudeHelper(f.app, { run, previousApp: f.previous })).rejects.toThrow("unstable designated requirement");
    }
    const run: SigningRun = command => command.includes("-r-") ? Promise.resolve(unstable[0]!) : f.run(command);
    await expect(signMacOSApp(f.app, { run })).rejects.toThrow("unstable designated requirement");
  } finally { f.close(); }
});

test("prebuilt helper verification preserves its bytes without needing a private signing identity", async () => {
  const f = fixture();
  try {
    f.setIdentities("");
    await verifyPrebuiltClaudeHelper(f.app, { run: f.run, previousApp: f.previous });
    expect(f.calls.some(command => command.includes("--sign") || command[0] === "/usr/bin/security")).toBe(false);
    expect(f.calls.some(command => command.includes("-R"))).toBe(true);
  } finally { f.close(); }
});

test("prebuilt updates cannot revert stable Keychain trust to ad-hoc, another identifier or another team", async () => {
  const f = fixture();
  try {
    for (const info of ["Signature=adhoc\nTeamIdentifier=not set",
      `TeamIdentifier=${team}\nIdentifier=QuotaPieClaudeSessionHelper-random`,
      `TeamIdentifier=${otherTeam}\nIdentifier=${CLAUDE_HELPER_IDENTIFIER}`]) {
      const run: SigningRun = async command => command.includes("--display") && command.at(-1)?.startsWith(f.app)
        ? info : f.run(command);
      await expect(verifyPrebuiltClaudeHelper(f.app, { run, previousApp: f.previous })).rejects.toThrow();
    }
    expect(f.calls.some(command => command.includes("--sign"))).toBe(false);
  } finally { f.close(); }
});

test("certificate renewal keeps the installed team, and changing teams cannot silently break approval", async () => {
  const f = fixture();
  try {
    f.setIdentities(identity(otherHash, otherTeam) + "\n" + identity(renewedHash, team));
    await signMacOSApp(f.app, { run: f.run, previousApp: f.previous });
    expect(f.calls.find(command => command.includes("--sign"))).toContain(renewedHash);
    f.calls.length = 0;
    await expect(signMacOSApp(f.app, { run: f.run, previousApp: f.previous, identity: otherHash })).rejects.toThrow("signing team differs");
    expect(f.calls.some(command => command.includes("--sign"))).toBe(false);
  } finally { f.close(); }
});

test("ad-hoc migration requires a real identity, with no fallback or permissive requirement", async () => {
  const f = fixture("Signature=adhoc\nTeamIdentifier=not set");
  try {
    await signMacOSApp(f.app, { run: f.run, previousApp: f.previous });
    expect(f.calls.some(command => command.includes("--sign") && command.includes(hash))).toBe(true);
    f.calls.length = 0;
    await expect(signMacOSApp(f.app, { run: f.run, identity: "-" })).rejects.toThrow("Ad-hoc");
    expect(f.calls).toHaveLength(0);
    f.setIdentities("0 valid identities found");
    await expect(signMacOSApp(f.app, { run: f.run })).rejects.toThrow("No matching Developer ID");
    expect(f.calls.some(command => command.includes("--sign"))).toBe(false);
  } finally { f.close(); }
});

test("unreadable installed signer and ambiguous signing teams fail before writing a signature", async () => {
  const f = fixture("unrecognized signature output");
  try {
    await expect(signMacOSApp(f.app, { run: f.run, previousApp: f.previous })).rejects.toThrow("could not be verified");
    expect(f.calls.some(command => command.includes("--sign"))).toBe(false);
    f.setIdentities(identity(hash, team) + "\n" + identity(otherHash, otherTeam));
    await expect(signingIdentity(f.run)).rejects.toThrow("Multiple signing teams");
    expect((await signingIdentity(f.run, hash)).team).toBe(team);
    expect(developerIdentities(`1) ${hash} "Apple Development: Fixture (${team})"`)).toEqual([]);
  } finally { f.close(); }
});

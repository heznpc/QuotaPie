#!/usr/bin/env bun
import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

export const CLAUDE_HELPER_IDENTIFIER = "local.quotapie.claude-session-helper";
export type SigningRun = (command: string[]) => Promise<string>;
interface DeveloperIdentity { hash: string; name: string; team: string }

function helperRequirement(team: string): string {
  return `identifier "${CLAUDE_HELPER_IDENTIFIER}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
}

export function hasStableHelperDesignatedRequirement(output: string, team: string): boolean {
  if (!/^[A-Z0-9]{10}$/.test(team)) return false;
  const requirements = [...output.matchAll(/^designated => (.+)$/gm)];
  if (requirements.length !== 1) return false;
  // codesign renders existence tests as comments and simple Team IDs without
  // quotes. Normalize only those presentation differences, not the predicate.
  const normalize = (value: string) => value.replace(/\/\* exists \*\//g, "exists")
    .replaceAll(`"${team}"`, team).replace(/\s+/g, " ").trim();
  return normalize(requirements[0]![1]!) === normalize(helperRequirement(team));
}

async function verifyStableDesignatedRequirement(helper: string, team: string, run: SigningRun): Promise<void> {
  const output = await run(["/usr/bin/codesign", "--display", "-r-", helper]);
  if (!hasStableHelperDesignatedRequirement(output, team))
    throw new Error("The Claude helper has an unstable designated requirement; use the standard Developer ID signature with its fixed identifier.");
}

export function developerIdentities(output: string): DeveloperIdentity[] {
  return [...output.matchAll(/\b([A-Fa-f0-9]{40})\s+"(Developer ID Application: [^"\n]+ \(([A-Z0-9]{10})\))"/g)]
    .map(match => ({ hash: match[1]!.toUpperCase(), name: match[2]!, team: match[3]! }));
}

async function previousTeam(app: string | undefined, run: SigningRun): Promise<string | undefined> {
  if (!app) return;
  const helper = join(app, "Contents/Helpers/QuotaPieClaudeSessionHelper");
  if (!existsSync(helper)) return;
  if (!lstatSync(helper).isFile() || lstatSync(helper).isSymbolicLink()) throw new Error("Installed Claude helper must be a regular file.");
  await run(["/usr/bin/codesign", "--verify", "--strict", helper]);
  const info = await run(["/usr/bin/codesign", "--display", "--verbose=4", helper]);
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(info)?.[1];
  if (team) return team;
  if (!/^Signature=adhoc$/m.test(info)) throw new Error("The installed Claude helper's signing team could not be verified.");
}

export async function signingIdentity(run: SigningRun, requested?: string, expectedTeam?: string): Promise<DeveloperIdentity> {
  if (requested === "-") throw new Error("Ad-hoc signing cannot preserve Claude Keychain approval across updates. Use a Developer ID Application identity.");
  const available = developerIdentities(await run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"]));
  const candidates = available.filter(identity => !requested || identity.hash === requested.toUpperCase() || identity.name === requested);
  if (!candidates.length) throw new Error("No matching Developer ID Application identity. Install a signed release or set SIGN_IDENTITY to an available Developer ID Application identity.");
  const matchingTeam = expectedTeam ? candidates.filter(identity => identity.team === expectedTeam) : candidates;
  if (!matchingTeam.length) throw new Error("The signing team differs from the installed Claude helper; refusing to replace its Keychain identity.");
  if (new Set(matchingTeam.map(identity => identity.team)).size !== 1)
    throw new Error("Multiple signing teams are available. Set SIGN_IDENTITY explicitly to preserve the Claude helper's Keychain identity.");
  return matchingTeam[0]!;
}

export async function signClaudeHelper(helper: string, identity: DeveloperIdentity, run: SigningRun): Promise<void> {
  if (!lstatSync(helper).isFile() || lstatSync(helper).isSymbolicLink()) throw new Error("Claude helper must be a regular file.");
  // Let codesign produce Apple's certificate-anchored designated requirement.
  // Never replace it with a cdhash, an unanchored identifier, or a permissive DR.
  await run(["/usr/bin/codesign", "--force", "--sign", identity.hash, "--identifier", CLAUDE_HELPER_IDENTIFIER,
    "--options", "runtime", "--timestamp", helper]);
  await run(["/usr/bin/codesign", "--verify", "--strict", "-R", "=" + helperRequirement(identity.team), helper]);
  await verifyStableDesignatedRequirement(helper, identity.team, run);
}

export async function verifyPrebuiltClaudeHelper(app: string, options: { run: SigningRun; previousApp?: string }): Promise<void> {
  const { run } = options;
  const expectedTeam = await previousTeam(options.previousApp, run);
  const helper = join(app, "Contents/Helpers/QuotaPieClaudeSessionHelper");
  if (!lstatSync(helper).isFile() || lstatSync(helper).isSymbolicLink()) throw new Error("Claude helper must be a regular file.");
  const info = await run(["/usr/bin/codesign", "--display", "--verbose=4", helper]);
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(info)?.[1];
  const identifier = /^Identifier=(.+)$/m.exec(info)?.[1];
  if (!team || identifier !== CLAUDE_HELPER_IDENTIFIER)
    throw new Error("The supplied Claude helper must have the stable identifier and a Developer ID Application signature.");
  if (expectedTeam && expectedTeam !== team)
    throw new Error("The signing team differs from the installed Claude helper; refusing to replace its Keychain identity.");
  await run(["/usr/bin/codesign", "--verify", "--strict", "-R", "=" + helperRequirement(team), helper]);
  await verifyStableDesignatedRequirement(helper, team, run);
}

export async function signMacOSApp(app: string, options: { run: SigningRun; identity?: string; previousApp?: string }): Promise<void> {
  const { run } = options;
  const identity = await signingIdentity(run, options.identity, await previousTeam(options.previousApp, run));
  await signClaudeHelper(join(app, "Contents/Helpers/QuotaPieClaudeSessionHelper"), identity, run);
  await run(["/usr/bin/codesign", "--force", "--sign", identity.hash, "--options", "runtime", "--timestamp",
    join(app, "Contents/Helpers/QuotaPiePowerHelper")]);
  await run(["/usr/bin/codesign", "--force", "--sign", identity.hash, "--options", "runtime", "--timestamp", app]);
  await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
}

if (import.meta.main) {
  const [mode, path] = process.argv.slice(2);
  if (mode !== "identity" && (!path || !["app", "helper"].includes(mode ?? "")))
    throw new Error("Usage: bun script/sign-macos.ts identity | <app|helper> <path>");
  const run: SigningRun = async command => {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Signing command failed (${code}): ${command[0]} ${command[1]}\n${stderr.trim()}`);
    return stdout + stderr;
  };
  if (mode === "identity") console.log((await signingIdentity(run, process.env.SIGN_IDENTITY)).hash);
  else if (mode === "helper") await signClaudeHelper(resolve(path!), await signingIdentity(run, process.env.SIGN_IDENTITY), run);
  else await signMacOSApp(resolve(path!), { run, identity: process.env.SIGN_IDENTITY, previousApp: process.env.QUOTAPIE_MENU_APP });
}

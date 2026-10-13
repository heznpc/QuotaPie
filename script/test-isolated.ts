import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";

// Tests must not be allowed to publish fixture state to an installed collector,
// even when a test restores the wrong environment or launches a child process.
const root = realpathSync(mkdtempSync(join(tmpdir(), "quotapie-test-run-")));
const sentinelRoot = join(root, "protected"); mkdirSync(sentinelRoot);
const sentinel = join(sentinelRoot, "sentinel"); writeFileSync(sentinel, "unchanged");
const protectedPaths = [...new Set([
  sentinelRoot, join(homedir(), "Library/Application Support/QuotaPie"),
  join(homedir(), ".local/share/quotapie"), join(homedir(), ".local/lib/quotapie-compaction"),
  join(homedir(), ".local/lib/quotapie"), join(homedir(), ".local/bin/quotapie"),
  join(homedir(), ".local/bin/quotapie-compaction"), join(homedir(), "Applications/QuotaPie.app"),
  join(homedir(), ".config/quotapie"), join(homedir(), ".codex"),
  join(homedir(), "Library/LaunchAgents"), "/Applications/QuotaPie.app",
].flatMap(path => {
  try { return [path, realpathSync(path)]; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [path];
    throw new Error("Protected runtime paths could not be resolved; refusing to run tests", { cause: error });
  }
}))];
const env = { ...process.env, QUOTAPIE_HOME: join(root, "data"), QUOTAPIE_CONFIG: join(root, "config.json") };

function listeningPorts(): Set<number> {
  const listeners = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "n"],
    { stdout: "pipe", stderr: "pipe" });
  if (listeners.exitCode !== 0 || listeners.stderr.toString().trim())
    throw new Error("Existing listening ports could not be verified; refusing to run tests");
  const ports = new Set([47831]);
  let found = 0;
  for (const line of listeners.stdout.toString().split("\n")) {
    if (!line || /^[pf]\d+$/.test(line)) continue;
    const match = /^n.+:(\d+)$/.exec(line);
    const port = match ? Number(match[1]) : 0;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Existing listening ports returned an unrecognized address; refusing to run tests");
    ports.add(port); found++;
  }
  if (!found) throw new Error("Listening-port inventory omitted the proof listener; refusing to run tests");
  return ports;
}

let result = 1;
let proofServer: ReturnType<typeof Bun.serve> | undefined;
const reservations: Array<ReturnType<typeof Bun.serve>> = [];
try {
  if (process.platform !== "darwin") throw new Error("This runtime test suite requires the macOS isolation runner");
  let proofRequests = 0;
  proofServer = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch() { proofRequests++; return new Response("isolation proof only"); } });
  // Baseline every address before testing denial, so DNS failure, a closed
  // socket or an unsupported address cannot masquerade as sandbox protection.
  // Literal IPv4 and mapped IPv6 avoid a DNS fallback to an unbound ::1 socket.
  const proofHosts = ["127.0.0.1", "::ffff:127.0.0.1"];
  for (const hostname of proofHosts) await new Promise<void>((resolve, reject) => {
    const request = get({ hostname, port: proofServer!.port, path: "/", agent: false }, response => {
      response.resume(); response.once("end", () => response.statusCode === 200 ? resolve() : reject(new Error("Synthetic listener rejected the baseline")));
    });
    request.setTimeout(2000, () => request.destroy(new Error("Synthetic listener baseline timed out")));
    request.once("error", reject);
  });
  if (proofRequests !== proofHosts.length) throw new Error("Synthetic isolation listener could not be verified");
  proofRequests = 0;
  const protectedPorts = listeningPorts();
  if (!protectedPorts.has(proofServer.port!))
    throw new Error("Listening-port inventory omitted the proof listener; refusing to run tests");
  // Reserve the fixture pool before releasing it to tests. A port observed in
  // the inventory is never eligible, even if its service exits during setup.
  const fixturePorts = new Set<number>();
  for (let attempts = 0; fixturePorts.size < 64 && attempts < 512; attempts++) {
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
    if (protectedPorts.has(reservation.port!)) await reservation.stop(true);
    else { reservations.push(reservation); fixturePorts.add(reservation.port!); }
  }
  if (fixturePorts.size !== 64) throw new Error("Isolated fixture ports could not be reserved; refusing to run tests");
  // Never alter HOME. Allow only exact ports owned by the fixture pool. The
  // deny-by-default network barrier also excludes Unix sockets and non-TCP
  // destinations. Broad localhost rules with exclusions failed the self-proof.
  const makeProfile = (ports: Set<number>) => `(version 1)(allow default)
${protectedPaths.map(path => `(deny file-write* (subpath ${JSON.stringify(path)}))`).join("\n")}
(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/osascript") (literal "/usr/bin/open"))
(deny network-outbound)
${[...ports].sort((a, b) => a - b).map(port => `(allow network-outbound (remote tcp "localhost:${port}"))`).join("\n")}
`;
  const profile = makeProfile(fixturePorts);
  const command = ["/usr/bin/sandbox-exec", "-p", profile];
  const proof = Bun.spawnSync([...command, process.execPath, "-e",
    'try { require("node:fs").writeFileSync(process.argv[1], "changed"); process.exit(9); } catch (e) { process.exit(e.code === "EPERM" || e.code === "EACCES" ? 0 : 8); }', sentinel],
    { env, stdout: "pipe", stderr: "pipe" });
  if (proof.exitCode !== 0 || readFileSync(sentinel, "utf8") !== "unchanged")
    throw new Error(`Test filesystem isolation could not be verified; refusing to run tests (exit ${proof.exitCode}): ${proof.stderr.toString().trim()}`);
  const networkCode = `
    const {get} = require("node:http");
    for (const hostname of ${JSON.stringify(proofHosts)}) {
      const outcome = await new Promise(resolve => {
        const request = get({hostname, port:Number(process.argv[1]), path:"/", agent:false}, response => {
          response.resume(); response.once("end", () => resolve(response.statusCode === 200 ? "connected" : "bad-response"));
        });
        request.setTimeout(2000, () => request.destroy(Object.assign(new Error("timeout"), {code:"PROOF_TIMEOUT"})));
        request.once("error", error => resolve(error.code ?? "unknown-error"));
      });
      // Bun's HTTP adapter maps the denied socket open to FailedToOpenSocket.
      // The preceding successful control verifies these exact live addresses;
      // timeouts, DNS errors and refused connections are not accepted here.
      if (process.argv[2] === "allow" ? outcome !== "connected" : !["EPERM", "EACCES", "FailedToOpenSocket"].includes(outcome)) {
        console.error(hostname + ": " + outcome); process.exit(9);
      }
    }
  `;
  // The positive control additionally allows only our synthetic listener.
  // Production listener ports remain denied even in this self-test profile.
  const controlPorts = new Set(fixturePorts); controlPorts.add(proofServer.port!);
  for (const mode of ["allow", "deny"]) {
    const childProfile = mode === "allow" ? makeProfile(controlPorts) : profile;
    const networkProof = Bun.spawn(["/usr/bin/sandbox-exec", "-p", childProfile, process.execPath, "-e", networkCode,
      String(proofServer.port), mode], { env, stdout: "pipe", stderr: "pipe" });
    const networkExit = await networkProof.exited;
    const expectedRequests = mode === "allow" ? proofHosts.length : 0;
    if (networkExit !== 0 || proofRequests !== expectedRequests)
      throw new Error(`Test network ${mode} control could not be verified; refusing to run tests (exit ${networkExit}, received ${proofRequests}): ${await new Response(networkProof.stderr).text()}`);
    proofRequests = 0;
  }
  const testArgs = process.argv.slice(2);
  if (testArgs.includes("--verify-isolation")) {
    console.log(`Test filesystem and exact fixture-port barriers verified (${protectedPorts.size} pre-existing ports excluded; ${fixturePorts.size} reserved fixture ports; positive control passed, denied synthetic listener received 0 requests); no tests were run.`);
    result = 0;
  } else {
    await Promise.all(reservations.splice(0).map(server => server.stop(true)));
    const tests = Bun.spawn([...command, process.execPath, "test", ...(testArgs.length ? testArgs : ["./tests"])],
      { env: { ...env, QUOTAPIE_TEST_ISOLATION: "verified", QUOTAPIE_TEST_PORTS: [...fixturePorts].join(",") },
        stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    result = await tests.exited;
  }
} finally {
  await Promise.all(reservations.map(server => server.stop(true)));
  await proofServer?.stop(true); rmSync(root, { recursive: true, force: true });
}
process.exitCode = result;

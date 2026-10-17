import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
// Only globally routed IPv6 unicast is considered, excluding transition,
// documentation, benchmarking and special-purpose allocations.
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !blocked.check(address, "ipv6");
}
export function callbackURL(value: string): URL {
  const url = new URL(value);
  if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443")) throw new Error("invalid-callback");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !publicAddress(host)) throw new Error("invalid-callback");
  return url;
}
export function signingKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error("invalid-signing-key");
  const bytes = Buffer.from(secret.slice(6), "base64");
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString("base64") !== secret.slice(6))
    throw new Error("invalid-signing-key");
  return bytes;
}
export function signature(secret: string, id: string, timestamp: string, body: string): string {
  return "v1," + createHmac("sha256", signingKey(secret)).update(id + "." + timestamp + "." + body).digest("base64");
}
export type WebhookPost = (url: string, headers: Record<string, string>, body: string) =>
  Promise<{ status: number; body: string }>;

export class CallbackEndpointError extends Error {
  constructor(readonly reason: "challenge_failed" | "timeout" | "unreachable") { super("callback-verification-failed"); }
}

/** Validate every DNS answer, pin the actual connection to one validated IP,
 * preserve TLS hostname verification, bound time/body size, never redirect. */
export const postWebhook: WebhookPost = async (value, headers, body) => {
  const url = callbackURL(value);
  if (Buffer.byteLength(body) > 262144) throw new Error("payload-too-large");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("dns-timeout")), 3000); timer.unref(); }),
  ]);
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("invalid-callback-address");
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "POST", headers: { ...headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
      agent: false,
      lookup: ((_host: string, options: any, done: any) => options?.all
        ? done(null, [selected]) : done(null, selected.address, selected.family)) as any,
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 8192) req.destroy(new Error("callback-response-too-large"));
        else chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("callback-timeout")), 10000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body);
  });
};

export async function signedPost(post: WebhookPost, sub: { id: string; url: string; secret: string },
  eventId: string, body: string, now: number) {
  const timestamp = String(Math.floor(now / 1000));
  return post(sub.url, { "webhook-id": eventId, "webhook-timestamp": timestamp,
    "webhook-signature": signature(sub.secret, eventId, timestamp, body), "X-MCP-Subscription-Id": sub.id }, body);
}
export async function verifyCallback(post: WebhookPost, sub: { id: string; url: string; secret: string }, now: number) {
  const challenge = randomUUID();
  let response;
  try { response = await signedPost(post, sub, "verification_" + randomUUID(), JSON.stringify({ type: "verification", challenge }), now); }
  catch (error) { throw new CallbackEndpointError(error instanceof Error && error.message.includes("timeout") ? "timeout" : "unreachable"); }
  let received: unknown;
  try { received = JSON.parse(response.body).challenge; } catch { /* fail closed */ }
  if (response.status < 200 || response.status >= 300 || typeof received !== "string" ||
      Buffer.byteLength(received) !== Buffer.byteLength(challenge) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(challenge))) throw new CallbackEndpointError("challenge_failed");
}

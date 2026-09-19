import { deflateSync } from "node:zlib";
import type { CompactionRequestEvent } from "./codex-compaction";

// The installed relay exposes terminal events only. Local probes also receive
// starts/headers, so match by request identity instead of counting phases.
export function verifyPoolProbeStage(events: readonly CompactionRequestEvent[], options: {
  previousRequestIds: ReadonlySet<string>; thread: string; account: string;
  requireImages?: boolean; requirePinned?: boolean;
}): { verified: boolean; requestIds: string[] } {
  const relevant = events.filter(e => e.threadId === options.thread && e.kind === "response"
    && !options.previousRequestIds.has(e.requestId));
  const requestIds = [...new Set(relevant.map(e => e.requestId))];
  const verified = requestIds.length > 0 && requestIds.every(id => {
    const phases = relevant.filter(e => e.requestId === id);
    const terminal = phases.filter(e => !["started", "response_headers"].includes(e.phase));
    return terminal.length === 1 && terminal[0]!.phase === "completed"
      && terminal[0]!.status >= 200 && terminal[0]!.status < 300
      && phases.every(e => e.accountRouting?.account === options.account
        && (!options.requirePinned || e.accountRouting?.reason === "pinned")
        && (!options.requireImages || (Number.isInteger(e.inlineImageCount) && e.inlineImageCount! > 0)));
  });
  return { verified, requestIds };
}

export function probeReplyMatches(output: string, marker: string): boolean {
  return output.split("\n").some(line => {
    try {
      const event = JSON.parse(line);
      return event.type === "item.completed" && event.item?.type === "agent_message"
        && typeof event.item.text === "string" && event.item.text.trim() === marker;
    } catch { return false; }
  });
}

export function probeFailureCodes(stderr: readonly string[], events: readonly CompactionRequestEvent[]): string[] {
  return [...new Set([...stderr.flatMap(s => s.match(/pool_[a-z_]+/g) ?? []),
    ...events.flatMap(e => e.errorCode ? [e.errorCode] : [])])];
}

// Generate a valid, deterministic PNG rather than trusting a copied base64 blob.
export function redProbePng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { probeReplyMatches, probeFailureCodes, redProbePng, verifyPoolProbeStage } from "../src/pool-probe-evidence";
import type { CompactionRequestEvent } from "../src/codex-compaction";

const event = (patch: Partial<CompactionRequestEvent> = {}): CompactionRequestEvent => ({
  requestId:"image-request",threadId:"thread",turnId:"turn",kind:"response",from:"model",to:"model",routed:false,
  phase:"completed",status:200,requestedEffort:null,reasoningEffort:null,at:new Date().toISOString(),durationMs:1,
  accountRouting:{sourceAccount:"a",account:"b",accountLabel:"B",reason:"pinned"},inlineImageCount:1,...patch,
});
const options = {previousRequestIds:new Set(["initial"]),thread:"thread",account:"b",requireImages:true,requirePinned:true};

test("image proof requires a new completed image-bearing request, not red text replies", () => {
  const textOnly = ["initial","image-request","followup"].map(requestId=>event({requestId,inlineImageCount:0}));
  expect(verifyPoolProbeStage(textOnly,options).verified).toBe(false);
  expect(verifyPoolProbeStage([event()],options)).toEqual({verified:true,requestIds:["image-request"]});
  expect(verifyPoolProbeStage([event({inlineImageCount:undefined})],options).verified).toBe(false);
});

test("a prior or unrelated successful request cannot verify the image turn", () => {
  expect(verifyPoolProbeStage([event({requestId:"initial"})],options).verified).toBe(false);
  expect(verifyPoolProbeStage([event({threadId:"other"})],options).verified).toBe(false);
  expect(verifyPoolProbeStage([event({kind:"compaction"})],options).verified).toBe(false);
  expect(verifyPoolProbeStage([event({phase:"failed"}),event({requestId:"initial"})],options).verified).toBe(false);
  expect(verifyPoolProbeStage([event(),event({requestId:"retry",phase:"failed"})],options).verified).toBe(false);
});

test("start/header events cannot stand in for completion or lend images to another request", () => {
  expect(verifyPoolProbeStage([event({phase:"started"}),event({phase:"response_headers"})],options).verified).toBe(false);
  expect(verifyPoolProbeStage([event({phase:"started"}),event({inlineImageCount:0})],options).verified).toBe(false);
  expect(verifyPoolProbeStage([event({phase:"started"}),event({requestId:"other",inlineImageCount:0})],options).verified).toBe(false);
  expect(verifyPoolProbeStage([event({phase:"started"}),event({phase:"response_headers"}),event()],options).verified).toBe(true);
  for (const patch of [{phase:"unverified"},{phase:"cancelled"},{status:429},{accountRouting:undefined}] as Partial<CompactionRequestEvent>[])
    expect(verifyPoolProbeStage([event(patch)],options).verified).toBe(false);
});

test("the next followup must retain images and cannot reuse the image turn's proof", () => {
  const nextOptions = {...options,previousRequestIds:new Set(["initial","image-request"])};
  expect(verifyPoolProbeStage([event(),event({requestId:"next",inlineImageCount:0})],nextOptions).verified).toBe(false);
  expect(verifyPoolProbeStage([event(),event({requestId:"next"})],nextOptions)).toEqual({verified:true,requestIds:["next"]});
});

test("diagnostics include resume and followup errors without raw stderr", () => {
  expect(probeFailureCodes(["", "secret pool_bound_identity_changed", "payload pool_no_eligible_account"], [event({errorCode:"pool_bound_identity_changed"})]))
    .toEqual(["pool_bound_identity_changed","pool_no_eligible_account"]);
});

test("synthetic fixture decodes to a 64 by 64 RGB red PNG with valid checksums", () => {
  const png = redProbePng();
  expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  const chunks: Record<string, Buffer[]> = {};
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at), type = png.toString("ascii",at+4,at+8);
    const data = png.subarray(at+8,at+8+size);
    expect(Bun.hash.crc32(png.subarray(at+4,at+8+size))).toBe(png.readUInt32BE(at+8+size));
    (chunks[type] ??= []).push(data); at += size+12;
  }
  expect(chunks.IHDR![0]!.readUInt32BE(0)).toBe(64);
  expect(chunks.IHDR![0]!.readUInt32BE(4)).toBe(64);
  expect([...chunks.IHDR![0]!.subarray(8)]).toEqual([8,2,0,0,0]);
  const pixels = inflateSync(Buffer.concat(chunks.IDAT!));
  expect(pixels.length).toBe(64*193);
  for (let y=0;y<64;y++) {
    expect(pixels[y*193]).toBe(0);
    for (let x=0;x<64;x++) expect([...pixels.subarray(y*193+1+x*3,y*193+4+x*3)]).toEqual([255,0,0]);
  }
  expect(chunks.IEND).toHaveLength(1);
});

test("only a completed assistant reply verifies the marker", () => {
  const reply = (type:string, text:string) => JSON.stringify({type:"item.completed",item:{type,text}});
  expect(probeReplyMatches(reply("agent_message","IMAGE_RED"),"IMAGE_RED")).toBe(true);
  expect(probeReplyMatches(reply("user_message","IMAGE_RED"),"IMAGE_RED")).toBe(false);
  expect(probeReplyMatches(reply("agent_message","I cannot see IMAGE_RED"),"IMAGE_RED")).toBe(false);
  expect(probeReplyMatches("IMAGE_RED", "IMAGE_RED")).toBe(false);
});

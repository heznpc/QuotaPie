import { expect, test } from "bun:test";
import { constants, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { BodyDecodeError, decodeRequestBody, requestEncoding } from "../src/request-body-decoder";

test("request encoding diagnostics use only fixed names, never arbitrary header contents", () => {
  expect([null, "identity", " GZIP ", "ZsTd", "deflate", "private-header-value", "gzip, zstd"].map(requestEncoding))
    .toEqual(["identity", "identity", "gzip", "zstd", "deflate", "unsupported", "unsupported"]);
});

test("bounded inspection decodes identity, gzip, deflate and zstd without changing the input", async () => {
  const input = Buffer.from('{"model":"gpt-6-astra","input":[{"type":"compaction_trigger"}]}');
  for (const [encoding, bytes] of [["identity", input], ["gzip", gzipSync(input)], ["deflate", deflateSync(input)], ["zstd", Bun.zstdCompressSync(input)]] as const) {
    const before = Buffer.from(bytes);
    expect(Buffer.from(await decodeRequestBody(bytes, encoding, 1024)).equals(input)).toBe(true);
    expect(Buffer.from(bytes).equals(before)).toBe(true);
  }
});

test("compressed output beyond the inspection bound is rejected before it can be retained", async () => {
  const expanded = Buffer.alloc(2 * 1024 * 1024, 65);
  for (const [encoding, bytes] of [["gzip", gzipSync(expanded)], ["deflate", deflateSync(expanded)], ["zstd", Bun.zstdCompressSync(expanded)]] as const) {
    await expect(decodeRequestBody(bytes, encoding, 32 * 1024)).rejects.toBeInstanceOf(BodyDecodeError);
  }
  await expect(decodeRequestBody(expanded, "identity", 32 * 1024)).rejects.toMatchObject({ reason: "decode-limit-exceeded" });
});

test("zstd unknown-size frames decode while concatenated frames fall back rather than silently truncating", async () => {
  const input = Buffer.alloc(32 * 1024, 66);
  const unknownSize = zstdCompressSync(input, { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } });
  expect((await decodeRequestBody(unknownSize, "zstd", 64 * 1024)).byteLength).toBe(input.length);
  await expect(decodeRequestBody(Buffer.concat([unknownSize, unknownSize, unknownSize]), "zstd", 64 * 1024))
    .rejects.toBeInstanceOf(BodyDecodeError);
});

test("zstd rejects corrupt content checksums and oversized unknown-size windows", async () => {
  const input = Buffer.alloc(2 * 1024 * 1024, 67);
  const unknownSize = zstdCompressSync(input, { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } });
  await expect(decodeRequestBody(unknownSize, "zstd", 32 * 1024)).rejects.toMatchObject({ reason: "decode-limit-exceeded" });
  const checksummed = zstdCompressSync(Buffer.from("checksum fixture"), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  expect(Buffer.from(await decodeRequestBody(checksummed, "zstd", 1024)).toString()).toBe("checksum fixture");
  checksummed[checksummed.length - 1]! ^= 1;
  await expect(decodeRequestBody(checksummed, "zstd", 1024)).rejects.toMatchObject({ reason: "decode-failed" });
});

test("unsupported, malformed and truncated encodings fail with fixed diagnostic reasons", async () => {
  await expect(decodeRequestBody(Buffer.from("private body"), "unsupported", 1024)).rejects.toMatchObject({ reason: "unsupported-encoding" });
  for (const encoding of ["gzip", "deflate", "zstd"] as const) {
    await expect(decodeRequestBody(Buffer.from("private body"), encoding, 1024)).rejects.toMatchObject({ reason: "decode-failed" });
  }
  const compressed = Bun.zstdCompressSync("test fixture");
  await expect(decodeRequestBody(compressed.subarray(0, compressed.length - 1), "zstd", 1024)).rejects.toMatchObject({ reason: "decode-failed" });
});

test("aborted inspection never supplies replacement bytes", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(decodeRequestBody(Bun.zstdCompressSync("fixture"), "zstd", 1024, controller.signal)).rejects.toThrow();
});

test("cancellation during asynchronous decompression destroys the inspection instead of returning partial bytes", async () => {
  const input = Buffer.alloc(8 * 1024 * 1024, 68);
  for (const [encoding, compressed] of [["gzip", gzipSync(input)], ["zstd", Bun.zstdCompressSync(input)]] as const) {
    const controller = new AbortController();
    const decoding = decodeRequestBody(compressed, encoding, 16 * 1024 * 1024, controller.signal);
    controller.abort(new Error("fixture cancellation"));
    await expect(decoding).rejects.toThrow("fixture cancellation");
  }
});

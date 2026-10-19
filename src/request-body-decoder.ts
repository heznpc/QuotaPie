import * as zlib from "node:zlib";

export type RequestEncoding = "identity" | "gzip" | "deflate" | "zstd" | "unsupported";
export type BodyDecodeFailure = "unsupported-encoding" | "decode-limit-exceeded" | "decode-failed";

export function requestEncoding(value: string | null): RequestEncoding {
  if (value === null || value.trim().toLowerCase() === "identity") return "identity";
  const normalized = value.trim().toLowerCase();
  return normalized === "gzip" || normalized === "deflate" || normalized === "zstd" ? normalized : "unsupported";
}

export class BodyDecodeError extends Error {
  constructor(readonly reason: BodyDecodeFailure) { super(reason); }
}

/** RFC 8878 frame envelope only; the runtime still validates compressed blocks.
 * Bun's stream adapter can finish on a truncated/first concatenated frame, so
 * accept exactly one complete frame and reject the rest for byte-exact fallback. */
function zstdFrameSize(bytes: Uint8Array, maxBytes: number): number | null {
  const invalid = () => new BodyDecodeError("decode-failed");
  const limit = () => new BodyDecodeError("decode-limit-exceeded");
  let offset = 0;
  const number = (size: number): bigint => {
    if (offset + size > bytes.length) throw invalid();
    let value = 0n;
    for (let i = 0; i < size; i++) value |= BigInt(bytes[offset++]!) << BigInt(i * 8);
    return value;
  };
  if (number(4) !== 0xfd2fb528n) throw invalid();
  const descriptor = Number(number(1));
  if (descriptor & 0x18) throw invalid(); // Reserved/unused format bits.
  const singleSegment = !!(descriptor & 0x20), sizeFlag = descriptor >> 6;
  if (!singleSegment) {
    const window = Number(number(1)), base = 2 ** (10 + (window >> 3));
    if (base + base / 8 * (window & 7) > maxBytes) throw limit();
  }
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]!;
  if (number(dictionaryBytes) !== 0n) throw invalid(); // No external dictionary is configured.
  const sizeBytes = sizeFlag === 0 ? singleSegment ? 1 : 0 : [0, 2, 4, 8][sizeFlag]!;
  const contentSize = sizeBytes ? number(sizeBytes) + (sizeFlag === 1 ? 256n : 0n) : null;
  if (contentSize !== null && contentSize > BigInt(maxBytes)) throw limit();
  // At most 16K blocks (2 GiB at the normal maximum), also bounding scans of
  // pathological zero-length blocks before optional inspection falls back.
  for (let blocks = 0; ; blocks++) {
    if (blocks >= 16_384) throw limit();
    const header = Number(number(3)), last = !!(header & 1), type = (header >> 1) & 3, size = header >> 3;
    if (type === 3 || size > 128 * 1024) throw invalid();
    const payloadSize = type === 1 ? 1 : size;
    if (offset + payloadSize > bytes.length) throw invalid();
    offset += payloadSize;
    if (last) break;
  }
  if (descriptor & 4) number(4); // The runtime verifies the optional content checksum.
  if (offset !== bytes.length) throw invalid();
  return contentSize === null ? null : Number(contentSize);
}

/** Decode optional inspection bytes, not the forwarded request. Bound both
 * emitted output and zstd's history window; never use the unbounded Bun sync API. */
export async function decodeRequestBody(bytes: Uint8Array, encoding: RequestEncoding, maxBytes: number,
  signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid request decode bound");
  signal?.throwIfAborted();
  if (encoding === "unsupported") throw new BodyDecodeError("unsupported-encoding");
  if (encoding === "identity") {
    if (bytes.byteLength > maxBytes) throw new BodyDecodeError("decode-limit-exceeded");
    return bytes;
  }
  const expectedSize = encoding === "zstd" ? zstdFrameSize(bytes, maxBytes) : null;
  const options = { chunkSize: 64 * 1024 };
  let decoder: ReturnType<typeof zlib.createGunzip> | ReturnType<typeof zlib.createInflate> | ReturnType<typeof zlib.createZstdDecompress>;
  try {
    if (encoding === "gzip") decoder = zlib.createGunzip(options);
    else if (encoding === "deflate") decoder = zlib.createInflate(options);
    else {
      if (typeof zlib.createZstdDecompress !== "function" || typeof zlib.constants.ZSTD_d_windowLogMax !== "number")
        throw new BodyDecodeError("unsupported-encoding");
      // zstd requires a window log of at least 10. For production's 64 MiB
      // bound this is exactly 26, including frames with unknown content size.
      decoder = zlib.createZstdDecompress({ ...options,
        params: { [zlib.constants.ZSTD_d_windowLogMax]: Math.max(10, Math.floor(Math.log2(maxBytes))) } });
    }
  } catch (error) {
    if (error instanceof BodyDecodeError) throw error;
    throw new BodyDecodeError("decode-failed");
  }
  const abort = () => decoder.destroy(new Error("Request inspection aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    decoder.end(bytes);
    for await (const chunk of decoder) {
      signal?.throwIfAborted();
      length += chunk.length;
      if (length > maxBytes) throw new BodyDecodeError("decode-limit-exceeded");
      chunks.push(chunk);
    }
    signal?.throwIfAborted();
    if (expectedSize !== null && length !== expectedSize) throw new BodyDecodeError("decode-failed");
    return Buffer.concat(chunks, length);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof BodyDecodeError) throw error;
    throw new BodyDecodeError("decode-failed");
  } finally {
    signal?.removeEventListener("abort", abort);
    decoder.destroy();
  }
}

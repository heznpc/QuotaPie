/** Inspection is optional. Oversized, streaming, new or encoded native payloads
 * keep their original bytes; this bound limits optimization, not admission. */
export async function inspectNativeBody(request: Request, maxBytes: number): Promise<{
  bytes?: Uint8Array<ArrayBuffer>;
  body?: BodyInit;
}> {
  if (!request.body) return {};
  const length = Number(request.headers.get("content-length"));
  if (length > maxBytes) return { body: request.body };
  const reader = request.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) {
        reader.releaseLock();
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return { bytes, body: bytes };
      }
      chunks.push(next.value); total += next.value.length;
      if (total > maxBytes) {
        let index = 0;
        return { body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (index < chunks.length) { controller.enqueue(chunks[index++]!); return; }
            const next = await reader.read();
            if (next.done) { reader.releaseLock(); controller.close(); } else controller.enqueue(next.value);
          },
          async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
        }) };
      }
    }
  } catch (error) { await reader.cancel(error).catch(() => {}); reader.releaseLock(); throw error; }
}

/** The destination stays under the fixed Codex origin and namespace. Native
 * route syntax/entitlements belong to the provider, not a local allowlist. */
export function nativeRequestPathAllowed(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020?#]/.test(path)) return false;
  const target = new URL("https://chatgpt.com/backend-api/codex" + path);
  return target.origin === "https://chatgpt.com" && target.pathname.startsWith("/backend-api/codex/");
}

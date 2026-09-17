import { setTimeout as delay } from "node:timers/promises";

// Only allowlisted codes leave this module. Error messages/URLs can contain credentials.
const codes: Record<string, string> = {
  ConnectionRefused: "upstream_connection_failed",
  ENOTFOUND: "upstream_dns_error", EAI_AGAIN: "upstream_dns_error",
  ECONNREFUSED: "upstream_connection_refused", ENETUNREACH: "upstream_network_unreachable",
  EHOSTUNREACH: "upstream_network_unreachable", ENETDOWN: "upstream_network_unreachable",
  ECONNRESET: "upstream_connection_reset", EPIPE: "upstream_connection_reset",
  ETIMEDOUT: "upstream_timeout", ESOCKETTIMEDOUT: "upstream_timeout",
  ERR_TLS_CERT_ALTNAME_INVALID: "upstream_tls_error", CERT_HAS_EXPIRED: "upstream_tls_error",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "upstream_tls_error", DEPTH_ZERO_SELF_SIGNED_CERT: "upstream_tls_error",
  SELF_SIGNED_CERT_IN_CHAIN: "upstream_tls_error", UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "upstream_tls_error",
};
// These failures happen before an HTTP request can be delivered. Never replay a
// reset, timeout, HTTP error or interrupted stream: inference may already have run.
const retryable = new Set(["ConnectionRefused", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"]);
export function transportFailure(error: unknown): { errorCode: string; transportCode?: string; retryable: boolean } {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof value.code === "string" && Object.hasOwn(codes, value.code)) {
      return { errorCode: codes[value.code]!, transportCode: value.code, retryable: retryable.has(value.code) };
    }
    if (value.name === "TimeoutError") return { errorCode: "upstream_timeout", retryable: false };
    current = value.cause;
  }
  return { errorCode: "upstream_unavailable", retryable: false };
}

export async function fetchCodexUpstream(fetcher: (url: string, init: RequestInit) => Promise<Response>,
  url: string, init: RequestInit, onRetry: (code: string) => void): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    try { return await fetcher(url, init); }
    catch (error) {
      const failure = transportFailure(error);
      if (init.signal?.aborted || !failure.retryable || attempt >= 2) throw error;
      onRetry(failure.transportCode!);
      await delay(attempt === 0 ? 250 : 750, undefined, { signal: init.signal ?? undefined });
    }
  }
}

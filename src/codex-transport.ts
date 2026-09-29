import { setTimeout as delay } from "node:timers/promises";

import { transportFailure } from "../packages/quota-core/src/transport-failure.js";
export { transportFailure } from "../packages/quota-core/src/transport-failure.js";

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

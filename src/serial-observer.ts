type Schedule = (callback: () => void, delayMs: number) => () => void;

const scheduleTimeout: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Collection and its consumers form one operation: slow work must not queue
 * duplicate continuations on a shared collection promise. */
export function startSerialObserver(observe: () => Promise<unknown>, intervalMs = 2000, schedule: Schedule = scheduleTimeout) {
  let stopped = false;
  let cancelNext: (() => void) | undefined;
  const run = async () => {
    if (stopped) return;
    try { await observe(); }
    catch { /* Observations are retried without interrupting foreground work. */ }
    finally {
      if (!stopped) cancelNext = schedule(() => { cancelNext = undefined; void run(); }, intervalMs);
    }
  };
  void run();
  return () => { stopped = true; cancelNext?.(); };
}

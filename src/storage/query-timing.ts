import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export interface SlowQueryTiming {
  at: string;
  queryId: string;
  method: string;
  durationMs: number;
}

interface TimingOptions {
  thresholdMs?: number;
  now?: () => number;
  report?: (timing: SlowQueryTiming) => void;
}

const installed = new WeakSet<Database>();

/** Log only a fingerprint and duration. SQL, bindings, rows and errors can
 * contain private data and must never enter collector diagnostics. */
export function instrumentQueryTiming(db: Database, options: TimingOptions = {}): void {
  if (installed.has(db)) return;
  installed.add(db);
  const now = options.now ?? (() => performance.now());
  const threshold = options.thresholdMs ?? 250;
  const report = options.report ?? (timing => console.error(`[quotapie] slow-query ${JSON.stringify(timing)}`));
  const statements = new WeakMap<object, any>();
  const timedMethods = new Set(["all", "get", "run", "values"]);

  const instrument = (statement: object, sql: string): any => {
    const existing = statements.get(statement);
    if (existing) return existing;
    let queryId: string | undefined;
    const measured = <T>(method: string, operation: () => T): T => {
      const start = now();
      try { return operation(); }
      finally {
        const durationMs = now() - start;
        if (durationMs >= threshold) {
          // Diagnostics must never replace a database result or exception.
          try {
            queryId ??= createHash("sha256").update(sql).digest("hex").slice(0, 16);
            report({ at: new Date().toISOString(), queryId, method, durationMs: Math.round(durationMs * 1000) / 1000 });
          } catch { /* Observability is not part of the transaction. */ }
        }
      }
    };
    const methods = new Map<PropertyKey, { original: Function; wrapper: Function }>();
    let proxy: any;
    proxy = new Proxy(statement, {
      get(target, key) {
        const original = Reflect.get(target, key, target);
        if (typeof original !== "function") return original;
        const cached = methods.get(key);
        if (cached && cached.original === original) return cached.wrapper;
        const wrapper = function(this: unknown, ...args: unknown[]) {
          const receiver = this === proxy ? target : this;
          const invoke = () => Reflect.apply(original, receiver, args);
          const result: any = timedMethods.has(String(key)) || key === "iterate" ? measured(String(key), invoke) : invoke();
          if (key === "iterate" && result && typeof result.next === "function") {
            // Time SQLite's individual steps, never time spent by the consumer
            // between next() calls. return() remains immediate on an early break.
            let iterator: any;
            iterator = new Proxy(result, {
              get(cursor, property) {
                const value = Reflect.get(cursor, property, cursor);
                if (property === Symbol.iterator) return () => iterator;
                if (typeof value !== "function") return value;
                return function(this: unknown, ...params: unknown[]) {
                  const owner = this === iterator ? cursor : this;
                  return measured(`iterate.${String(property)}`, () => Reflect.apply(value, owner, params));
                };
              },
            });
            return iterator;
          }
          return result === target && this === proxy ? proxy : result;
        };
        methods.set(key, { original, wrapper });
        return wrapper;
      },
    });
    statements.set(statement, proxy);
    statements.set(proxy, proxy);
    return proxy;
  };

  for (const method of ["query", "prepare"] as const) {
    const original = db[method];
    db[method] = function(this: Database, ...args: unknown[]) {
      return instrument(Reflect.apply(original, this, args), String(args[0]));
    } as typeof original;
  }
}

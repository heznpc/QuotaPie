import { test, expect } from 'bun:test';
import { DEFAULT_CONFIG } from '../src/config';
import { QuotaDatabase } from '../src/db';
import { QuotaPieService } from '../src/service';

test('connection wakes the scheduler without concurrent collection and stop releases its timer', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.resetSignals.enabled = false;
  config.collection.pollSeconds = 3600;
  const service = new QuotaPieService(config, new QuotaDatabase(':memory:'));
  let count = 0;
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  let secondStarted!: () => void;
  const second = new Promise<void>(resolve => { secondStarted = resolve; });
  service.tick = async () => {
    count++;
    if (count === 1) await first;
    if (count === 2) secondStarted();
    return { collected: true, windows: [], events: [], triggers: [] };
  };
  const watching = service.watch();
  try {
    service.requestCollection(); service.requestCollection();
    expect(count).toBe(1);
    release();
    await second;
    expect(count).toBe(2);
    // Allow watch to enter its long wait; the next request must wake it.
    await Bun.sleep(5);
    service.requestCollection();
    await Bun.sleep(5);
    expect(count).toBe(3);
    service.stop();
    await watching;
  } finally { service.stop(); await watching; await service.close(); }
}, 2000);

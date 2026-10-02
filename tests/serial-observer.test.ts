import { expect, test } from "bun:test";
import { startSerialObserver } from "../src/serial-observer";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("observer waits for collection and notification delivery before scheduling another run", async () => {
  const collection = deferred(), notification = deferred();
  const scheduled: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  let collections = 0, notifications = 0;
  const stop = startSerialObserver(async () => {
    collections++;
    await collection.promise;
    notifications++;
    await notification.promise;
  }, 2000, (callback, delay) => {
    const item = { callback, delay, cancelled: false }; scheduled.push(item);
    return () => { item.cancelled = true; };
  });
  await flush();
  expect(collections).toBe(1);
  expect(scheduled).toHaveLength(0);
  collection.resolve(); await flush();
  expect(notifications).toBe(1);
  expect(scheduled).toHaveLength(0);
  notification.resolve(); await flush();
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]!.delay).toBe(2000);
  scheduled[0]!.callback(); await flush();
  expect(collections).toBe(2);
  expect(notifications).toBe(2);
  expect(scheduled).toHaveLength(2);
  stop();
  expect(scheduled[1]!.cancelled).toBe(true);
  scheduled[1]!.callback(); await flush();
  expect(collections).toBe(2);
});

test("stopping a pending observer prevents scheduling; failed observations retry serially", async () => {
  const pending = deferred();
  let scheduled = 0;
  const stop = startSerialObserver(() => pending.promise, 2000, () => { scheduled++; return () => {}; });
  stop(); pending.resolve(); await flush();
  expect(scheduled).toBe(0);
  const stopFailed = startSerialObserver(async () => { throw new Error("unavailable"); }, 2000,
    () => { scheduled++; return () => {}; });
  await flush();
  expect(scheduled).toBe(1);
  stopFailed();
});

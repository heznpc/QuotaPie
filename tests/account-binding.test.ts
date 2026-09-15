import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaDatabase } from "../src/db";
import { AccountBindingStore } from "../src/storage/account-binding-store";
import { fakeCodexLogin } from "./helpers/account";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qp-binding-"));
  const db = new QuotaDatabase(":memory:");
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  fakeCodexLogin(root);
  return { root, db, store: new AccountBindingStore(db.storage) };
}

test("token refresh preserves binding; account or user switches do not", () => {
  const { root, db, store } = fixture();
  store.bind("job", "saved", root);
  fakeCodexLogin(root, "test-account", "test-user", "refreshed-token");
  expect(store.matches("job", "saved", root)).toBeTrue();
  expect(store.matches("resume", "saved", root)).toBeFalse();
  fakeCodexLogin(root, "other-account");
  expect(store.matches("job", "saved", root)).toBeFalse();
  expect(() => store.bind("job", "saved", root)).toThrow("account-binding-changed");
  fakeCodexLogin(root, "test-account", "other-user");
  expect(store.matches("job", "saved", root)).toBeFalse();
  fakeCodexLogin(root);
  expect(store.matches("job", "saved", root)).toBeTrue();
  const rows = JSON.stringify(db.storage.db.query("SELECT * FROM account_bindings").all());
  for (const value of [root, "test-account", "test-user", "refreshed-token"]) expect(rows).not.toContain(value);
});

test("unknown legacy bindings, missing auth, and non-file credentials fail closed", () => {
  const { root, store } = fixture();
  expect(store.matches("job", "legacy", root)).toBeFalse();
  store.bind("resume", "saved", root);
  writeFileSync(join(root, "auth.json"), "malformed");
  expect(store.matches("resume", "saved", root)).toBeFalse();
  expect(() => store.bind("job", "new", root)).toThrow("account-identity-unavailable");
  fakeCodexLogin(root);
  writeFileSync(join(root, "config.toml"), 'cli_auth_credentials_store = "keyring"');
  expect(store.matches("resume", "saved", root)).toBeFalse();
});

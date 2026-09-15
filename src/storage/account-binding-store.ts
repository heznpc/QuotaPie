import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codexUsesFileCredentials } from '../config';
import type { QuotaStorage } from './database';

/** Local credential continuity, not a remote authentication verdict. No tokens or identifiers are persisted. */
export class AccountBindingStore {
  constructor(private readonly storage: QuotaStorage) {}

  private fingerprint(root: string): string | null {
    try {
      root = realpathSync(root);
      if (!codexUsesFileCredentials({ id: 'binding', label: 'binding', enabled: true, codexHome: root })) return null;
      const path = join(root, 'auth.json');
      if (statSync(path).size > 262144) return null;
      const auth = JSON.parse(readFileSync(path, 'utf8'));
      const account = auth.tokens?.account_id;
      const token = auth.tokens?.id_token;
      if (typeof account !== 'string' || !account || account.length > 512 || typeof token !== 'string') return null;
      const subject = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')).sub;
      if (typeof subject !== 'string' || !subject || subject.length > 512) return null;
      this.storage.db.query('INSERT OR IGNORE INTO account_binding_secret(id, secret) VALUES (1, ?)').run(randomBytes(32).toString('hex'));
      const secret = this.storage.db.query<{secret: string}, []>('SELECT secret FROM account_binding_secret WHERE id=1').get()!.secret;
      return createHmac('sha256', secret).update(JSON.stringify([root, account, subject])).digest('hex');
    } catch { return null; }
  }

  bind(scope: 'resume' | 'job', id: string, root: string): void {
    const key = this.fingerprint(root);
    if (!key) throw new Error('account-identity-unavailable');
    const saved = this.storage.db.query<{binding: string}, [string,string]>('SELECT binding FROM account_bindings WHERE scope=? AND id=?').get(scope,id);
    if (saved) {
      if (saved.binding !== key) throw new Error('account-binding-changed');
      return;
    }
    this.storage.db.query('INSERT INTO account_bindings(scope, id, binding) VALUES (?, ?, ?)').run(scope, id, key);
  }

  matches(scope: 'resume' | 'job', id: string, root: string): boolean {
    const saved = this.storage.db.query<{binding: string}, [string,string]>('SELECT binding FROM account_bindings WHERE scope=? AND id=?').get(scope,id);
    return !!saved && saved.binding === this.fingerprint(root);
  }
}

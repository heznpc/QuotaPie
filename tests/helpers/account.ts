import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function fakeCodexLogin(root: string, account = 'test-account', subject = 'test-user', token = 'first') {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'auth.json'), JSON.stringify({ tokens: {
    account_id: account, id_token: 'header.' + Buffer.from(JSON.stringify({sub: subject})).toString('base64url') + '.signature',
    access_token: token, refresh_token: token,
  } }));
}

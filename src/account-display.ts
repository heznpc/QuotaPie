/** A user alias wins. Setup placeholders give way to the verified login name.
 * Login names are presentation only, never part of event or routing identities. */
export function codexAccountDisplay(label: string | undefined, account: string, email?: string): string {
  const alias = label?.trim();
  const placeholder = /^(main|primary|default|second account|second|두\s*번째\s*계정|기본\s*계정)$/i;
  if (alias && !placeholder.test(alias)) return alias;
  if (email && email.length <= 320 && email.includes("@")) return email;
  return alias || account;
}

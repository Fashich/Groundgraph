import type { Sql } from './client';

export interface SessionRow {
  id: string;
  wallet: string;
  mode: 'sign' | 'view';
  walletName: string | null;
  tosVersion: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export async function insertNonce(
  sql: Sql,
  n: { nonce: string; wallet: string; issuedAt: Date; expiresAt: Date },
): Promise<void> {
  await sql`INSERT INTO auth_nonces (nonce, wallet, issued_at, expires_at) VALUES (${n.nonce}, ${n.wallet}, ${n.issuedAt}, ${n.expiresAt})`;
}

export async function getNonce(
  sql: Sql,
  nonce: string,
): Promise<{ nonce: string; wallet: string; issuedAt: Date; expiresAt: Date; used: boolean } | null> {
  const rows = await sql<
    { nonce: string; wallet: string; issuedAt: Date; expiresAt: Date; used: boolean }[]
  >`SELECT nonce, wallet, issued_at, expires_at, used FROM auth_nonces WHERE nonce = ${nonce}`;
  return rows[0] ?? null;
}

/** Atomically burn a nonce. True only the first time, for the right wallet, before expiry. */
export async function consumeNonce(sql: Sql, nonce: string, wallet: string, now: Date): Promise<boolean> {
  const rows = await sql`UPDATE auth_nonces SET used = true
    WHERE nonce = ${nonce} AND wallet = ${wallet} AND used = false AND expires_at > ${now}
    RETURNING nonce`;
  return rows.length === 1;
}

export async function createSession(
  sql: Sql,
  s: {
    id: string;
    wallet: string;
    mode: 'sign' | 'view';
    walletName?: string | null;
    tosVersion?: string | null;
    expiresAt: Date;
  },
): Promise<void> {
  await sql`INSERT INTO sessions (id, wallet, mode, wallet_name, tos_version, expires_at)
    VALUES (${s.id}, ${s.wallet}, ${s.mode}, ${s.walletName ?? null}, ${s.tosVersion ?? null}, ${s.expiresAt})`;
}

export async function getSession(sql: Sql, id: string, now: Date): Promise<SessionRow | null> {
  const rows = await sql<SessionRow[]>`SELECT id, wallet, mode, wallet_name, tos_version, created_at, expires_at
    FROM sessions WHERE id = ${id} AND expires_at > ${now}`;
  return rows[0] ?? null;
}

export async function deleteSession(sql: Sql, id: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE id = ${id}`;
}

export async function setSessionTos(sql: Sql, id: string, tosVersion: string): Promise<void> {
  await sql`UPDATE sessions SET tos_version = ${tosVersion} WHERE id = ${id}`;
}

export async function purgeExpiredAuth(sql: Sql, now: Date): Promise<{ sessions: number; nonces: number }> {
  const s = await sql`DELETE FROM sessions WHERE expires_at < ${now} RETURNING id`;
  const n = await sql`DELETE FROM auth_nonces WHERE expires_at < ${new Date(now.getTime() - 3600_000)} RETURNING nonce`;
  return { sessions: s.length, nonces: n.length };
}

/** Records the first acceptance of a ToS version for a wallet (later calls keep the original evidence). */
export async function recordTosAcceptance(
  sql: Sql,
  t: { wallet: string; tosVersion: string; signedMessage: string; signature: string | null; ipCountry: string | null },
): Promise<void> {
  await sql`INSERT INTO tos_acceptances (wallet, tos_version, signed_message, signature, ip_country)
    VALUES (${t.wallet}, ${t.tosVersion}, ${t.signedMessage}, ${t.signature}, ${t.ipCountry})
    ON CONFLICT (wallet, tos_version) DO NOTHING`;
}

export async function hasAcceptedTos(sql: Sql, wallet: string, tosVersion: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM tos_acceptances WHERE wallet = ${wallet} AND tos_version = ${tosVersion}`;
  return rows.length > 0;
}

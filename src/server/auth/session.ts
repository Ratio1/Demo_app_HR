/**
 * Session issuance and resolution (spec §6 S2, S3) - the contract the rest of the application
 * authenticates through.
 *
 * ## For page authors (Server Components)
 *
 * ```ts
 * import { cookies } from "next/headers";
 * import { SESSION_COOKIE_NAME, loadPrincipal } from "@/server/auth/session";
 * import { getPool } from "@/server/db/pool";
 *
 * const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
 * const principal = await loadPrincipal(getPool(), token);   // null ⇒ redirect to /login
 * // principal.csrfToken is the value of the hidden `csrf` field on authenticated forms.
 * ```
 *
 * The login form's token is different: it is a double-submit cookie minted by `src/proxy.ts`
 * and handed to the page as the `x-login-csrf` request header (see `csrf.ts`).
 *
 * This module imports nothing from Next.js on purpose - the `manage` CLI compiles the same
 * `src/server/**` tree (ruling O1).
 */
import type { Pool, PoolClient } from "../db/pool.js";

import { withClient } from "../db/pool.js";
import type { AccountRole } from "../repos/accounts.js";
import {
  SESSION_TOUCH_INTERVAL_MS,
  findSessionByTokenHash,
  insertSession,
  isSessionLive,
  revokeAccountSessions,
  touchSession,
  type SessionRow,
} from "../repos/sessions.js";
import { SESSION_COOKIE_NAME } from "../../shared/cookies.js";
import { newToken, sha256Hex } from "./tokens.js";

/** Host-only cookie: the `__Host-` prefix forbids `Domain` and demands `Secure` + `Path=/`. */
export { SESSION_COOKIE_NAME };

export interface Principal {
  readonly accountId: string;
  readonly email: string;
  readonly role: AccountRole;
  readonly sessionId: string;
  /** The synchronizer token for this session; render it as the hidden `csrf` field. */
  readonly csrfToken: string;
}

export interface IssuedSession {
  /** The clear-text token; it goes into the cookie and is never stored or logged. */
  readonly token: string;
  readonly row: SessionRow;
  readonly csrfToken: string;
}

/**
 * Mints a 256-bit session token and its CSRF token inside the caller's transaction. Only the
 * SHA-256 digest of the session token is written.
 */
export async function issueSession(
  client: PoolClient,
  accountId: string,
): Promise<IssuedSession> {
  const token = newToken();
  const csrfToken = newToken();
  const row = await insertSession(client, {
    accountId,
    tokenSha256: sha256Hex(token),
    csrfToken,
  });
  return { token, row, csrfToken };
}

/**
 * Rotation (S2: "rotate on login/password change"): every existing session of the account is
 * revoked and a fresh one issued, in the caller's transaction.
 */
export async function rotateSession(
  client: PoolClient,
  accountId: string,
): Promise<IssuedSession> {
  await revokeAccountSessions(client, accountId);
  return issueSession(client, accountId);
}

/**
 * Resolves the principal from a clear-text cookie value, re-reading the account on every call.
 *
 * Returns `null` - never a reason - when the token is absent, unknown, revoked, idle for more
 * than 30 minutes, older than 8 hours, or owned by an account that is no longer active. The
 * idle clock is refreshed at most once a minute.
 */
export async function loadPrincipal(
  pool: Pool,
  rawToken: string | null | undefined,
): Promise<Principal | null> {
  if (rawToken === null || rawToken === undefined || rawToken === "") {
    return null;
  }
  return withClient(pool, async (client) => resolvePrincipal(client, rawToken));
}

/** The same resolution on a caller-supplied client, for code already inside a transaction. */
export async function resolvePrincipal(
  client: PoolClient,
  rawToken: string,
): Promise<Principal | null> {
  const found = await findSessionByTokenHash(client, sha256Hex(rawToken));
  if (found === null) {
    return null;
  }
  const now = new Date();
  if (!found.accountActive || !isSessionLive(found.session, now)) {
    return null;
  }

  if (now.getTime() - found.session.last_seen_at.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    await touchSession(client, found.session.id);
  }

  return {
    accountId: found.session.account_id,
    email: found.accountEmail,
    role: found.accountRole,
    sessionId: found.session.id,
    csrfToken: found.session.csrf_token,
  };
}

/**
 * `__Host-session=<token>; Secure; HttpOnly; SameSite=Lax; Path=/` with no `Domain`, no
 * `Max-Age` and no `Expires`: the lifetime lives in the database, not in the browser (S2).
 */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** The expiring form sent on logout, alongside the server-side revocation. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

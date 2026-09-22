/**
 * Opaque token material (spec §6 S2, S3).
 *
 * Session tokens and CSRF tokens are 256 bits from the platform CSPRNG. Sessions are stored
 * as a SHA-256 hex digest, never in the clear, so a database dump does not hand over live
 * sessions. Comparisons go through `timingSafeEqual` on equal-length buffers.
 *
 * There is no signing key and no JWT anywhere in this application: the token is a random
 * string whose only meaning is the row it matches (S2).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 bytes = 256 bits, as S2 requires. */
export const TOKEN_BYTES = 32;

/** base64url of 32 random bytes: 43 characters, cookie-safe, no padding. */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Lowercase hex digest; the `sessions.token_sha256` column is exactly 64 characters. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Constant-time string comparison. Unequal lengths short-circuit - the length of a CSRF token
 * is not a secret, its content is.
 */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return timingSafeEqual(a, b);
}

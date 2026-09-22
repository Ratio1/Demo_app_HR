/**
 * Password policy and hashing (spec §6 S1).
 *
 *  - Argon2id, 19 MiB of memory, two passes, parallelism one, independent random salts
 *    (the library draws a fresh 16-byte salt per hash and encodes it in the PHC string);
 *  - 15 to 128 characters, counted in code points after NFKC normalization, never truncated;
 *  - a bundled common-password blocklist;
 *  - one active hash per container with eight queued (the semaphore), so a burst of logins
 *    cannot exhaust the half-core, one-gibibyte envelope;
 *  - a comparable-work dummy verification for unknown accounts, so a wrong email and a wrong
 *    password cost the same and return the same generic failure.
 *
 * No plaintext password is ever logged, returned, or placed in an error message.
 */
import { randomBytes } from "node:crypto";

import { hash as argon2Hash, verify as argon2Verify, type Algorithm } from "@node-rs/argon2";

/**
 * `Algorithm.Argon2id`. The enum is an ambient `const enum`, which `isolatedModules` forbids
 * importing as a value, so the member's number is written out and pinned by a unit test that
 * reads it back from a produced hash (`$argon2id$`).
 */
const ARGON2ID: Algorithm = 2 as Algorithm;

import { isBlockedPassword } from "./blocklist.js";
import { argon2Semaphore, type Semaphore } from "./semaphore.js";

/** Exactly the parameters S1 mandates. Constants, never configuration. */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem = "too_short" | "too_long" | "blocked" | "control_characters";

export interface PasswordCheck {
  readonly ok: boolean;
  readonly problem?: PasswordProblem;
  readonly message?: string;
}

const PROBLEM_MESSAGES: Readonly<Record<PasswordProblem, string>> = {
  too_short: `the password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
  too_long: `the password must be at most ${PASSWORD_MAX_LENGTH} characters long`,
  blocked: "that password is too common - choose a different one",
  control_characters: "the password must not contain control characters",
};

/**
 * The single normalization every code path uses, so a password set through the CLI verifies
 * through the web form and the other way round. NFKC only: nothing is trimmed, nothing is
 * folded, nothing is cut short.
 */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

/** Code points, not UTF-16 units: an emoji counts as one character, as a user would expect. */
export function passwordLength(password: string): number {
  return [...normalizePassword(password)].length;
}

/** Policy only. It never touches the database and never hashes. */
export function checkPasswordPolicy(password: string): PasswordCheck {
  const normalized = normalizePassword(password);
  const length = [...normalized].length;

  if (length < PASSWORD_MIN_LENGTH) {
    return { ok: false, problem: "too_short", message: PROBLEM_MESSAGES.too_short };
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return { ok: false, problem: "too_long", message: PROBLEM_MESSAGES.too_long };
  }
  // Deliberate: C0 and C1 control characters are rejected, not silently stripped.
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) {
    return {
      ok: false,
      problem: "control_characters",
      message: PROBLEM_MESSAGES.control_characters,
    };
  }
  if (isBlockedPassword(normalized)) {
    return { ok: false, problem: "blocked", message: PROBLEM_MESSAGES.blocked };
  }
  return { ok: true };
}

/**
 * Hashes through the semaphore. Throws `CapacityError` when the queue is full; the caller
 * turns that into a sanitized 429 with `Retry-After`.
 */
export async function hashPassword(
  password: string,
  semaphore: Semaphore = argon2Semaphore,
): Promise<string> {
  const normalized = normalizePassword(password);
  return semaphore.run(() => argon2Hash(normalized, ARGON2_OPTIONS));
}

/**
 * Verifies through the same semaphore. A malformed or foreign stored hash verifies to `false`
 * rather than throwing, so one broken row cannot turn a login into a 500 that names it.
 */
export async function verifyPassword(
  storedHash: string,
  password: string,
  semaphore: Semaphore = argon2Semaphore,
): Promise<boolean> {
  const normalized = normalizePassword(password);
  return semaphore.run(async () => {
    try {
      return await argon2Verify(storedHash, normalized, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  });
}

/**
 * A hash of a value nobody knows, computed on first use - never at import or build time, so
 * `next build` neither spends 19 MiB nor stalls. `dummyVerify` exists so that a login for an
 * unknown or inactive account performs the same Argon2 work as a real one (S1
 * "comparable missing-user verification").
 */
let dummyHash: Promise<string> | undefined;

export async function dummyVerify(
  password: string,
  semaphore: Semaphore = argon2Semaphore,
): Promise<false> {
  if (dummyHash === undefined) {
    // Through the semaphore like every other hash, and dropped again if it is refused, so a
    // rejected promise is never cached for the life of the process.
    const pending = semaphore.run(() => argon2Hash(randomBytes(24).toString("base64url"), ARGON2_OPTIONS));
    dummyHash = pending;
    pending.catch(() => {
      if (dummyHash === pending) {
        dummyHash = undefined;
      }
    });
  }
  const stored = await dummyHash;
  await verifyPassword(stored, password, semaphore);
  return false;
}

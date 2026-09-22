/**
 * The pieces every DTO module shares: the two request fields that appear on every mutation body
 * and the two result shapes every service returns (spec §3 "field-allowlisted DTOs", §6 S4, S6).
 *
 * Extracted in slice 3 so `dto/employees.ts` and `dto/leave.ts` cannot drift on the wording of a
 * stale-version message or on what a database failure looks like to a page. `dto/employees.ts`
 * re-exports the two types under their original names, so every slice-2 import keeps working.
 *
 * Like the other DTO modules this one imports nothing but `zod` and `src/shared/**`, so a client
 * component may import from it without pulling `pg`, `node:crypto` or `@node-rs/argon2` into a
 * browser bundle.
 */
import { z } from "zod";

import { CSRF_FIELD_NAME } from "../../shared/cookies.ts";

export { CSRF_FIELD_NAME };

/** The synchronizer token, present on every mutation body (S3). Bounded like any other input. */
export const csrfField = z.string({ error: "Reload the page and try again." }).min(1).max(128);

/**
 * `version` arrives as text from a form and as a number from JSON; both become this integer, so
 * the two encodings cannot diverge (data contract C2: every editable row carries a version and
 * every update carries `AND version = $expected`).
 */
export const versionField = z
  .string({ error: "This record's version is missing. Reload the page and try again." })
  .transform((value) => value.trim())
  .refine((value) => /^[1-9][0-9]{0,8}$/u.test(value), {
    message: "This record's version is missing. Reload the page and try again.",
  })
  .transform((value) => Number(value));

/** Per-field messages for the inline form errors; the keys are the schema's own field names. */
export type FieldErrors = Readonly<Record<string, string>>;

/**
 * What the page-facing reads return. `unavailable` is a database failure the page turns into the
 * 503 banner; nothing carries an internal detail (S6: "DB failures close access with sanitized
 * 503; no secrets, SQL, traces, cookies, or personal record bodies").
 */
export type ReadResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" };

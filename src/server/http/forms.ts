/**
 * Form validation for the three authentication routes (spec §6 S4).
 *
 * Two rules, both enforced here rather than in the handlers:
 *
 *  - **strict keys**: a body carrying any field outside the allowlist is rejected, never
 *    silently trimmed, which is what stops over-posting (`role`, `account_id`, `active`, … );
 *  - **bounded inputs**: every field has a maximum length, so an attacker cannot make the
 *    server hash a megabyte-long password inside its half-core budget.
 *
 * Passwords are bounded but not policy-checked here: the login route must not tell a caller
 * *why* a credential failed, and the change-password route applies the S1 policy in the
 * service, on the new password only.
 */
import { z } from "zod";

import { CSRF_FIELD_NAME } from "../auth/csrf.js";
import { PASSWORD_MAX_LENGTH } from "../auth/password.js";

/** Long enough for the longest legal password plus NFKC expansion, short enough to bound work. */
const PASSWORD_FIELD_MAX = PASSWORD_MAX_LENGTH * 4;
const EMAIL_FIELD_MAX = 254;
const CSRF_FIELD_MAX = 128;

export const loginForm = z.strictObject({
  email: z.string().min(1).max(EMAIL_FIELD_MAX),
  password: z.string().min(1).max(PASSWORD_FIELD_MAX),
  [CSRF_FIELD_NAME]: z.string().min(1).max(CSRF_FIELD_MAX),
});

export const logoutForm = z.strictObject({
  [CSRF_FIELD_NAME]: z.string().min(1).max(CSRF_FIELD_MAX),
});

export const passwordForm = z.strictObject({
  current_password: z.string().min(1).max(PASSWORD_FIELD_MAX),
  new_password: z.string().min(1).max(PASSWORD_FIELD_MAX),
  [CSRF_FIELD_NAME]: z.string().min(1).max(CSRF_FIELD_MAX),
});

/**
 * `URLSearchParams` to a plain object, refusing a repeated key rather than taking the first or
 * the last: a duplicated field is how parameter-pollution attacks start.
 */
export function formToObject(form: URLSearchParams): Record<string, string> | null {
  const object: Record<string, string> = {};
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key);
    if (values.length !== 1) {
      return null;
    }
    object[key] = values[0] as string;
  }
  return object;
}

export type ParsedForm<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export function parseForm<T>(schema: z.ZodType<T>, form: URLSearchParams): ParsedForm<T> {
  const object = formToObject(form);
  if (object === null) {
    return { ok: false };
  }
  const result = schema.safeParse(object);
  return result.success ? { ok: true, value: result.data } : { ok: false };
}

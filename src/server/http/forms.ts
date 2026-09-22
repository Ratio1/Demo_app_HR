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

import { CSRF_FIELD_NAME } from "../auth/csrf.ts";
import { PASSWORD_MAX_LENGTH } from "../auth/password.ts";

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

/** The flat shape both body encodings collapse to before a schema ever sees them. */
export type BodyFields = Readonly<Record<string, string>>;

/**
 * `URLSearchParams` to a plain object, refusing a repeated key rather than taking the first or
 * the last: a duplicated field is how parameter-pollution attacks start.
 *
 * Built with `Object.fromEntries`, which *defines* each own property, so a field literally
 * named `__proto__` becomes a visible unknown key that `z.strictObject` refuses — assigning it
 * to an object literal would instead hit `Object.prototype`'s setter and vanish silently.
 */
export function formToObject(form: URLSearchParams): Record<string, string> | null {
  const entries: [string, string][] = [];
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key);
    if (values.length !== 1) {
      return null;
    }
    entries.push([key, values[0] as string]);
  }
  return Object.fromEntries(entries);
}

/**
 * A parsed JSON body to the same flat record, so a JSON caller and a form caller are validated
 * by one schema and cannot diverge.
 *
 * Only a plain object of scalars is accepted: a nested object, an array, a `null` value or a
 * non-finite number returns `null`, which the caller answers with `400 invalid_input`. Numbers
 * and booleans are compared in their string form, which is exactly what the form encoding
 * would have sent.
 */
export function jsonToFields(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entries: [string, string][] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      entries.push([key, raw]);
    } else if (typeof raw === "boolean") {
      entries.push([key, raw ? "true" : "false"]);
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      entries.push([key, String(raw)]);
    } else {
      return null;
    }
  }
  return Object.fromEntries(entries);
}

/**
 * `unknown_key` is an over-post or a duplicated field - an attack shape, answered with a hard
 * `400 invalid_input` (access matrix §2.3, `D-007`…`D-011`). `invalid` is a field the user can
 * correct, answered by sending them back to the form.
 */
export type ParsedForm<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "unknown_key" | "invalid" };

export function parseForm<T>(schema: z.ZodType<T>, form: URLSearchParams): ParsedForm<T> {
  const object = formToObject(form);
  if (object === null) {
    // The same field twice: parameter pollution, not a typo.
    return { ok: false, reason: "unknown_key" };
  }
  const result = schema.safeParse(object);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const overPosted = result.error.issues.some((issue) => issue.code === "unrecognized_keys");
  return { ok: false, reason: overPosted ? "unknown_key" : "invalid" };
}

/**
 * The same parse for the slice 2 routes, which show the user *which* field is wrong instead of
 * redirecting: `unknown_key` stays a hard refusal with no detail (it is an attack shape, and
 * naming the rejected key would confirm a guess), while a correctable value comes back as one
 * message per field, first issue wins.
 */
export type ParsedFields<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "unknown_key" }
  | { readonly ok: false; readonly reason: "invalid"; readonly fields: Record<string, string> };

export function parseFields<T>(schema: z.ZodType<T>, fields: BodyFields): ParsedFields<T> {
  const result = schema.safeParse(fields);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  if (result.error.issues.some((issue) => issue.code === "unrecognized_keys")) {
    return { ok: false, reason: "unknown_key" };
  }
  const messages: [string, string][] = [];
  const seen = new Set<string>();
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "form";
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    messages.push([key, issue.message]);
  }
  return { ok: false, reason: "invalid", fields: Object.fromEntries(messages) };
}

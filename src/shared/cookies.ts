/**
 * Cookie and header names shared by `src/proxy.ts`, the Route Handlers and the pages.
 *
 * This module imports nothing - not `node:crypto`, not `pg`, not Next - so the proxy bundle can
 * use the same constants as the server modules without dragging a Node-only dependency into a
 * runtime that may not have one. Everything here is a name or a number, never a secret.
 */

/** Host-only session cookie: the `__Host-` prefix forbids `Domain` and demands `Secure`+`Path=/`. */
export const SESSION_COOKIE_NAME = "__Host-session";

/** The login form's double-submit cookie, minted by `src/proxy.ts` for `GET /login`. */
export const LOGIN_CSRF_COOKIE_NAME = "__Host-csrf";

/** How `src/proxy.ts` hands the login page the value it just put in that cookie. */
export const LOGIN_CSRF_HEADER = "x-login-csrf";

/** Ten minutes (spec §6 S3's pre-auth window). */
export const LOGIN_CSRF_MAX_AGE_SECONDS = 600;

/** The hidden field on every mutating form, authenticated or not. */
export const CSRF_FIELD_NAME = "csrf";

/** The per-request CSP nonce header `src/proxy.ts` sets and the layout reads. */
export const NONCE_HEADER = "x-nonce";

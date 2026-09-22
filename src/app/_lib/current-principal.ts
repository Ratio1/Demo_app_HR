import { cache } from "react";
import { cookies } from "next/headers";

import { getPool } from "@/server/db/pool";
import { loadPrincipal, SESSION_COOKIE_NAME, type Principal } from "@/server/auth/session";

/**
 * The one place `/` and `/me` read the current session, following the pattern
 * `src/server/auth/session.ts`'s own doc comment gives page authors verbatim. Not under
 * `src/server/**` (part C does not own that tree) — this is a thin, page-side wrapper around
 * part B's `loadPrincipal`, kept in one file so both pages read the cookie the same way.
 *
 * Returns `null` for "no live session" exactly as `loadPrincipal` does — the caller decides
 * what to do (redirect to `/login`); this wrapper adds no policy of its own.
 *
 * The pool is constructed only when a session cookie is actually present. `loadPrincipal`
 * itself short-circuits to `null` for a missing token without touching the pool argument it is
 * given — but `getPool()` throws synchronously on an invalid five-variable configuration
 * (`ConfigError`), so calling it unconditionally would turn every anonymous visit to `/` or
 * `/me` into an uncaught 500 instead of the ordinary redirect to `/login`, on a DB-misconfigured
 * deployment. Verified against a running dev server with no `DB_*` variables set at all: before
 * this guard, `GET /` and `GET /me` both threw `ConfigError` and returned 500; after it, an
 * anonymous request never constructs the pool and redirects cleanly.
 *
 * Wrapped in `React.cache`, which memoizes for one server render pass: `/employees` and
 * `/directory` now resolve the session in their segment layout (so an anonymous caller gets a
 * real redirect status rather than a streamed one — see `src/app/employees/layout.tsx`) *and*
 * again in the page, and without this the two would be two `sessions` round-trips per request.
 * The memo is request-scoped and a session cannot change mid-render, so nothing is cached across
 * principals or across requests.
 */
export const currentPrincipal = cache(async (): Promise<Principal | null> => {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (token === undefined || token === "") {
    return null;
  }
  return loadPrincipal(getPool(), token);
});

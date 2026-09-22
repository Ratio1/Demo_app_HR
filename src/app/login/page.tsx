import type { Metadata } from "next";
import { headers } from "next/headers";

import { LOGIN_CSRF_HEADER } from "@/server/auth/csrf";

import { Banner } from "../_components/Banner";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "Sign in — Demo_App_HR",
};

/**
 * S1 — Login (flows.md). `none` capability (access-matrix AM-001): reachable by anyone, no
 * session required.
 *
 * CSRF contract, read from `src/server/auth/csrf.ts`'s own doc comment (part B, landed after
 * this page's first draft — the slice 1 brief named a `getLoginCsrf()` helper that does not
 * exist; this is the real, current contract and this page was updated to match it, see the
 * report's "B contract" section): `src/proxy.ts` mints a 256-bit value for `GET /login`, sets
 * it as the ten-minute `__Host-csrf` cookie, and forwards the *same* value on the request as
 * the `x-login-csrf` header — this page reads that header and renders it as the hidden `csrf`
 * field. `POST /api/login` requires the two to match, in addition to exact `Origin`.
 * `headers()` makes this page dynamic on its own (spec §3: no import/build-time DB access,
 * private/dynamic routes) — no separate `connection()` call is needed.
 *
 * Failure surfacing, read from the committed `src/app/api/login/route.ts` (not guessed): a
 * recoverable failure redirects to `/login?error=invalid_credentials` (wrong email/password,
 * `AM-002`) or `/login?error=invalid_input` (malformed/over-posted body); both render the same
 * generic copy per flows.md S1's `valid` row. **`429` and `403` are answered directly by the
 * route** (a JSON problem body, no redirect at all — see the report's concerns: a plain,
 * script-free form submission navigates straight to that body, which this page cannot
 * intercept or restyle). `?email=` is read defensively in case a later change starts sending
 * the typed address back, but the current route never does — flows.md's "preserved: the typed
 * email address" rule does not yet hold across this redirect, flagged in the report rather
 * than silently assumed to work.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const csrf = (await headers()).get(LOGIN_CSRF_HEADER) ?? "";

  const errorParam = typeof params.error === "string" ? params.error : undefined;
  const emailParam = typeof params.email === "string" ? params.email : "";
  const failed = errorParam === "invalid_credentials" || errorParam === "invalid_input";

  return (
    <main id="main-content" className="mx-auto page-column px-md py-2xl">
      <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">Sign in</h1>

      {failed ? (
        <div className="mb-lg">
          <Banner state="invalid">
            We could not sign you in. Check the email address and password, then try again.
          </Banner>
        </div>
      ) : null}

      <LoginForm csrf={csrf} email={emailParam} />
    </main>
  );
}

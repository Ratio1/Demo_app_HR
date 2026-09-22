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
 * Failure surfacing contract (assumed, not yet confirmed with part B — flagged as a concern
 * in the report): a rejected `POST /api/login` redirects back here with `?error=1` (generic
 * invalid-credential failure, `AM-002`) or `?error=throttled` (`429`), and `?email=` carrying
 * the typed address back (never the password) so flows.md's "preserved: the typed email
 * address" rule holds across the redirect with no client script.
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
  const throttled = errorParam === "throttled";
  const failed = errorParam !== undefined;

  return (
    <main id="main-content" className="mx-auto max-w-md px-md py-2xl">
      <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">Sign in</h1>

      {failed ? (
        <div className="mb-lg">
          <Banner state="invalid">
            {throttled
              ? "Too many attempts. Please wait and try again."
              : "We could not sign you in. Check the email address and password, then try again."}
          </Banner>
        </div>
      ) : null}

      <LoginForm csrf={csrf} email={emailParam} />
    </main>
  );
}

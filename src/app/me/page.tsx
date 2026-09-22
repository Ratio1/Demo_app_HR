import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppNav } from "../_components/AppNav";
import { Banner } from "../_components/Banner";
import { currentPrincipal } from "../_lib/current-principal";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata: Metadata = {
  title: "My account — Demo_App_HR",
};

/**
 * S5/S2 — My account (flows.md), slice 1 scope: the change-password section only. The
 * profile section (S5 "My profile": own name/title/department/work email) needs the
 * `employees` link this slice does not query yet and arrives in slice 2, per the brief.
 *
 * `session` capability, any authenticated account, forced-reset or not — this slice does not
 * implement the forced-reset session mode at all (simplified plan, "Defer" list: "S1
 * forced-reset session mode"), so the fuller access-matrix `session:any-state` distinction
 * does not yet apply; an ordinary live session is the only precondition. No session →
 * redirect to `/login`.
 *
 * Result surfacing, read from the committed `src/app/api/password/route.ts` (not guessed):
 * `POST /api/password` redirects to `/me?status=password_changed` on success, or to one of
 * `/me?error=weak_password` (S1 policy — length/blocklist), `/me?error=invalid_current_password`
 * (current password did not verify), `/me?error=password_unchanged` (new password equals the
 * old one — an outcome this slice's design docs do not name; given a reasonable generic
 * message here, flagged in the report) or `/me?error=invalid_input` (malformed/over-posted
 * body) on failure. **A bad Origin/CSRF (`403`) or a full or db-unavailable (`503`/`429`)
 * answer is returned directly by the route, not a redirect** — same caveat as `/login`: a
 * plain form submission navigates straight to that JSON body.
 */
export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await currentPrincipal();
  if (principal === null) {
    redirect("/login");
  }

  const params = await searchParams;
  const errorParam = typeof params.error === "string" ? params.error : undefined;
  const succeeded = params.status === "password_changed";

  return (
    <>
      <AppNav email={principal.email} role={principal.role} current="me" csrfToken={principal.csrfToken} />
      <main id="main-content" className="mx-auto max-w-md px-md py-2xl">
        <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">My account</h1>

        {succeeded ? (
          <div className="mb-lg" role="status">
            <p className="banner__body text-text-primary">Your password has been changed.</p>
          </div>
        ) : null}

        {errorParam !== undefined ? (
          <div className="mb-lg">
            {errorParam === "invalid_current_password" ? (
              <Banner state="invalid">
                We could not change your password. Check your current password and try again.
              </Banner>
            ) : errorParam === "password_unchanged" ? (
              <Banner state="invalid">
                Choose a new password that is different from your current one.
              </Banner>
            ) : (
              <Banner state="invalid">
                Your new password must be 15 to 128 characters and must not be a commonly used
                password.
              </Banner>
            )}
          </div>
        ) : null}

        <h2 className="mb-sm text-heading-sm font-semibold text-text-primary">
          Change password
        </h2>
        <ChangePasswordForm csrf={principal.csrfToken} />
      </main>
    </>
  );
}

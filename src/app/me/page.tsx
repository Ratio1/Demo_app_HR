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
 * Result surfacing contract (assumed — flagged as a concern in the report, same shape as
 * `/login`'s): `POST /api/password` redirects back here with `?success=1` on success, or
 * `?error=invalid` (policy violation / wrong current password — the vocabulary collapses
 * both into one generic message, `AM-004`) / `?error=forb` (Origin/CSRF guard) /
 * `?error=dbdown` (`503`) on failure.
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
  const succeeded = params.success === "1";

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
            {errorParam === "forb" ? (
              <Banner state="forbidden">
                This form could not be submitted. Reload the page and try again.
              </Banner>
            ) : errorParam === "dbdown" ? (
              <Banner state="db-unavailable">
                Demo_App_HR is temporarily unavailable. Nothing was saved. Try again in a few
                minutes.
              </Banner>
            ) : (
              <Banner state="invalid">
                Your new password must be 15 to 128 characters and must not be a commonly used
                password. If you typed your current password wrong, check it and try again.
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

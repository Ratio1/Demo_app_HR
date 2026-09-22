import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getPool } from "@/server/db/pool";
import { loadOwnProfile } from "@/server/services/employees";

import { AppNav } from "../_components/AppNav";
import { Avatar } from "../_components/Avatar";
import { Banner } from "../_components/Banner";
import { currentPrincipal } from "../_lib/current-principal";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata: Metadata = {
  title: "My account — Demo_App_HR",
};

/**
 * S5/S2 — My account (flows.md). Slice 1 shipped the change-password section only; slice 2
 * adds the S5 "My profile" section above it (own name/title/department/work email, read-only —
 * spec §2: "no employment-field editing").
 *
 * `loadOwnProfile` (src/server/services/employees.ts) returns `data: null` for an account with
 * no linked employee row — an unlinked `hr_admin`, spec §2's explicitly legal case, not an
 * error — rendered here as "No employee record linked", never a `forbidden`/`404` state (the
 * slice-2 brief: "Unlinked hr_admin at /me → profile section says 'no employee record linked'
 * (not an error)").
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
  const profileResult = await loadOwnProfile(getPool(), principal);

  return (
    <>
      <AppNav email={principal.email} role={principal.role} current="me" csrfToken={principal.csrfToken} />
      <main id="main-content" className="mx-auto page-column px-md py-2xl">
        <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">My account</h1>

        <section className="mb-2xl">
          <h2 className="mb-sm text-heading-sm font-semibold text-text-primary">My profile</h2>
          {profileResult.kind === "unavailable" ? (
            <Banner state="db-unavailable">
              We can&rsquo;t reach the database right now. Try again shortly.
            </Banner>
          ) : profileResult.kind === "forbidden" ? (
            // Unreachable (`loadOwnProfile` has no role gate); kept for exhaustiveness.
            <Banner state="forbidden">You don&rsquo;t have access to this.</Banner>
          ) : profileResult.data === null ? (
            <p className="text-body text-text-secondary">No employee record linked.</p>
          ) : (
            <div className="card">
              <div className="mb-md flex items-center gap-sm">
                <Avatar fullName={profileResult.data.full_name} size={56} />
                <div>
                  <p className="text-body font-medium text-text-primary">
                    {profileResult.data.full_name}
                  </p>
                  <p className="text-caption text-text-secondary">{profileResult.data.code}</p>
                </div>
              </div>
              <div className="card__row">
                <span className="text-text-secondary">Title</span>
                <span className="card__value">{profileResult.data.title}</span>
              </div>
              <div className="card__row">
                <span className="text-text-secondary">Department</span>
                <span className="card__value">{profileResult.data.department}</span>
              </div>
              <div className="card__row">
                <span className="text-text-secondary">Work email</span>
                <span className="card__value">{profileResult.data.work_email}</span>
              </div>
              <div className="card__row">
                <span className="text-text-secondary">Start date</span>
                <span className="card__value">{profileResult.data.start_date}</span>
              </div>
            </div>
          )}
        </section>

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

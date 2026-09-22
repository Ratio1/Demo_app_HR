import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppNav } from "./_components/AppNav";
import { currentPrincipal } from "./_lib/current-principal";

export const metadata: Metadata = {
  title: "Overview — Demo_App_HR",
};

/**
 * S3 — Role overview and navigation (flows.md), shipped in slice 1 as the placeholder the
 * brief asks for: "role + email". The HR headcount/department-counts/approval-queue and the
 * employee's own request-status figures (spec §2 Dashboard) arrive with the data they
 * summarise, in slices 2–3 — showing them now would mean querying tables no route yet writes
 * to, or fabricating numbers, either of which is worse than an honest placeholder.
 *
 * `session` capability (access-matrix AM-024/AM-025): any live session. No session → redirect
 * to `/login`. `redirect()` issues a 307 for a GET here, not the matrix's exact `303` (noted
 * as a deviation in the report; functionally identical for a GET).
 */
export default async function OverviewPage() {
  const principal = await currentPrincipal();
  if (principal === null) {
    redirect("/login");
  }

  return (
    <>
      <AppNav
        email={principal.email}
        role={principal.role}
        current="overview"
        csrfToken={principal.csrfToken}
      />
      <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
        <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">Overview</h1>
        <p className="text-body text-text-primary">
          Signed in as <strong>{principal.email}</strong> —{" "}
          {principal.role === "hr_admin" ? "HR admin" : "Employee"}.
        </p>
        <p className="mt-sm text-body text-text-secondary">
          The directory, employee records and leave dashboard arrive in later slices.
        </p>
      </main>
    </>
  );
}

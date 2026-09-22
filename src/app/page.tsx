import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getPool } from "@/server/db/pool";
import { loadOverview } from "@/server/services/overview";

import { AppNav } from "./_components/AppNav";
import { Banner } from "./_components/Banner";
import { EmptyState } from "./_components/EmptyState";
import { EmptyEmployeesIcon } from "./_components/icons";
import { currentPrincipal } from "./_lib/current-principal";

export const metadata: Metadata = {
  title: "Overview — Demo_App_HR",
};

/**
 * S3 — Role overview and navigation (flows.md). Slice 1 shipped the "role + email" placeholder;
 * slice 2 adds real figures from `src/server/services/overview.ts` (B's file, per the slice-2
 * brief's ownership split): HR headcount + per-department active counts + a "pending approvals:
 * n" placeholder (always 0 until slice 3 writes leave decisions — spec §2 Dashboard: "employees
 * only own request status, never colleagues' leave or HR-only totals", enforced by
 * `loadOverview` returning a role-tagged union, never a single shape a page could widen).
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

  const result = await loadOverview(getPool(), principal);

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
        <p className="mb-lg text-body text-text-primary">
          Signed in as <strong>{principal.email}</strong> —{" "}
          {principal.role === "hr_admin" ? "HR admin" : "Employee"}.
        </p>

        {result.kind === "unavailable" ? (
          <Banner state="db-unavailable">
            We can&rsquo;t reach the database right now. Try again shortly.
          </Banner>
        ) : result.kind === "forbidden" ? (
          // Unreachable (`loadOverview` has no role gate); kept for exhaustiveness.
          <Banner state="forbidden">You don&rsquo;t have access to this.</Banner>
        ) : result.data.role === "hr_admin" ? (
          result.data.headcount === 0 ? (
            <EmptyState illustration={EmptyEmployeesIcon} heading="No employees yet">
              Add your first employee from the Employees page to see headcount here.
            </EmptyState>
          ) : (
            <div className="card">
              <p className="text-body text-text-primary">
                Headcount: <strong>{result.data.headcount}</strong>
              </p>
              <ul className="mt-sm" role="list">
                {result.data.departments.map((department) => (
                  <li key={department.department} className="card__row">
                    <span className="card__value">{department.department}</span>
                    <span className="card__value">{department.count}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-md text-body text-text-secondary">
                Pending approvals: {result.data.pendingApprovals}
              </p>
            </div>
          )
        ) : (
          <div className="card">
            <p className="text-body text-text-primary">
              {result.data.fullName ?? "No employee record linked."}
            </p>
            <p className="mt-sm text-body text-text-secondary">No leave requests yet.</p>
          </div>
        )}
      </main>
    </>
  );
}

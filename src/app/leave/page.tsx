import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getPool } from "@/server/db/pool";
import { loadOwnLeave } from "@/server/services/leave";
import { LEAVE_KIND_LABELS, type OwnLeaveDTO } from "@/server/dto/leave";

import { AppNav } from "../_components/AppNav";
import { Banner } from "../_components/Banner";
import { EmptyState } from "../_components/EmptyState";
import { EmptyMyLeaveIcon } from "../_components/icons";
import { LeaveCancelControl } from "../_components/LeaveCancelControl";
import { LeaveForm } from "../_components/LeaveForm";
import { StatusBadge } from "../_components/StatusBadge";
import { currentPrincipal } from "../_lib/current-principal";

export const metadata: Metadata = {
  title: "My leave — Demo_App_HR",
};

const SAVED_COPY: Record<string, string> = {
  submitted: "Your leave request has been submitted.",
  cancelled: "Your leave request has been cancelled.",
};

/**
 * S8 — My leave (slice-3 brief), any live session. `loadOwnLeave` (`src/server/services/
 * leave.ts`, part B) returns `{ linked: false }` for an account with no `employees` row — the
 * legitimate "unlinked `hr_admin`" case spec §2 allows — which this page renders as the
 * `forbidden` state tokens.md §7 lists for S8, not as a database error. No `no-results` state:
 * this slice ships no pagination (tokens.md §8 item 3 — paging past the last page is its only
 * trigger, and there is no paging control here).
 */
export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await currentPrincipal();
  if (principal === null) {
    redirect("/login");
  }

  const nav = (
    <AppNav
      email={principal.email}
      role={principal.role}
      current="leave"
      csrfToken={principal.csrfToken}
    />
  );

  const params = await searchParams;
  const saved = typeof params.saved === "string" ? SAVED_COPY[params.saved] : undefined;

  const result = await loadOwnLeave(getPool(), principal);

  return (
    <>
      {nav}
      <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
        <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">My leave</h1>

        {result.kind === "unavailable" ? (
          <Banner state="db-unavailable">
            We can&rsquo;t reach the database right now. Try again shortly.
          </Banner>
        ) : result.kind === "forbidden" ? (
          // Unreachable (`loadOwnLeave` has no role gate); kept for exhaustiveness.
          <Banner state="forbidden">You don&rsquo;t have access to this.</Banner>
        ) : !result.data.linked ? (
          <Banner state="forbidden">
            You don&rsquo;t have an employee record linked, so there is no leave to request or
            view.
          </Banner>
        ) : (
          <>
            {saved ? (
              <div className="mb-lg" role="status">
                <p className="banner__body text-text-primary">{saved}</p>
              </div>
            ) : null}

            <section className="mb-2xl">
              <h2 className="mb-sm text-heading-sm font-semibold text-text-primary">
                Request leave
              </h2>
              <LeaveForm csrfToken={principal.csrfToken} />
            </section>

            <section>
              <h2 className="mb-sm text-heading-sm font-semibold text-text-primary">
                Your requests
              </h2>
              {result.data.requests.length === 0 ? (
                <EmptyState illustration={EmptyMyLeaveIcon} heading="No leave requests yet">
                  Submit your first request above.
                </EmptyState>
              ) : (
                <OwnLeaveList requests={result.data.requests} csrfToken={principal.csrfToken} />
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function formatRange(request: OwnLeaveDTO): string {
  return `${request.start_date} – ${request.end_date}`;
}

function OwnLeaveList({
  requests,
  csrfToken,
}: {
  requests: readonly OwnLeaveDTO[];
  csrfToken: string;
}) {
  return (
    <>
      <table className="data-table hidden w-full sm:table">
        <caption className="sr-only">Your leave requests</caption>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Dates</th>
            <th scope="col">Weekdays</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="sr-only">Cancel</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={`${request.id}:${request.version}`}>
              <td>{LEAVE_KIND_LABELS[request.kind]}</td>
              <td>{formatRange(request)}</td>
              <td>{request.weekdays}</td>
              <td>
                <StatusBadge status={request.status} />
              </td>
              <td>
                {request.status === "pending" ? (
                  <LeaveCancelControl request={request} csrfToken={csrfToken} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="card-list sm:hidden" role="list">
        {requests.map((request) => (
          <li key={`${request.id}:${request.version}`} className="card">
            <div className="mb-sm flex items-center justify-between gap-sm">
              <span className="text-body font-medium text-text-primary">
                {LEAVE_KIND_LABELS[request.kind]}
              </span>
              <StatusBadge status={request.status} />
            </div>
            <div className="card__row">
              <span className="sr-only">Dates</span>
              <span className="card__value">{formatRange(request)}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Weekdays</span>
              <span className="card__value">{request.weekdays}</span>
            </div>
            {request.status === "pending" ? (
              <div className="mt-sm">
                <LeaveCancelControl request={request} csrfToken={csrfToken} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

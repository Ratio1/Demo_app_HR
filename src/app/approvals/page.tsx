import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getPool } from "@/server/db/pool";
import { loadApprovals } from "@/server/services/leave";
import { LEAVE_KIND_LABELS, type ApprovalDTO } from "@/server/dto/leave";

import { AppNav } from "../_components/AppNav";
import { ApprovalDecisionControl } from "../_components/ApprovalDecisionControl";
import { Avatar } from "../_components/Avatar";
import { Banner } from "../_components/Banner";
import { EmptyState } from "../_components/EmptyState";
import { EmptyApprovalsIcon } from "../_components/icons";
import { StatusBadge } from "../_components/StatusBadge";
import { currentPrincipal } from "../_lib/current-principal";

export const metadata: Metadata = {
  title: "Approvals — Demo_App_HR",
};

const SAVED_COPY: Record<string, string> = {
  approved: "The request has been approved.",
  rejected: "The request has been rejected.",
};

/**
 * S9 — Approvals (slice-3 brief), `hr_admin` only. The role check runs before any database read
 * (same reasoning as `/employees`'s own doc comment: a denied `employee` never causes a query),
 * even though `loadApprovals` (`src/server/services/leave.ts`, part B) re-checks it and would
 * answer `forbidden` on its own. No `no-results` state — see `/leave`'s identical note; this
 * slice ships no pagination.
 */
export default async function ApprovalsPage({
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
      current="approvals"
      csrfToken={principal.csrfToken}
    />
  );

  if (principal.role !== "hr_admin") {
    return (
      <>
        {nav}
        <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
          <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">Approvals</h1>
          <Banner state="forbidden">You don&rsquo;t have access to this.</Banner>
        </main>
      </>
    );
  }

  const params = await searchParams;
  const saved = typeof params.saved === "string" ? SAVED_COPY[params.saved] : undefined;

  const result = await loadApprovals(getPool(), principal);

  return (
    <>
      {nav}
      <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
        <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">Approvals</h1>

        {result.kind === "unavailable" ? (
          <Banner state="db-unavailable">
            We can&rsquo;t reach the database right now. Try again shortly.
          </Banner>
        ) : result.kind === "forbidden" ? (
          // Unreachable (already checked above); kept for exhaustiveness.
          <Banner state="forbidden">You don&rsquo;t have access to this.</Banner>
        ) : (
          <>
            {saved ? (
              <div className="mb-lg" role="status">
                <p className="banner__body text-text-primary">{saved}</p>
              </div>
            ) : null}

            <section className="mb-2xl">
              <h2 className="mb-sm text-heading-sm font-semibold text-text-primary">Pending</h2>
              {result.data.pending.length === 0 ? (
                <EmptyState illustration={EmptyApprovalsIcon} heading="No pending requests">
                  New leave requests will appear here for you to review.
                </EmptyState>
              ) : (
                <PendingApprovalsList
                  requests={result.data.pending}
                  csrfToken={principal.csrfToken}
                />
              )}
            </section>

            <section>
              <h2 className="mb-sm text-heading-sm font-semibold text-text-primary">
                Recently decided
              </h2>
              {result.data.decided.length === 0 ? (
                <p className="text-body text-text-secondary">No decisions yet.</p>
              ) : (
                <DecidedApprovalsList requests={result.data.decided} />
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function formatRange(request: ApprovalDTO): string {
  return `${request.start_date} – ${request.end_date}`;
}

function EmployeeCell({ employee }: { employee: ApprovalDTO["employee"] }) {
  return (
    <div className="flex items-center gap-sm">
      <Avatar fullName={employee.full_name} />
      <div>
        <div>{employee.full_name}</div>
        <div className="text-caption text-text-secondary">{employee.department}</div>
      </div>
    </div>
  );
}

function PendingApprovalsList({
  requests,
  csrfToken,
}: {
  requests: readonly ApprovalDTO[];
  csrfToken: string;
}) {
  return (
    <>
      <table className="data-table hidden w-full sm:table">
        <caption className="sr-only">Pending leave requests</caption>
        <thead>
          <tr>
            <th scope="col">Employee</th>
            <th scope="col">Type</th>
            <th scope="col">Dates</th>
            <th scope="col">Weekdays</th>
            <th scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={`${request.id}:${request.version}`}>
              <td>
                <EmployeeCell employee={request.employee} />
              </td>
              <td>{LEAVE_KIND_LABELS[request.kind]}</td>
              <td>{formatRange(request)}</td>
              <td>{request.weekdays}</td>
              <td>
                <ApprovalDecisionControl request={request} csrfToken={csrfToken} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="card-list sm:hidden" role="list">
        {requests.map((request) => (
          <li key={`${request.id}:${request.version}`} className="card">
            <div className="mb-sm">
              <EmployeeCell employee={request.employee} />
            </div>
            <div className="card__row">
              <span className="sr-only">Type</span>
              <span className="card__value">{LEAVE_KIND_LABELS[request.kind]}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Dates</span>
              <span className="card__value">{formatRange(request)}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Weekdays</span>
              <span className="card__value">{request.weekdays}</span>
            </div>
            <div className="mt-sm">
              <ApprovalDecisionControl request={request} csrfToken={csrfToken} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function DecidedApprovalsList({ requests }: { requests: readonly ApprovalDTO[] }) {
  return (
    <>
      <table className="data-table hidden w-full sm:table">
        <caption className="sr-only">Recently decided leave requests</caption>
        <thead>
          <tr>
            <th scope="col">Employee</th>
            <th scope="col">Type</th>
            <th scope="col">Dates</th>
            <th scope="col">Weekdays</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr key={request.id}>
              <td>
                <EmployeeCell employee={request.employee} />
              </td>
              <td>{LEAVE_KIND_LABELS[request.kind]}</td>
              <td>{formatRange(request)}</td>
              <td>{request.weekdays}</td>
              <td>
                <StatusBadge status={request.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="card-list sm:hidden" role="list">
        {requests.map((request) => (
          <li key={request.id} className="card">
            <div className="mb-sm flex items-center justify-between gap-sm">
              <EmployeeCell employee={request.employee} />
              <StatusBadge status={request.status} />
            </div>
            <div className="card__row">
              <span className="sr-only">Type</span>
              <span className="card__value">{LEAVE_KIND_LABELS[request.kind]}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Dates</span>
              <span className="card__value">{formatRange(request)}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Weekdays</span>
              <span className="card__value">{request.weekdays}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

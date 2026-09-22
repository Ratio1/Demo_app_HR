import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getPool } from "@/server/db/pool";
import { loadDirectory } from "@/server/services/employees";
import type { DirectoryEntryDTO, HrDirectoryEntryDTO } from "@/server/dto/employees";

import { AppNav } from "../_components/AppNav";
import { Avatar } from "../_components/Avatar";
import { Banner } from "../_components/Banner";
import { EmptyState } from "../_components/EmptyState";
import { EmptyDirectoryIcon } from "../_components/icons";
import { currentPrincipal } from "../_lib/current-principal";

export const metadata: Metadata = {
  title: "Directory — Demo_App_HR",
};

/**
 * S4/Directory, both roles (spec §2). `loadDirectory` (src/server/services/employees.ts)
 * already filters to `active = true` and role-projects the row, so an `employee` never receives
 * an `hr_admin`-only field even in the RSC flight payload — this page renders whichever variant
 * of `DirectoryDTO` it is handed and never widens it. Directory rows are not links: unlike
 * `/employees`, there is no per-row detail route a colleague may open (spec §2: an `employee`
 * reading another employee's record beyond the four directory fields is `403 forbidden`), so
 * `action-chevron-right.svg` is not used here.
 */
export default async function DirectoryPage() {
  const principal = await currentPrincipal();
  if (principal === null) {
    redirect("/login");
  }

  const result = await loadDirectory(getPool(), principal);

  return (
    <>
      <AppNav
        email={principal.email}
        role={principal.role}
        current="directory"
        csrfToken={principal.csrfToken}
      />
      <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
        <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">Directory</h1>

        {result.kind === "unavailable" ? (
          <Banner state="db-unavailable">
            We can&rsquo;t reach the database right now. Try again shortly.
          </Banner>
        ) : result.kind === "forbidden" ? (
          // Unreachable (`loadDirectory` has no role gate); kept for exhaustiveness.
          <Banner state="forbidden">You don&rsquo;t have access to this.</Banner>
        ) : result.data.entries.length === 0 ? (
          <EmptyState illustration={EmptyDirectoryIcon} heading="No colleagues yet">
            Active colleagues will appear here once HR adds them.
          </EmptyState>
        ) : result.data.role === "hr_admin" ? (
          <HrDirectoryList entries={result.data.entries} />
        ) : (
          <EmployeeDirectoryList entries={result.data.entries} />
        )}
      </main>
    </>
  );
}

function EmployeeDirectoryList({ entries }: { entries: readonly DirectoryEntryDTO[] }) {
  return (
    <>
      <table className="data-table hidden w-full sm:table">
        <caption className="sr-only">Directory</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Title</th>
            <th scope="col">Department</th>
            <th scope="col">Work email</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.work_email}>
              <td>
                <div className="flex items-center gap-sm">
                  <Avatar fullName={entry.full_name} />
                  <span>{entry.full_name}</span>
                </div>
              </td>
              <td>{entry.title}</td>
              <td>{entry.department}</td>
              <td>{entry.work_email}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="card-list sm:hidden" role="list">
        {entries.map((entry) => (
          <li key={entry.work_email} className="card">
            <div className="mb-sm flex items-center gap-sm">
              <Avatar fullName={entry.full_name} />
              <span className="text-body font-medium text-text-primary">{entry.full_name}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Title</span>
              <span className="card__value">{entry.title}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Department</span>
              <span className="card__value">{entry.department}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Work email</span>
              <span className="card__value">{entry.work_email}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function HrDirectoryList({ entries }: { entries: readonly HrDirectoryEntryDTO[] }) {
  return (
    <>
      <table className="data-table hidden w-full sm:table">
        <caption className="sr-only">Directory</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Title</th>
            <th scope="col">Department</th>
            <th scope="col">Work email</th>
            <th scope="col">Code</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.code}>
              <td>
                <div className="flex items-center gap-sm">
                  <Avatar fullName={entry.full_name} />
                  <span>{entry.full_name}</span>
                </div>
              </td>
              <td>{entry.title}</td>
              <td>{entry.department}</td>
              <td>{entry.work_email}</td>
              <td>{entry.code}</td>
              <td>
                <span className="employee-status" data-active={entry.active}>
                  {entry.active ? "Active" : "Inactive"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="card-list sm:hidden" role="list">
        {entries.map((entry) => (
          <li key={entry.code} className="card">
            <div className="mb-sm flex items-center gap-sm">
              <Avatar fullName={entry.full_name} />
              <span className="text-body font-medium text-text-primary">{entry.full_name}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Title</span>
              <span className="card__value">{entry.title}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Department</span>
              <span className="card__value">{entry.department}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Work email</span>
              <span className="card__value">{entry.work_email}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Code</span>
              <span className="card__value">{entry.code}</span>
            </div>
            <div className="card__row">
              <span className="sr-only">Status</span>
              <span className="employee-status" data-active={entry.active}>
                {entry.active ? "Active" : "Inactive"}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

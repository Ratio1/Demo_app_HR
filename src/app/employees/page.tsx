import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getPool } from "@/server/db/pool";
import { getEmployeeForHr, listEmployeesForHr } from "@/server/services/employees";
import type { HrEmployeeDTO } from "@/server/dto/employees";

import { AppNav } from "../_components/AppNav";
import { Avatar } from "../_components/Avatar";
import { Banner } from "../_components/Banner";
import { EmployeeForm } from "../_components/EmployeeForm";
import { EmployeeStatusControl } from "../_components/EmployeeStatusControl";
import { EmptyState } from "../_components/EmptyState";
import { ActionAddIcon, ActionChevronRightIcon, EmptyEmployeesIcon } from "../_components/icons";
import { currentPrincipal } from "../_lib/current-principal";

export const metadata: Metadata = {
  title: "Employees — Demo_App_HR",
};

/**
 * S4 (list) / S6-S7 (detail/editor), `hr_admin` only (spec §2). One page, branching on query
 * parameters exactly as the slice-2 brief fixes it: `?new=1` is the create editor, `?id=<uuid>`
 * is the edit editor, no parameter is the list — not the three-route `/employees/{id}/edit` +
 * `/employees/new` shape `flows.md` sketched in Phase 1 (superseded here; the brief is this
 * slice's authority).
 *
 * `employee` requesting this page at all is `403 forbidden`, rendered inline (the brief: "page:
 * the forbidden state") rather than a redirect or a 404 — the role check runs before any
 * database read, so a denied `employee` never causes a query. B's services re-check the same
 * role server-side (`isHr`), so this page's check is belt, not the only suspender.
 *
 * No DB call here can throw: `listEmployeesForHr`/`getEmployeeForHr` (src/server/services/
 * employees.ts) already catch a database failure and return `{ kind: "unavailable" }`, so
 * nothing in this file needs its own try/catch, and `notFound()` below is never at risk of
 * being swallowed by one.
 */
export default async function EmployeesPage({
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
      current="employees"
      csrfToken={principal.csrfToken}
    />
  );

  if (principal.role !== "hr_admin") {
    return (
      <>
        {nav}
        <main id="main-content" className="mx-auto max-w-md px-md py-2xl">
          <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">Employees</h1>
          <Banner state="forbidden">You don&rsquo;t have access to this.</Banner>
        </main>
      </>
    );
  }

  const params = await searchParams;
  const wantsNew = params.new === "1";
  const editId = typeof params.id === "string" ? params.id : undefined;
  const saved = typeof params.saved === "string";
  const pool = getPool();

  if (wantsNew) {
    return (
      <>
        {nav}
        <main id="main-content" className="mx-auto max-w-md px-md py-2xl">
          <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">New employee</h1>
          <EmployeeForm mode="create" csrfToken={principal.csrfToken} />
        </main>
      </>
    );
  }

  if (editId !== undefined) {
    const result = await getEmployeeForHr(pool, principal, editId);

    if (result.kind === "unavailable") {
      return (
        <>
          {nav}
          <main id="main-content" className="mx-auto max-w-md px-md py-2xl">
            <Banner state="db-unavailable">
              We can&rsquo;t reach the database right now. Try again shortly.
            </Banner>
          </main>
        </>
      );
    }
    if (result.kind === "forbidden") {
      return (
        <>
          {nav}
          <main id="main-content" className="mx-auto max-w-md px-md py-2xl">
            <Banner state="forbidden">You don&rsquo;t have access to this.</Banner>
          </main>
        </>
      );
    }
    // No employee with that id: a generic 404, consistent with the app's not-found.tsx and its
    // "byte-identical whether the route genuinely does not exist or the denial is disclosure-
    // motivated" rule. The slice-2 brief does not fix a 403-vs-404 disposition for this cell
    // (only for the employee-role cases above); recorded as a concern in the part C report.
    if (result.data === null) {
      notFound();
    }

    return <EditorView employee={result.data} nav={nav} saved={saved} csrfToken={principal.csrfToken} />;
  }

  const result = await listEmployeesForHr(pool, principal);

  if (result.kind === "unavailable") {
    return (
      <>
        {nav}
        <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
          <Banner state="db-unavailable">
            We can&rsquo;t reach the database right now. Try again shortly.
          </Banner>
        </main>
      </>
    );
  }
  if (result.kind === "forbidden") {
    // Unreachable (role already checked above); kept so the union stays exhaustive.
    return (
      <>
        {nav}
        <main id="main-content" className="mx-auto max-w-md px-md py-2xl">
          <Banner state="forbidden">You don&rsquo;t have access to this.</Banner>
        </main>
      </>
    );
  }

  return <ListView employees={result.data} nav={nav} />;
}

function EditorView({
  employee,
  nav,
  saved,
  csrfToken,
}: {
  employee: HrEmployeeDTO;
  nav: React.ReactNode;
  saved: boolean;
  csrfToken: string;
}) {
  return (
    <>
      {nav}
      <main id="main-content" className="mx-auto max-w-md px-md py-2xl">
        <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">Edit employee</h1>

        {saved ? (
          <div className="mb-lg" role="status">
            <p className="banner__body text-text-primary">Saved.</p>
          </div>
        ) : null}

        <div className="mb-lg flex items-center gap-sm">
          <Avatar fullName={employee.full_name} size={56} />
          <div>
            <p className="text-body font-medium text-text-primary">{employee.full_name}</p>
            <span className="employee-status" data-active={employee.active}>
              {employee.active ? "Active" : "Inactive"}
            </span>
          </div>
        </div>

        {/* Keyed on id+version: a successful edit or status change bumps `version` server-side
            and the client navigates back to this same route, which React would otherwise
            reconcile in place (same position, same component type) rather than remount — the
            key forces a fresh instance so local submit/form state can never survive past the
            server-confirmed record it was submitted against. */}
        <EmployeeForm
          key={`form:${employee.id}:${employee.version}`}
          mode="edit"
          employee={employee}
          csrfToken={csrfToken}
        />
        <EmployeeStatusControl
          key={`status:${employee.id}:${employee.version}`}
          employee={employee}
          csrfToken={csrfToken}
        />
      </main>
    </>
  );
}

function ListView({ employees, nav }: { employees: readonly HrEmployeeDTO[]; nav: React.ReactNode }) {
  return (
    <>
      {nav}
      <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
        <div className="mb-lg flex flex-wrap items-center justify-between gap-sm">
          <h1 className="text-heading-lg font-semibold text-text-primary">Employees</h1>
          <Link href="/employees?new=1" className="btn btn--primary">
            <ActionAddIcon />
            <span>New employee</span>
          </Link>
        </div>

        {employees.length === 0 ? (
          <EmptyState
            illustration={EmptyEmployeesIcon}
            heading="No employees yet"
            action={
              <Link href="/employees?new=1" className="btn btn--primary">
                <ActionAddIcon />
                <span>Add employee</span>
              </Link>
            }
          >
            Add your first employee to get started.
          </EmptyState>
        ) : (
          <>
            <table className="data-table hidden w-full sm:table">
              <caption className="sr-only">Employees</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Title</th>
                  <th scope="col">Department</th>
                  <th scope="col">Work email</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {employees.map((employee) => (
                  <tr key={employee.id} className="row--link">
                    <td>
                      <Link
                        href={`/employees?id=${employee.id}`}
                        className="row-link flex items-center gap-sm"
                      >
                        <Avatar fullName={employee.full_name} />
                        <span>{employee.full_name}</span>
                      </Link>
                    </td>
                    <td>{employee.title}</td>
                    <td>{employee.department}</td>
                    <td>{employee.work_email}</td>
                    <td>
                      <span className="employee-status" data-active={employee.active}>
                        {employee.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>
                      <Link
                        href={`/employees?id=${employee.id}`}
                        aria-label={`Open ${employee.full_name}`}
                      >
                        <ActionChevronRightIcon />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="card-list sm:hidden" role="list">
              {employees.map((employee) => (
                <li key={employee.id} className="card card--link">
                  <Link href={`/employees?id=${employee.id}`} className="row-link">
                    <div className="mb-sm flex items-center gap-sm">
                      <Avatar fullName={employee.full_name} />
                      <span className="text-body font-medium text-text-primary">
                        {employee.full_name}
                      </span>
                      <ActionChevronRightIcon className="ml-auto" />
                    </div>
                    <div className="card__row">
                      <span className="sr-only">Title</span>
                      <span className="card__value">{employee.title}</span>
                    </div>
                    <div className="card__row">
                      <span className="sr-only">Department</span>
                      <span className="card__value">{employee.department}</span>
                    </div>
                    <div className="card__row">
                      <span className="sr-only">Work email</span>
                      <span className="card__value">{employee.work_email}</span>
                    </div>
                    <div className="card__row">
                      <span className="sr-only">Status</span>
                      <span className="employee-status" data-active={employee.active}>
                        {employee.active ? "Active" : "Inactive"}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </>
  );
}

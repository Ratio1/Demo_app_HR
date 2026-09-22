import Link from "next/link";

import {
  ActionLogoutIcon,
  NavDirectoryIcon,
  NavEmployeesIcon,
  NavOverviewIcon,
  NavProfileIcon,
} from "./icons";

/**
 * The authenticated nav shell (tokens.md §5.13), rendered by the pages that hold a session
 * (`/`, `/me`, `/directory`, `/employees`) rather than by the root layout — see layout.tsx's
 * header comment and the slice 1 part C report for why.
 *
 * Slice 2 adds Directory (both roles) and Employees (`hr_admin` only) to slice 1's Overview/My
 * account pair. `nav-leave.svg`/`nav-approvals.svg` and the <1024px collapse-behind-a-toggle
 * behaviour still arrive with the routes they point to (slices 3–4) — documented as a
 * deviation, not silently dropped: at 390×844 this nav still wraps onto a second line rather
 * than collapsing behind `action-menu.svg`, same call slice 1 made, now carried one slice
 * further because /leave and /approvals (the screens that would make the row genuinely
 * crowded) are still absent.
 */
export function AppNav({
  email,
  role,
  current,
  csrfToken,
}: {
  email: string;
  role: "hr_admin" | "employee";
  current: "overview" | "me" | "directory" | "employees";
  csrfToken: string;
}) {
  return (
    <div className="border-b border-divider bg-surface-raised">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-sm px-md py-sm">
        <nav aria-label="Primary">
          <ul className="app-nav__list" role="list">
            <li>
              <Link
                href="/"
                className="app-nav__link"
                aria-current={current === "overview" ? "page" : undefined}
              >
                <NavOverviewIcon />
                <span>Overview</span>
              </Link>
            </li>
            <li>
              <Link
                href="/directory"
                className="app-nav__link"
                aria-current={current === "directory" ? "page" : undefined}
              >
                <NavDirectoryIcon />
                <span>Directory</span>
              </Link>
            </li>
            {role === "hr_admin" ? (
              <li>
                <Link
                  href="/employees"
                  className="app-nav__link"
                  aria-current={current === "employees" ? "page" : undefined}
                >
                  <NavEmployeesIcon />
                  <span>Employees</span>
                </Link>
              </li>
            ) : null}
            <li>
              <Link
                href="/me"
                className="app-nav__link"
                aria-current={current === "me" ? "page" : undefined}
              >
                <NavProfileIcon />
                <span>My account</span>
              </Link>
            </li>
          </ul>
        </nav>
        <div className="flex items-center gap-md">
          <span className="text-caption text-text-secondary">
            {email} · {role === "hr_admin" ? "HR admin" : "Employee"}
          </span>
          <form method="post" action="/api/logout">
            <input type="hidden" name="csrf" value={csrfToken} />
            <button type="submit" className="btn btn--quiet">
              <ActionLogoutIcon />
              <span>Log out</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

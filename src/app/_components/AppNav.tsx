import Link from "next/link";

import { ActionLogoutIcon, NavOverviewIcon, NavProfileIcon } from "./icons";

/**
 * The authenticated nav shell (tokens.md §5.13), rendered by the pages that hold a session
 * (`/` and `/me`) rather than by the root layout — see layout.tsx's header comment and the
 * slice 1 part C report for why. Slice 1 ships exactly two destinations (Overview, My
 * account); the full role-specific set (`nav-directory.svg`, `nav-employees.svg`,
 * `nav-leave.svg`, `nav-approvals.svg`) and the <1024px collapse-behind-a-toggle behaviour
 * arrive with the routes they point to (slices 2–4) — documented as a deviation, not silently
 * dropped.
 */
export function AppNav({
  email,
  role,
  current,
  csrfToken,
}: {
  email: string;
  role: "hr_admin" | "employee";
  current: "overview" | "me";
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

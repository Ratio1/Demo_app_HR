import {
  ActionLogoutIcon,
  NavApprovalsIcon,
  NavDirectoryIcon,
  NavEmployeesIcon,
  NavLeaveIcon,
  NavOverviewIcon,
  NavProfileIcon,
} from "./icons";
import { NavMenuList, type NavItem } from "./NavMenuList";

/**
 * The authenticated nav shell (tokens.md §5.13), rendered by the pages that hold a session
 * (`/`, `/me`, `/directory`, `/employees`, `/leave`, `/approvals`) rather than by the root
 * layout — see layout.tsx's header comment and the slice 1 part C report for why.
 *
 * Slice 3 adds My leave (both roles → `/leave`) and Approvals (`hr_admin` only → `/approvals`)
 * to slice 2's Overview/Directory/Employees/My account set, and — per tokens.md §5.13 — this is
 * also where the <1024px collapse-behind-a-toggle behaviour lands: slices 1 and 2 both deferred
 * it "until /leave and /approvals exist to populate it", and that condition is now met (six
 * entries for `hr_admin`, four for `employee`, too many to keep wrapping onto a second line at
 * 390×844 without the row eating most of the viewport). The collapsible list itself is
 * `NavMenuList` (a client component — it needs `useState` for `aria-expanded`/open state);
 * everything else here stays a server component exactly as before.
 */
export function AppNav({
  email,
  role,
  current,
  csrfToken,
}: {
  email: string;
  role: "hr_admin" | "employee";
  current: "overview" | "me" | "directory" | "employees" | "leave" | "approvals";
  csrfToken: string;
}) {
  const items: NavItem[] = [
    { href: "/", label: "Overview", icon: NavOverviewIcon, current: current === "overview" },
    {
      href: "/directory",
      label: "Directory",
      icon: NavDirectoryIcon,
      current: current === "directory",
    },
  ];
  if (role === "hr_admin") {
    items.push({
      href: "/employees",
      label: "Employees",
      icon: NavEmployeesIcon,
      current: current === "employees",
    });
  }
  items.push({ href: "/leave", label: "My leave", icon: NavLeaveIcon, current: current === "leave" });
  if (role === "hr_admin") {
    items.push({
      href: "/approvals",
      label: "Approvals",
      icon: NavApprovalsIcon,
      current: current === "approvals",
    });
  }
  items.push({ href: "/me", label: "My account", icon: NavProfileIcon, current: current === "me" });

  return (
    <div className="border-b border-divider bg-surface-raised">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-sm px-md py-sm">
        <NavMenuList items={items} />
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

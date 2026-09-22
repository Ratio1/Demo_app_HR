import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { currentPrincipal } from "../_lib/current-principal";

/**
 * Anonymous → a real `307 → /login` on a route that streams — identical reasoning to
 * `src/app/employees/layout.tsx`'s own doc comment.
 *
 * This layout carries no role check: an `employee` hitting `/approvals` still needs a page-level
 * `403 forbidden`, rendered inline exactly as `/employees` does for the same reason (the role
 * check runs before any database read, so a denied `employee` never causes a query), not a
 * redirect. The leave service re-checks the role a second time behind every read/write.
 */
export default async function ApprovalsLayout({ children }: { children: ReactNode }) {
  const principal = await currentPrincipal();
  if (principal === null) {
    redirect("/login");
  }
  return children;
}

import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { currentPrincipal } from "../_lib/current-principal";

/**
 * Anonymous → a real `307 → /login`, on a route that streams (slice-2 review, important #2).
 *
 * `loading.tsx` in this segment puts the page inside a Suspense boundary, so Next flushes the
 * shell — status `200`, headers already sent — before the page's own `redirect()` runs; the
 * redirect then arrives *inside* the flight payload as `NEXT_REDIRECT` plus a `<meta
 * http-equiv="refresh">`. A browser still ends at `/login`, but every non-browser client (a
 * monitor, a test, `curl`) sees `200`. A layout renders *outside* its segment's Suspense
 * boundary (`<Layout><Suspense fallback={<Loading/>}><Page/></Suspense></Layout>`), so awaiting
 * here blocks the response and the redirect is a genuine status again.
 *
 * This is **not** the authorization boundary (spec §3) and carries no role check: it only turns
 * "no live session" into a redirect. `page.tsx` still resolves the principal itself and still
 * refuses a non-`hr_admin`, and `src/server/services/employees.ts` re-checks the role a third
 * time behind every read and write. `currentPrincipal` is `React.cache`-memoized, so the layout
 * and the page share one session lookup per request rather than making two.
 */
export default async function EmployeesLayout({ children }: { children: ReactNode }) {
  const principal = await currentPrincipal();
  if (principal === null) {
    redirect("/login");
  }
  return children;
}

import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { currentPrincipal } from "../_lib/current-principal";

/**
 * Anonymous → a real `307 → /login`, on a route that streams — identical reasoning and
 * mechanism to `src/app/employees/layout.tsx`'s own doc comment (this segment has a
 * `loading.tsx`, so without a layout-level check the redirect would arrive inside the flight
 * payload instead of as a genuine status).
 *
 * Both roles reach `/leave` (spec §2: "Linked users submit ... see own history, cancel own
 * pending requests"), so this layout carries no role check — only "no live session" is turned
 * into a redirect here. `page.tsx` still resolves the principal itself and renders the
 * "unlinked" forbidden state inline for an unlinked `hr_admin` (tokens.md §7 S8), and the leave
 * service re-checks the link server-side a second time behind every read and write.
 */
export default async function LeaveLayout({ children }: { children: ReactNode }) {
  const principal = await currentPrincipal();
  if (principal === null) {
    redirect("/login");
  }
  return children;
}

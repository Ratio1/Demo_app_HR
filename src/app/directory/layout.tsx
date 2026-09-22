import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { currentPrincipal } from "../_lib/current-principal";

/**
 * Anonymous → a real `307 → /login`. Identical in purpose and in reasoning to
 * `src/app/employees/layout.tsx`; see that file for why a `loading.tsx` makes this necessary
 * and why the layout is not the authorization boundary. `/directory` is open to both roles, so
 * the page below adds no role gate of its own — `loadDirectory` projects each row by role.
 */
export default async function DirectoryLayout({ children }: { children: ReactNode }) {
  const principal = await currentPrincipal();
  if (principal === null) {
    redirect("/login");
  }
  return children;
}

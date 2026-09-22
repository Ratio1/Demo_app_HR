import type { Metadata } from "next";
import { connection } from "next/server";

import { Banner } from "./_components/Banner";

export const metadata: Metadata = {
  title: "Not found — Demo_App_HR",
};

/**
 * The app's own 404 (flows.md §7 / ruling R-H): deliberately generic copy, byte-identical
 * whether the route genuinely does not exist or the denial is disclosure-motivated (access-
 * matrix R6/R7 — "another employee's record", "a foreign employee code"). Never says "you
 * don't have access". No dynamic API is otherwise used on this route, so `connection()` opts
 * it out of static generation per spec §3 ("private routes dynamic/uncached" — this route
 * itself is not private, but its content is reused for genuinely private 404s by later
 * slices, so it is never prerendered/cached).
 */
export default async function NotFound() {
  await connection();

  return (
    <main id="main-content" className="mx-auto max-w-md px-md py-2xl">
      {/* Native `autofocus` (flows.md §9 focus-return: "a 403 or 404 page renders → the page <h1>"); no client script involved. */}
      <h1
        tabIndex={-1}
        autoFocus
        className="mb-lg text-heading-lg font-semibold text-text-primary"
      >
        Page not found
      </h1>
      <Banner state="forbidden" autoFocusOnLoad={false}>
        That page could not be found.
      </Banner>
    </main>
  );
}

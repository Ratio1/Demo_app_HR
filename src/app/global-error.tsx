"use client";

import "./globals.css";

/**
 * Replaces the ROOT layout per Next.js semantics (the layout that would host this may itself
 * be what failed), so it renders its own `<html>`/`<body>` and imports the stylesheet itself —
 * otherwise it would render unstyled, which ruling R-H treats as a defect, not a cosmetic
 * miss. No navigation (flows.md §7: "renders no navigation, since the layout that would host
 * it may itself be the thing that failed"). No `error.message`/`digest` is read or rendered.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-surface-page text-text-primary font-sans antialiased">
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <main id="main-content" className="mx-auto page-column px-md py-2xl">
          <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">
            Something went wrong
          </h1>
          <div
            className="banner"
            data-state="db-unavailable"
            role="alert"
            tabIndex={-1}
            autoFocus
          >
            <p className="banner__body">
              Demo_App_HR is temporarily unavailable. Try again in a few minutes.
            </p>
          </div>
          <button type="button" className="btn btn--secondary mt-lg" onClick={() => reset()}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}

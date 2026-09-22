"use client";

import { Banner } from "./_components/Banner";

/**
 * Route-segment error boundary (App Router requires this to be a Client Component). Renders
 * the sanitized `db-unavailable`-shaped generic failure (flows.md §7): no host, role, schema,
 * version, build id, error text or stack ever reaches the DOM. `error.message`/`error.digest`
 * are intentionally never read or rendered — this app has no telemetry dependency (spec §5/
 * §6 forbid one), and S6 forbids traces/secrets in logs, so nothing here forwards them
 * anywhere either.
 */
export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main-content" className="mx-auto max-w-md px-md py-2xl">
      <h1 className="mb-lg text-heading-lg font-semibold text-text-primary">
        Something went wrong
      </h1>
      <Banner state="db-unavailable">
        Demo_App_HR is temporarily unavailable. Try again in a few minutes.
      </Banner>
      <button type="button" className="btn btn--secondary mt-lg" onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}

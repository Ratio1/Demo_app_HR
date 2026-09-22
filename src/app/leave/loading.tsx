import { Banner } from "../_components/Banner";

/**
 * Streaming fallback while `/leave`'s Server Component resolves its data — same pattern and
 * same simplification as `src/app/directory/loading.tsx`'s own doc comment (a minimal Banner,
 * not skeleton table/card rows: this route has no client script to swap a skeleton for real
 * markup once resolved; Next's Suspense boundary replaces this file wholesale).
 */
export default function Loading() {
  return (
    <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
      <Banner state="loading" autoFocusOnLoad={false}>
        Loading your leave requests…
      </Banner>
    </main>
  );
}

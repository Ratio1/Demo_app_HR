import { Banner } from "../_components/Banner";

/**
 * Streaming fallback while `/directory`'s Server Component resolves its data (tokens.md §5.5:
 * "loading" — `aria-busy` on the busy region). A minimal `Banner`, not full skeleton table
 * rows: this route has no client script to swap a skeleton for real markup, so Next's Suspense
 * boundary replaces this file wholesale with the resolved page — recorded as a simplification
 * in the slice 2 part C report rather than a pixel-accurate skeleton tokens.md's wording
 * suggests.
 */
export default function Loading() {
  return (
    <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
      <Banner state="loading" autoFocusOnLoad={false}>
        Loading the directory…
      </Banner>
    </main>
  );
}

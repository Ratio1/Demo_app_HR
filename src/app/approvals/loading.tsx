import { Banner } from "../_components/Banner";

/**
 * Streaming fallback while `/approvals`'s Server Component resolves its data — same pattern as
 * `src/app/directory/loading.tsx`.
 */
export default function Loading() {
  return (
    <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
      <Banner state="loading" autoFocusOnLoad={false}>
        Loading the approvals queue…
      </Banner>
    </main>
  );
}

import { Banner } from "../_components/Banner";

/** See `src/app/directory/loading.tsx` for why this is a banner, not skeleton table rows. */
export default function Loading() {
  return (
    <main id="main-content" className="mx-auto max-w-5xl px-md py-2xl">
      <Banner state="loading" autoFocusOnLoad={false}>
        Loading employees…
      </Banner>
    </main>
  );
}

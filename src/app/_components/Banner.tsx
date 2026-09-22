"use client";

import { useEffect, useRef, type ReactNode } from "react";

import {
  StateDbUnavailableIcon,
  StateForbiddenIcon,
  StateInvalidIcon,
  StateLoadingIcon,
  StateStaleIcon,
} from "./icons";

// Slice 2 adds `stale` (tokens.md §5.8: the S6/S7 "record changed" conflict banner). `empty`
// and `no-results` are rendered by the dedicated EmptyState block component (tokens.md §5.11),
// not by Banner, so they are not added here.
export type BannerState = "loading" | "invalid" | "forbidden" | "db-unavailable" | "stale";

const ICONS: Record<BannerState, typeof StateLoadingIcon> = {
  loading: StateLoadingIcon,
  invalid: StateInvalidIcon,
  forbidden: StateForbiddenIcon,
  "db-unavailable": StateDbUnavailableIcon,
  stale: StateStaleIcon,
};

// tokens.md §5.8 / flows.md §9: `load`/`empty`/`nores` are polite (`status`); `valid`/`forb`/
// `stale`/`dbdown` interrupt an intent and are assertive (`alert`).
const ROLE: Record<BannerState, "status" | "alert"> = {
  loading: "status",
  invalid: "alert",
  forbidden: "alert",
  "db-unavailable": "alert",
  stale: "alert",
};

/**
 * The one banner/alert component (tokens.md §5.8). Slice 1 produced `loading`/`invalid`/
 * `forbidden`/`db-unavailable`; slice 2 adds `stale` for the employee editor's `409
 * conflict_stale` banner ("This record changed — reload to see the current values", slice-2
 * brief). The native `autoFocus` attribute below still carries the page-load case (a
 * server-rendered banner present at first paint, before anything else can hold focus) without
 * any client script. It does **not** fire for a banner a client component mounts later — by
 * then the submit button or a field already holds focus, and a browser only auto-focuses a
 * freshly-inserted `autofocus` element when nothing else is focused yet. The effect below
 * re-asserts the same "move focus to the freshly mounted alert" contract for that case (slice-4
 * "App defects found" #6): every caller sets an intermediate "submitting" state before showing a
 * new banner, so the conditional block that renders one always unmounts and remounts between two
 * failures — a real mount each time, never a prop update on a `Banner` already in the tree.
 */
export function Banner({
  state,
  heading,
  children,
  id,
  autoFocusOnLoad = true,
}: {
  state: BannerState;
  heading?: string;
  children: ReactNode;
  id?: string;
  autoFocusOnLoad?: boolean;
}) {
  const Icon = ICONS[state];
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocusOnLoad) {
      ref.current?.focus();
    }
  }, [autoFocusOnLoad]);

  return (
    <div
      ref={ref}
      className="banner"
      data-state={state}
      role={ROLE[state]}
      id={id}
      tabIndex={-1}
      autoFocus={autoFocusOnLoad}
      aria-busy={state === "loading" ? true : undefined}
    >
      <Icon className="banner__icon" />
      <div>
        {heading ? <p className="font-medium">{heading}</p> : null}
        <p className="banner__body">{children}</p>
      </div>
    </div>
  );
}

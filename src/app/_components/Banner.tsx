import type { ReactNode } from "react";

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
 * brief). `autoFocus` uses the native HTML attribute, so the summary alert receives focus on
 * page load — matching flows.md's focus-return table — without any client script.
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
  return (
    <div
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

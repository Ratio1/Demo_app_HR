import type { ReactNode } from "react";

import {
  StateDbUnavailableIcon,
  StateForbiddenIcon,
  StateInvalidIcon,
  StateLoadingIcon,
} from "./icons";

export type BannerState = "loading" | "invalid" | "forbidden" | "db-unavailable";

const ICONS: Record<BannerState, typeof StateLoadingIcon> = {
  loading: StateLoadingIcon,
  invalid: StateInvalidIcon,
  forbidden: StateForbiddenIcon,
  "db-unavailable": StateDbUnavailableIcon,
};

// tokens.md §5.8 / flows.md §9: `load`/`empty`/`nores` are polite (`status`); `valid`/`forb`/
// `stale`/`dbdown` interrupt an intent and are assertive (`alert`).
const ROLE: Record<BannerState, "status" | "alert"> = {
  loading: "status",
  invalid: "alert",
  forbidden: "alert",
  "db-unavailable": "alert",
};

/**
 * The one banner/alert component (tokens.md §5.8), scoped to the four states slice 1 can
 * actually produce (`load` for a pending navigation is the browser's own indicator here, since
 * these forms are plain, script-free HTML — see the slice 1 part C report). `autoFocus` uses
 * the native HTML attribute, so the summary alert receives focus on page load — matching
 * flows.md's focus-return table — without any client script.
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

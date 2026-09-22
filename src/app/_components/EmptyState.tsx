import type { ComponentType, ReactNode, SVGProps } from "react";

/**
 * tokens.md §5.11 — the empty-state block. Illustration + heading + one line of body copy +
 * exactly one action. `role="status"` for both `empty` and `no-results` (§4's table: these two
 * are polite, unlike `invalid`/`forbidden`/`stale`/`db-unavailable`). Non-interactive itself
 * (illustration/heading/body have no hover/active/disabled state); the single action carries
 * its own component's states (a `<Button>`-styled element or the plain `empty-state__link`).
 */
export function EmptyState({
  illustration: Illustration,
  heading,
  children,
  action,
  variant = "empty",
}: {
  illustration: ComponentType<SVGProps<SVGSVGElement>>;
  heading: string;
  // Optional in the type only so `React.createElement(EmptyState, props, "body text")` (used by
  // this component's unit test) can type-check with children passed positionally, matching how
  // JSX always calls this component in practice — every real usage supplies body copy.
  children?: ReactNode;
  action?: ReactNode;
  variant?: "empty" | "no-results";
}) {
  return (
    <div className="empty-state" data-state={variant} role="status">
      <Illustration className="empty-state__illustration" aria-hidden="true" />
      <h2 className="empty-state__heading">{heading}</h2>
      <p className="empty-state__body">{children}</p>
      {action ?? null}
    </div>
  );
}

import { initials } from "../_lib/initials";
import { AvatarFrameIcon } from "./icons";

/**
 * tokens.md §5.10 — initials avatar. Non-interactive (`role="img"`, never a link/button), so it
 * carries no hover/active/focus-visible/disabled state. 32px in row/card context (directory,
 * employees list); 56px in a detail header (§5.5/§5.6 vs. the /me profile section).
 */
export function Avatar({ fullName, size = 32 }: { fullName: string; size?: 32 | 56 }) {
  return (
    <span className="avatar" data-size={size} role="img" aria-label={fullName}>
      <AvatarFrameIcon className="avatar__frame" aria-hidden="true" />
      <span className="avatar__initials" aria-hidden="true">
        {initials(fullName)}
      </span>
    </span>
  );
}

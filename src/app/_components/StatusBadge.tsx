import { LEAVE_STATUS_LABELS, type LeaveStatus } from "../../server/dto/leave.ts";

import {
  StatusApprovedIcon,
  StatusCancelledIcon,
  StatusPendingIcon,
  StatusRejectedIcon,
} from "./icons";

export type { LeaveStatus };

/**
 * tokens.md §5.7 — the leave-request status badge. Icon + text label, never colour alone
 * (R7-09 / §4's non-colour-status rule); the badge only ever reflects the server-confirmed
 * `status` field of a leave request DTO, never an optimistic client guess.
 *
 * The label comes from `LEAVE_STATUS_LABELS` in `src/server/dto/leave.ts` — that module's own
 * doc comment: "one place, so the queue and the history cannot disagree" — rather than a second
 * local copy of the same four strings.
 */
const ICONS: Record<LeaveStatus, typeof StatusPendingIcon> = {
  pending: StatusPendingIcon,
  approved: StatusApprovedIcon,
  rejected: StatusRejectedIcon,
  cancelled: StatusCancelledIcon,
};

export function StatusBadge({ status }: { status: LeaveStatus }) {
  const Icon = ICONS[status];
  return (
    <span className="badge" data-status={status}>
      <Icon aria-hidden="true" />
      <span>{LEAVE_STATUS_LABELS[status]}</span>
    </span>
  );
}

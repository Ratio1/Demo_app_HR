import {
  StatusApprovedIcon,
  StatusCancelledIcon,
  StatusPendingIcon,
  StatusRejectedIcon,
} from "./icons";

/**
 * tokens.md §5.7 — the leave-request status badge. Icon + text label, never colour alone
 * (R7-09 / §4's non-colour-status rule); the badge only ever reflects the server-confirmed
 * `status` field of a leave request DTO, never an optimistic client guess.
 *
 * The union is declared locally rather than imported from `src/server/dto/leave.ts`: this
 * component renders in both the HR (`ApprovalDTO`) and employee (`OwnLeaveDTO`) leave lists,
 * and a plain string union keeps it usable from either without importing server-authored types
 * just for the four literal values (both DTOs re-export the same status type once B's module
 * lands, at which point a page passing `request.status` here structurally satisfies this prop
 * with no cast).
 */
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

const ICONS: Record<LeaveStatus, typeof StatusPendingIcon> = {
  pending: StatusPendingIcon,
  approved: StatusApprovedIcon,
  rejected: StatusRejectedIcon,
  cancelled: StatusCancelledIcon,
};

const LABELS: Record<LeaveStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: LeaveStatus }) {
  const Icon = ICONS[status];
  return (
    <span className="badge" data-status={status}>
      <Icon aria-hidden="true" />
      <span>{LABELS[status]}</span>
    </span>
  );
}

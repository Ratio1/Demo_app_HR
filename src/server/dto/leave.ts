/**
 * The leave contract: projections, request schemas and every answer the three leave Route
 * Handlers can give (spec §2 Leave, §3 "field-allowlisted DTOs", §6 S4).
 *
 * This module is the **single source of truth** for the slice-3 leave surface, exactly as
 * `dto/employees.ts` is for the employee surface. Pages import its types, the services return its
 * DTOs, the routes map its result unions onto statuses. Nothing else may hand a `leave_requests`
 * row to a caller: projection happens here, before serialization, so a field that is not in a DTO
 * is absent from the JSON body *and* from the RSC flight payload rather than merely unrendered.
 *
 * It imports nothing but `zod`, `src/shared/dates.ts` and `./common.ts`, so a client component may
 * import it — `/leave` needs the schemas' field names and `validateLeaveRange` for the live
 * weekday count — without dragging `pg` or `@node-rs/argon2` into a browser bundle.
 *
 * ---------------------------------------------------------------------------------------
 * ## HTTP contract (part B owns it; part C builds against it)
 *
 * Three Node-runtime Route Handlers, all `POST`, all behind slice 1's mutation guard (≤64 KiB
 * body read with the cap on the stream, media type, exact `Origin` equality, then the session's
 * synchronizer CSRF token). Body is `application/json` **or** `application/x-www-form-urlencoded`;
 * both are flattened to one `Record<string, string>` and validated by the same `z.strictObject`.
 *
 * | Route | Body (plus `csrf`) | Who |
 * |---|---|---|
 * | `POST /api/leave`                    | `kind, start_date, end_date`        | any **linked** live session |
 * | `POST /api/leave/<id>/cancel`        | `version`                            | the **owner** of that request |
 * | `POST /api/leave/<id>/decision`      | `action` (`approve`\|`reject`), `version` | `hr_admin`, **not** on their own request |
 *
 * **Answers.** Every response is JSON with `Cache-Control: no-store` and the S5 header set:
 *
 * | Status | Body | When |
 * |---|---|---|
 * | `200` | `{ ok: true, location, request }` | success; `location` is built by the server |
 * | `400` | `{ error: 'invalid_input', fields: { <field>: <message> } }` | a value the user can correct |
 * | `400` | `{ error: 'invalid_input' }` (no `fields`) | over-post / unknown or duplicated key |
 * | `401` | `{ error: 'unauthenticated' }` | no live session |
 * | `403` | `{ error: 'forbidden' }` | bad `Origin`, CSRF mismatch, not linked, not `hr_admin`, or self-approval |
 * | `404` | `{ error: 'not_found' }` | no such request **or** it is not the caller's to cancel |
 * | `409` | `{ error: 'conflict_overlap' }` | an overlapping `pending`/`approved` request exists |
 * | `409` | `{ error: 'conflict_not_pending', current }` | the request is already decided or cancelled |
 * | `409` | `{ error: 'conflict_stale', current }` | `version` moved under the caller |
 * | `413` `415` `429` `503` | `{ error: <code> }` | oversize body, wrong media type, hashing queue full, database down |
 *
 * ## Authorization, in one sentence per role
 *
 * - **Submitting** needs a *linked* account — `employee` or `hr_admin` with an `employees` row
 *   (spec §2). An unlinked `hr_admin` gets `403` and the page shows "no employee record linked".
 * - **Cancelling** is the owner's, and only while the request is `pending`. Anyone else — another
 *   employee *or* an `hr_admin` — gets `404`, never `403`: whether a stranger's request exists is
 *   not the caller's to learn (access matrix §1's disclosure rule).
 * - **Deciding** is `hr_admin` only, and never on their own linked record: spec §2, "An HR
 *   admin's request needs a different HR admin; never bypass self-approval." The service checks
 *   the bar itself, before the pending/version checks, and audits the refusal.
 *
 * There is **no free-text field anywhere in this contract** and no category besides `annual` and
 * `personal` (spec §2: "No medical category/free-text reason"). `employee_id`, `status`,
 * `decided_by`, `decided_at` and `weekdays` are not writable: they are unknown keys and a
 * detail-free `400`. The owner of a new request is taken from the session, never from the body.
 */
import { z } from "zod";

import {
  LEAVE_RANGE_MESSAGES,
  isIsoDateString,
  validateLeaveRange,
} from "../../shared/dates.ts";
import { CSRF_FIELD_NAME, csrfField, versionField } from "./common.ts";

export { CSRF_FIELD_NAME };
export type { FieldErrors, ReadResult } from "./common.ts";

/* ------------------------------------------------------------------ the closed vocabularies */

/** Spec §2: `annual` or `personal`, and nothing else. Mirrors `leave_requests_kind_allowed`. */
export const LEAVE_KINDS = ["annual", "personal"] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

/** Mirrors `leave_requests_status_allowed` in `migrations/0001_init.sql`. */
export const LEAVE_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** The two decisions an `hr_admin` may take on a pending request. */
export const LEAVE_DECISIONS = ["approve", "reject"] as const;
export type LeaveDecision = (typeof LEAVE_DECISIONS)[number];

/** The English label for a status; one place, so the queue and the history cannot disagree. */
export const LEAVE_STATUS_LABELS: Readonly<Record<LeaveStatus, string>> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const LEAVE_KIND_LABELS: Readonly<Record<LeaveKind, string>> = {
  annual: "Annual leave",
  personal: "Personal leave",
};

/** ≤100-row pages (S4). The own-history and the pending queue are both capped here. */
export const LEAVE_PAGE_LIMIT = 100;
/** The decided section of `/approvals` shows the last 20 (slice brief). */
export const DECIDED_HISTORY_LIMIT = 20;
/** How many of an employee's own requests the `/` overview carries. */
export const OVERVIEW_OWN_LEAVE_LIMIT = 5;

/* -------------------------------------------------------------------------------- the DTOs */

/**
 * What the owner of a request may see of it. **`decided_by` is deliberately absent**: the owner
 * learns *that* a decision was taken and when, never which administrator took it (slice brief:
 * "never `decided_by`'s identity beyond 'decided'").
 */
export interface OwnLeaveDTO {
  readonly id: string;
  readonly kind: LeaveKind;
  /** ISO `YYYY-MM-DD`; never a `Date`. */
  readonly start_date: string;
  readonly end_date: string;
  /** The server-derived illustrative Monday–Friday count (spec §2), not a legal entitlement. */
  readonly weekdays: number;
  readonly status: LeaveStatus;
  /** ISO 8601 instant, or `null` while the request is `pending` or was cancelled by its owner. */
  readonly decided_at: string | null;
  readonly version: number;
}

/** The three employee fields an approver needs to recognise a request. No work email, no code-free guessing. */
export interface ApprovalEmployeeDTO {
  readonly code: string;
  readonly full_name: string;
  readonly department: string;
}

/**
 * What an `hr_admin` sees in the approval queue. `own` is `true` when the request belongs to the
 * viewing administrator's own linked employee record, so the UI disables its decision buttons —
 * the server refuses the decision anyway (`403`), the flag only keeps the page honest.
 */
export interface ApprovalDTO {
  readonly id: string;
  readonly employee: ApprovalEmployeeDTO;
  readonly kind: LeaveKind;
  readonly start_date: string;
  readonly end_date: string;
  readonly weekdays: number;
  readonly status: LeaveStatus;
  /** ISO 8601 instant. */
  readonly created_at: string;
  readonly version: number;
  readonly own: boolean;
}

/**
 * `/leave`. An account with no `employees` row cannot own leave at all, so the page's "no employee
 * record linked" state is a shape of the data, not an error the page has to infer.
 */
export type OwnLeaveListDTO =
  | { readonly linked: false }
  | { readonly linked: true; readonly requests: readonly OwnLeaveDTO[] };

/** `/approvals`: the pending queue and the last decisions, both already projected. */
export interface ApprovalsDTO {
  readonly pending: readonly ApprovalDTO[];
  readonly decided: readonly ApprovalDTO[];
}

/* ------------------------------------------------------------------------- the projections */

/**
 * The row shape the repository returns. `decided_at` and `created_at` are `timestamptz`, which the
 * driver hands back as a `Date`; they become ISO strings **here**, in the one projection, so no
 * page ever receives a `Date`. `start_date` and `end_date` are `date` columns, which the pool's
 * DATE parser keeps as the raw `YYYY-MM-DD` string (`src/server/db/pool.ts`).
 */
export interface LeaveRequestRecord {
  readonly id: string;
  readonly employee_id: string;
  readonly kind: LeaveKind;
  readonly start_date: string;
  readonly end_date: string;
  readonly status: LeaveStatus;
  readonly decided_at: Date | null;
  readonly created_at: Date;
  readonly version: number;
}

/** The same row joined to its employee, for the HR queue. `decided_by` is not selected at all. */
export interface ApprovalRecord extends LeaveRequestRecord {
  readonly employee_code: string;
  readonly employee_full_name: string;
  readonly employee_department: string;
}

function toIsoInstant(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toOwnLeave(record: LeaveRequestRecord): OwnLeaveDTO {
  return {
    id: record.id,
    kind: record.kind,
    start_date: record.start_date,
    end_date: record.end_date,
    weekdays: countLeaveWeekdays(record.start_date, record.end_date),
    status: record.status,
    decided_at: toIsoInstant(record.decided_at),
    version: record.version,
  };
}

/**
 * `viewerEmployeeId` is the *viewing administrator's* own linked employee id, or `null` when they
 * have no employee record. It is the only input to `own`, so the flag cannot be set by anything
 * the caller sends.
 */
export function toApproval(record: ApprovalRecord, viewerEmployeeId: string | null): ApprovalDTO {
  return {
    id: record.id,
    employee: {
      code: record.employee_code,
      full_name: record.employee_full_name,
      department: record.employee_department,
    },
    kind: record.kind,
    start_date: record.start_date,
    end_date: record.end_date,
    weekdays: countLeaveWeekdays(record.start_date, record.end_date),
    status: record.status,
    created_at: record.created_at.toISOString(),
    version: record.version,
    own: viewerEmployeeId !== null && record.employee_id === viewerEmployeeId,
  };
}

/**
 * The weekday count of a stored row. Derived on every read rather than stored in a column: the
 * migration has no `weekday_count` and this slice adds none, so there is exactly one definition
 * of the number and no way for a stored copy to drift from it.
 */
export function countLeaveWeekdays(startDate: string, endDate: string): number {
  const range = validateLeaveRange(startDate, endDate);
  return range.ok ? range.weekdays : 0;
}

/* ---------------------------------------------------------------------- the request schemas */

const leaveDateField = (label: string, message: string) =>
  z
    .string({ error: `${label} is required.` })
    .transform((value) => value.trim())
    .refine((value) => isIsoDateString(value), { message });

/**
 * Which field a range refusal is reported on, shared by the schema's `superRefine` and by the
 * service's own re-derivation, so the two cannot put the same message in two different places.
 */
export const LEAVE_RANGE_MESSAGE_FIELD = "end_date";

/**
 * `.strictObject`, so `employee_id`, `status`, `decided_by`, `decided_at`, `weekdays`, `version`
 * on a create, and the `reason` field spec §2 forbids, are unknown keys and a hard, detail-free
 * `400` — never a dropped field.
 *
 * The cross-field rule is a `superRefine` reported **on `end_date`**, because `parseFields` keys
 * its per-field messages on `issue.path[0]` and an object-level issue with no path would surface
 * as a field called "form". It runs only once both dates are real calendar dates: Zod still
 * evaluates object-level checks when a member failed, and a second message on a field the user is
 * already fixing is noise.
 */
export const leaveCreateSchema = z
  .strictObject({
    kind: z.enum(LEAVE_KINDS, { error: "Choose annual or personal leave." }),
    start_date: leaveDateField("Start date", LEAVE_RANGE_MESSAGES.invalid_start),
    end_date: leaveDateField("End date", LEAVE_RANGE_MESSAGES.invalid_end),
    [CSRF_FIELD_NAME]: csrfField,
  })
  .superRefine((value, ctx) => {
    if (!isIsoDateString(value.start_date) || !isIsoDateString(value.end_date)) {
      return;
    }
    const range = validateLeaveRange(value.start_date, value.end_date);
    if (range.ok) {
      return;
    }
    ctx.addIssue({
      code: "custom",
      path: [LEAVE_RANGE_MESSAGE_FIELD],
      message: LEAVE_RANGE_MESSAGES[range.problem],
    });
  });

export const leaveCancelSchema = z.strictObject({
  version: versionField,
  [CSRF_FIELD_NAME]: csrfField,
});

export const leaveDecisionSchema = z.strictObject({
  action: z.enum(LEAVE_DECISIONS, { error: "Choose approve or reject." }),
  version: versionField,
  [CSRF_FIELD_NAME]: csrfField,
});

export type LeaveCreateInput = z.output<typeof leaveCreateSchema>;
export type LeaveCancelInput = z.output<typeof leaveCancelSchema>;
export type LeaveDecisionInput = z.output<typeof leaveDecisionSchema>;

/** The fields the submit form posts, in the order it shows them. */
export const LEAVE_FORM_FIELDS = ["kind", "start_date", "end_date"] as const;
export type LeaveFormField = (typeof LEAVE_FORM_FIELDS)[number];

/* ----------------------------------------------------------------------- the result unions */

/**
 * What the leave services return, generic in the projection the caller is entitled to:
 * `OwnLeaveDTO` for the owner's own submit and cancel, `ApprovalDTO` for an administrator's
 * decision. A conflict therefore carries back exactly the record the caller could already see,
 * and never a field of someone else's.
 */
export type LeaveMutationResult<T> =
  | { readonly kind: "ok"; readonly request: T }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid"; readonly fields: Readonly<Record<string, string>> }
  | { readonly kind: "conflict_overlap" }
  | { readonly kind: "conflict_not_pending"; readonly current: T }
  | { readonly kind: "conflict_stale"; readonly current: T }
  | { readonly kind: "unavailable" };

/** The body of a successful leave mutation. `location` is built by the server, never by the caller. */
export interface LeaveMutationSuccessBody<T> {
  readonly ok: true;
  readonly location: string;
  readonly request: T;
}

/** Where the browser goes after a successful submit, cancel or decision. */
export type LeaveSavedFlag = "submitted" | "cancelled" | "approved" | "rejected";

export function savedLeaveLocation(requestId: string, saved: LeaveSavedFlag): string {
  const page = saved === "approved" || saved === "rejected" ? "/approvals" : "/leave";
  return `${page}?id=${encodeURIComponent(requestId)}&saved=${saved}`;
}

/** The consequence copy the form and the confirm dialogs show (spec §7: "clear consequences"). */
export const LEAVE_CONSEQUENCE_COPY = {
  overlap: "Overlapping pending or approved requests are rejected.",
  cancel: "Cancelling withdraws this request. It cannot be reopened.",
  approve: "Approving is final. The employee sees the result immediately.",
  reject: "Rejecting is final. The employee sees the result immediately.",
  ownRequest: "A different HR admin must decide your own request.",
} as const;

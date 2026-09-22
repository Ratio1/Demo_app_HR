/**
 * The employees contract: projections, request schemas and every answer the three employee
 * Route Handlers can give (spec §2, §3 "field-allowlisted DTOs", §6 S4).
 *
 * This module is the **single source of truth** for the slice-2 employee surface. Pages import
 * its types, the services return its DTOs, the routes map its result unions onto statuses.
 * Nothing else may hand an `employees` row to a caller: projection happens here, before
 * serialization, so a field that is not in a DTO is absent from the JSON body *and* from the
 * RSC flight payload rather than merely unrendered (spec §3 "never send full HR rows then hide
 * fields").
 *
 * It deliberately imports nothing but `zod` and the two name constants in
 * `src/shared/cookies.ts`, so a client component may import from it (the inline-error form
 * needs the schemas' field names) without dragging `pg`, `node:crypto` or `@node-rs/argon2`
 * into a browser bundle.
 *
 * ---------------------------------------------------------------------------------------
 * ## HTTP contract (part B owns it; part C builds against it)
 *
 * Three Node-runtime Route Handlers, all `POST`, all behind slice 1's mutation guard
 * (≤64 KiB body read with the cap on the stream, exact `Origin` equality, then the session's
 * synchronizer CSRF token in the `csrf` field):
 *
 * | Route | Body (plus `csrf`) |
 * |---|---|
 * | `POST /api/employees`             | `code, full_name, work_email, title, department, start_date` |
 * | `POST /api/employees/<id>`        | the same six fields **plus** `version` |
 * | `POST /api/employees/<id>/status` | `action` (`activate`\|`deactivate`) **plus** `version` |
 *
 * **Body encoding — either `application/json` or `application/x-www-form-urlencoded`.** Both
 * are read by the same guard and validated by the same `z.strictObject` schema: a JSON body
 * must be a flat object whose values are strings, numbers or booleans, and each value is
 * compared as its string form, so the two encodings cannot diverge. A nested object, an array,
 * a `null`, or the same form field twice is `400 invalid_input` — parameter pollution and
 * prototype-shaped keys are refused, never merged.
 *
 * **Answers.** Every response is JSON with `Cache-Control: no-store` and the S5 header set:
 *
 * | Status | Body | When |
 * |---|---|---|
 * | `200` | `{ ok: true, location, employee }` | success; `location` is the page to navigate to |
 * | `400` | `{ error: 'invalid_input', fields: { <field>: <message> } }` | a value the user can correct |
 * | `400` | `{ error: 'invalid_input' }` (no `fields`) | over-post / unknown or duplicated key |
 * | `401` | `{ error: 'unauthenticated' }` | no live session |
 * | `403` | `{ error: 'forbidden' }` | bad `Origin`, CSRF mismatch, or the caller is not `hr_admin` |
 * | `404` | `{ error: 'not_found' }` | no employee with that id (HR only ever reaches this) |
 * | `409` | `{ error: 'conflict_stale', current: HrEmployeeDTO }` | `version` moved under the editor |
 * | `409` | `{ error: 'conflict_last_admin' }` | the cascade would leave no active HR administrator |
 * | `413` `415` `429` `503` | `{ error: <code> }` | oversize body, wrong media type, hashing queue full, database down |
 *
 * **Why `200 { ok, location }` and not the brief's `303`.** The forms submit through `fetch`
 * from a client component (the brief's own Decision line), and a `fetch` caller cannot read a
 * `303`: `redirect: 'manual'` yields an opaque response with no readable `Location`, and
 * following the redirect renders the whole destination page a second time on a half-core
 * budget. The `?saved=…` flag the brief asks for therefore travels in `location`, which the
 * **server** builds (never a caller-supplied value, so there is no open-redirect surface), and
 * the client navigates to it. Recorded as a deviation.
 *
 * ## Authorization, in one sentence per role
 *
 * - `hr_admin` — every employee record, all minimal fields (`HrEmployeeDTO`), create/edit/
 *   activate/deactivate.
 * - `employee` — the directory (active colleagues, four fields) and their own profile,
 *   read-only. Any `/employees` page, any employee mutation and any other employee's record is
 *   `403 forbidden`.
 * - anonymous — `303 → /login` on pages, `401` on the API.
 *
 * `account_id` is **never writable through the web** and never leaves the server as a UUID:
 * `HrEmployeeDTO.link` is `{ linked: false }` or `{ linked: true, email }`. The link is written
 * only by `manage create-user --employee <code>`.
 */
import { z } from "zod";

import { isIsoDateString, isLeapYear } from "../../shared/dates.ts";
import { CSRF_FIELD_NAME, csrfField, versionField } from "./common.ts";
import type { FieldErrors, ReadResult } from "./common.ts";
// `dto/leave.ts` imports nothing from this module, so the employee overview may name the leave
// projection without a cycle.
import type { LeaveStatus, OwnLeaveDTO } from "./leave.ts";

export { CSRF_FIELD_NAME };

/**
 * Re-exported so every slice-2 import keeps working after slice 3 moved the two shared shapes
 * into `./common.ts` and the calendar arithmetic into `src/shared/dates.ts`.
 */
export type { FieldErrors, ReadResult };
export { isIsoDateString, isLeapYear };

/* ------------------------------------------------------------------ bounds and primitives */

/** Spec §2 / `migrations/0001_init.sql`: the exact `char_length` CHECK bounds. */
export const CODE_MAX_LENGTH = 32;
export const NAME_MAX_LENGTH = 160;
export const TITLE_MAX_LENGTH = 160;
export const DEPARTMENT_MAX_LENGTH = 160;
export const WORK_EMAIL_MAX_LENGTH = 254;

/** Sanity window for an employment start date; outside it the value is a typo, not a date. */
export const START_DATE_MIN_YEAR = 1900;
export const START_DATE_MAX_YEAR = 2100;

/**
 * `isIsoDateString` — true for a real calendar date written `YYYY-MM-DD` — now lives in
 * `src/shared/dates.ts` with the rest of the civil-date arithmetic, and is re-exported above so
 * this module stays the one import a form needs. It is computed arithmetically on purpose: a
 * `new Date("2026-02-30")` would silently roll over to 2 March, and a `Date` at all would
 * reintroduce the midnight-timestamp bug spec §2 forbids. Dates stay strings end to end.
 */

/** The stored and compared form of a work email: trimmed and lowercased (spec §2 "unique normalized"). */
export function normalizeWorkEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Code-point length, matching PostgreSQL's `char_length`. JavaScript's `String.length` counts
 * UTF-16 units, so an astral character would otherwise be refused at 80 characters by Zod and
 * accepted at 160 by the database — two different answers for the same value.
 */
export function codePointLength(value: string): number {
  return [...value].length;
}

/* -------------------------------------------------------------------------------- the DTOs */

export type EmployeeViewerRole = "hr_admin" | "employee";

/** Whether a record has a login, and which one — never the `accounts.id` itself. */
export type EmployeeLinkDTO =
  | { readonly linked: false }
  | { readonly linked: true; readonly email: string };

/**
 * The HR projection: the minimal fields of spec §2, used identically by the list, the detail
 * view and the editor, so those three surfaces cannot drift apart.
 */
export interface HrEmployeeDTO {
  readonly id: string;
  readonly code: string;
  readonly full_name: string;
  readonly work_email: string;
  readonly title: string;
  readonly department: string;
  /** ISO `YYYY-MM-DD`; never a `Date`. */
  readonly start_date: string;
  readonly active: boolean;
  readonly link: EmployeeLinkDTO;
  readonly version: number;
}

/** What an `employee` may see of a colleague — four fields, nothing else (spec §2). */
export interface DirectoryEntryDTO {
  readonly full_name: string;
  readonly title: string;
  readonly department: string;
  readonly work_email: string;
}

/** The same directory row for an `hr_admin`, who additionally sees the code and the status. */
export interface HrDirectoryEntryDTO extends DirectoryEntryDTO {
  readonly code: string;
  readonly active: boolean;
}

/** The directory is role-tagged so a page cannot render the HR columns for an `employee`. */
export type DirectoryDTO =
  | { readonly role: "employee"; readonly entries: readonly DirectoryEntryDTO[] }
  | { readonly role: "hr_admin"; readonly entries: readonly HrDirectoryEntryDTO[] };

/**
 * `/me`: the caller's own record, read-only. No `version` and no `link` — there is nothing to
 * edit and nothing to conflict with, and the account behind the link is the caller's own.
 */
export interface OwnProfileDTO {
  readonly code: string;
  readonly full_name: string;
  readonly work_email: string;
  readonly title: string;
  readonly department: string;
  readonly start_date: string;
  readonly active: boolean;
}

/**
 * `/` for an `hr_admin`: headcount, per-department active counts and the size of the approval
 * queue. Slice 3 fills `pendingApprovals` with the real number of `pending` requests — the field
 * names are slice 2's, kept rather than renamed to the brief's `pending_approvals` /
 * `departments[].name`, because `src/app/page.tsx` is part C's file and renaming under it would
 * break their page mid-slice. Recorded as a deviation.
 */
export interface HrOverviewDTO {
  readonly role: "hr_admin";
  readonly headcount: number;
  readonly departments: readonly { readonly department: string; readonly count: number }[];
  readonly pendingApprovals: number;
}

/**
 * `/` for an `employee`: their own name and their own leave, and nothing else. Built by a
 * separate function from `HrOverviewDTO`, so an HR total can never leak into it by accident
 * (spec §2 Dashboard: "employees only own request status, never colleagues' leave or HR-only
 * totals"). `fullName` is `null` for an account with no linked employee row.
 *
 * `own_requests` and `latest_status` are slice 3's additions and carry the same `OwnLeaveDTO` the
 * `/leave` page uses, so the overview cannot show a status the history page disagrees with.
 */
export interface EmployeeOverviewDTO {
  readonly role: "employee";
  readonly fullName: string | null;
  /** How many requests this employee has ever submitted, in any status. */
  readonly leaveRequests: number;
  /** The most recent requests, newest first, capped at `OVERVIEW_OWN_LEAVE_LIMIT`. */
  readonly own_requests: readonly OwnLeaveDTO[];
  /** The status of the most recent request, or `null` when there is none. */
  readonly latest_status: LeaveStatus | null;
}

export type OverviewDTO = HrOverviewDTO | EmployeeOverviewDTO;

/* ------------------------------------------------------------------------- the projections */

/**
 * The row shape the repositories return: exactly the columns the projections below need, with
 * the linked account's email already joined in. Declared here rather than imported so this
 * module keeps its "no `pg`" property.
 */
export interface EmployeeRecord {
  readonly id: string;
  readonly code: string;
  readonly full_name: string;
  readonly work_email: string;
  readonly title: string;
  readonly department: string;
  readonly start_date: string;
  readonly active: boolean;
  readonly account_id: string | null;
  readonly account_email: string | null;
  readonly version: number;
}

export function toEmployeeLink(record: EmployeeRecord): EmployeeLinkDTO {
  if (record.account_id === null) {
    return { linked: false };
  }
  return { linked: true, email: record.account_email ?? "" };
}

export function toHrEmployee(record: EmployeeRecord): HrEmployeeDTO {
  return {
    id: record.id,
    code: record.code,
    full_name: record.full_name,
    work_email: record.work_email,
    title: record.title,
    department: record.department,
    start_date: record.start_date,
    active: record.active,
    link: toEmployeeLink(record),
    version: record.version,
  };
}

export function toDirectoryEntry(record: EmployeeRecord): DirectoryEntryDTO {
  return {
    full_name: record.full_name,
    title: record.title,
    department: record.department,
    work_email: record.work_email,
  };
}

export function toHrDirectoryEntry(record: EmployeeRecord): HrDirectoryEntryDTO {
  return { ...toDirectoryEntry(record), code: record.code, active: record.active };
}

export function toOwnProfile(record: EmployeeRecord): OwnProfileDTO {
  return {
    code: record.code,
    full_name: record.full_name,
    work_email: record.work_email,
    title: record.title,
    department: record.department,
    start_date: record.start_date,
    active: record.active,
  };
}

/** The one place the directory's role split is decided. */
export function projectDirectory(
  role: EmployeeViewerRole,
  records: readonly EmployeeRecord[],
): DirectoryDTO {
  if (role === "hr_admin") {
    return { role: "hr_admin", entries: records.map(toHrDirectoryEntry) };
  }
  return { role: "employee", entries: records.map(toDirectoryEntry) };
}

/* ---------------------------------------------------------------------- the request schemas */

/**
 * A bounded, trimmed text field with a message a form can show next to the input. The bound is
 * applied **after** trimming and in code points, so it is the same bound the database CHECK
 * applies; the 64 KiB body cap is what keeps the untrimmed value bounded.
 */
function boundedText(label: string, max: number) {
  return z
    .string({ error: `${label} is required.` })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, { message: `${label} is required.` })
    .refine((value) => codePointLength(value) <= max, {
      message: `${label} must be ${max} characters or fewer.`,
    });
}

const workEmailField = z
  .string({ error: "Work email is required." })
  .transform(normalizeWorkEmail)
  .refine((value) => value.length > 0, { message: "Work email is required." })
  .refine((value) => codePointLength(value) <= WORK_EMAIL_MAX_LENGTH, {
    message: `Work email must be ${WORK_EMAIL_MAX_LENGTH} characters or fewer.`,
  })
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value), {
    message: "Enter a work email address such as name@example.test.",
  });

const startDateField = z
  .string({ error: "Start date is required." })
  .transform((value) => value.trim())
  .refine((value) => isIsoDateString(value), {
    message: "Enter the start date as YYYY-MM-DD.",
  })
  .refine(
    (value) => {
      const year = Number(value.slice(0, 4));
      return year >= START_DATE_MIN_YEAR && year <= START_DATE_MAX_YEAR;
    },
    { message: `Start date must be between ${START_DATE_MIN_YEAR} and ${START_DATE_MAX_YEAR}.` },
  );

const employeeFields = {
  code: boundedText("Employee code", CODE_MAX_LENGTH),
  full_name: boundedText("Full name", NAME_MAX_LENGTH),
  work_email: workEmailField,
  title: boundedText("Job title", TITLE_MAX_LENGTH),
  department: boundedText("Department", DEPARTMENT_MAX_LENGTH),
  start_date: startDateField,
} as const;

/**
 * `.strictObject`, so `account_id`, `role`, `id`, `created_at`, `active`, `version` on a create
 * — anything outside the allowlist — is an unknown key and a hard `400`, never a dropped field.
 */
export const employeeCreateSchema = z.strictObject({
  ...employeeFields,
  [CSRF_FIELD_NAME]: csrfField,
});

export const employeeUpdateSchema = z.strictObject({
  ...employeeFields,
  version: versionField,
  [CSRF_FIELD_NAME]: csrfField,
});

export const employeeStatusSchema = z.strictObject({
  action: z.enum(["activate", "deactivate"], {
    error: "Choose activate or deactivate.",
  }),
  version: versionField,
  [CSRF_FIELD_NAME]: csrfField,
});

export type EmployeeCreateInput = z.output<typeof employeeCreateSchema>;
export type EmployeeUpdateInput = z.output<typeof employeeUpdateSchema>;
export type EmployeeStatusInput = z.output<typeof employeeStatusSchema>;

/** The fields the editor form posts, in the order the form shows them. */
export const EMPLOYEE_FORM_FIELDS = [
  "code",
  "full_name",
  "work_email",
  "title",
  "department",
  "start_date",
] as const;

export type EmployeeFormField = (typeof EMPLOYEE_FORM_FIELDS)[number];

/* ----------------------------------------------------------------------- the result unions */

/**
 * What the employee services return. The routes map these onto the statuses in the table at
 * the top of this file, and the pages use the same union for their banners.
 */
export type EmployeeMutationResult =
  | { readonly kind: "ok"; readonly employee: HrEmployeeDTO }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid"; readonly fields: FieldErrors }
  | { readonly kind: "conflict_stale"; readonly current: HrEmployeeDTO }
  | { readonly kind: "conflict_last_admin" }
  | { readonly kind: "unavailable" };

/** The body of a successful mutation. `location` is built by the server, never by the caller. */
export interface MutationSuccessBody {
  readonly ok: true;
  readonly location: string;
  readonly employee: HrEmployeeDTO;
}

/** Where the browser goes after a successful create, edit or status change. */
export function savedLocation(employeeId: string, saved: "created" | "updated" | "status"): string {
  return `/employees?id=${encodeURIComponent(employeeId)}&saved=${saved}`;
}

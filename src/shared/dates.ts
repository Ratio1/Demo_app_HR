/**
 * Civil-date arithmetic, shared by the server and the browser (spec §2, data contract C4).
 *
 * **No `Date` is constructed anywhere in this module, and none may be.** Spec §2 asks to "keep
 * SQL DATE values as ISO date strings end-to-end, not JS midnight timestamps": `new Date("2026-03-02")`
 * is midnight **UTC**, so in `Pacific/Niue` (UTC−11) its local day is 1 March and in
 * `Pacific/Kiritimati` (UTC+14) it is 3 March. Every function here works on the integer
 * *days-from-civil* count of Howard Hinnant's algorithm, so the answers are identical under every
 * `TZ` — which `tests/unit/dates.test.ts` proves by running the same suite under three of them
 * (`npm run test:unit:tz`).
 *
 * The module is deliberately dependency-free (not even `zod`), so a client component may import
 * it to show the same illustrative weekday count the server will derive, and the two cannot
 * disagree: `/leave`'s live count and the count stored in the DTO come from `countWeekdays`.
 */

/** `YYYY-MM-DD`, zero-padded. The only date shape this application accepts or emits. */
export const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Days from 1970-01-01 to 0000-03-01, the shift Hinnant's algorithm is written around. */
const DAYS_FROM_0000_03_01_TO_EPOCH = 719_468;
const DAYS_PER_ERA = 146_097;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** How many days a month has, 1-based month. Returns 0 for a month outside 1–12. */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    return 0;
  }
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return MONTH_LENGTHS[month - 1] as number;
}

/**
 * The three integer parts of an ISO date, or `null` when the string is not a real calendar date.
 * `2026-02-30` is `null` here; `new Date` would silently roll it over to 2 March.
 */
export function parseIsoDate(
  value: string,
): { readonly year: number; readonly month: number; readonly day: number } | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isIsoDateString(value: string): boolean {
  return parseIsoDate(value) !== null;
}

/**
 * Howard Hinnant's `days_from_civil`: the number of days from 1970-01-01 to `year-month-day`,
 * using only integer arithmetic. Exact for every year in the proleptic Gregorian calendar, and
 * completely independent of the host time zone, the locale and the clock.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400; // [0, 399]
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // [0, 365]
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear; // [0, 146096]
  return era * DAYS_PER_ERA + dayOfEra - DAYS_FROM_0000_03_01_TO_EPOCH;
}

/** The same count for an ISO string, or `null` when it is not a real date. */
export function isoToDayNumber(value: string): number | null {
  const parts = parseIsoDate(value);
  if (parts === null) {
    return null;
  }
  return daysFromCivil(parts.year, parts.month, parts.day);
}

/** `0` Sunday … `6` Saturday, from a day number. 1970-01-01 (day 0) was a Thursday. */
export function dayOfWeekFromDayNumber(dayNumber: number): number {
  return (((dayNumber % 7) + 7) % 7 + 4) % 7;
}

/** `0` Sunday … `6` Saturday, or `null` when the string is not a real date. */
export function dayOfWeek(value: string): number | null {
  const dayNumber = isoToDayNumber(value);
  return dayNumber === null ? null : dayOfWeekFromDayNumber(dayNumber);
}

/** Monday–Friday. Weekends are Saturday and Sunday; no holiday calendar exists (spec §2). */
export function isWeekdayDayNumber(dayNumber: number): boolean {
  const weekday = dayOfWeekFromDayNumber(dayNumber);
  return weekday >= 1 && weekday <= 5;
}

/**
 * Lexicographic comparison, which is the same as chronological for zero-padded ISO dates —
 * the reason the whole application keeps dates in this one shape.
 */
export function compareIsoDates(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * The **illustrative** Monday–Friday count of an inclusive range (spec §2: "Display illustrative
 * Monday–Friday counts, not legal entitlements; no holidays/accrual/payroll"). Returns `0` for a
 * malformed date or an inverted range, so a caller that skipped validation cannot get a number
 * that looks legitimate.
 *
 * Whole weeks contribute five days each and at most six remaining days are counted one by one,
 * so the cost does not grow with the length of the range.
 */
export function countWeekdays(startDate: string, endDate: string): number {
  const start = isoToDayNumber(startDate);
  const end = isoToDayNumber(endDate);
  if (start === null || end === null || end < start) {
    return 0;
  }
  const total = end - start + 1;
  const fullWeeks = Math.floor(total / 7);
  let count = fullWeeks * 5;
  for (let offset = fullWeeks * 7; offset < total; offset += 1) {
    if (isWeekdayDayNumber(start + offset)) {
      count += 1;
    }
  }
  return count;
}

/** Inclusive length of a range in calendar days, or `0` when it is malformed or inverted. */
export function countDays(startDate: string, endDate: string): number {
  const start = isoToDayNumber(startDate);
  const end = isoToDayNumber(endDate);
  if (start === null || end === null || end < start) {
    return 0;
  }
  return end - start + 1;
}

/** Why a leave range is not acceptable. One vocabulary for the server schema and the form. */
export type LeaveRangeProblem =
  | "invalid_start"
  | "invalid_end"
  | "end_before_start"
  | "no_weekday";

export type LeaveRangeResult =
  | { readonly ok: true; readonly weekdays: number; readonly days: number }
  | { readonly ok: false; readonly problem: LeaveRangeProblem };

/**
 * The single rule set for a leave range (spec §2: "Require start ≤ end and ≥one weekday"), used
 * by `src/server/dto/leave.ts` before any row is written **and** by the `/leave` form to show the
 * same count and the same refusal before submission. A Saturday-to-Sunday range is `no_weekday`.
 */
export function validateLeaveRange(startDate: string, endDate: string): LeaveRangeResult {
  const start = isoToDayNumber(startDate);
  if (start === null) {
    return { ok: false, problem: "invalid_start" };
  }
  const end = isoToDayNumber(endDate);
  if (end === null) {
    return { ok: false, problem: "invalid_end" };
  }
  if (end < start) {
    return { ok: false, problem: "end_before_start" };
  }
  const weekdays = countWeekdays(startDate, endDate);
  if (weekdays < 1) {
    return { ok: false, problem: "no_weekday" };
  }
  return { ok: true, weekdays, days: end - start + 1 };
}

/** The message each refusal shows next to the input; the server and the form share the wording. */
export const LEAVE_RANGE_MESSAGES: Readonly<Record<LeaveRangeProblem, string>> = {
  invalid_start: "Enter the start date as YYYY-MM-DD.",
  invalid_end: "Enter the end date as YYYY-MM-DD.",
  end_before_start: "The end date must be on or after the start date.",
  no_weekday: "Choose a range that includes at least one weekday (Monday to Friday).",
};

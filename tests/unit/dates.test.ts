import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LEAVE_RANGE_MESSAGES,
  compareIsoDates,
  countDays,
  countWeekdays,
  dayOfWeek,
  daysFromCivil,
  daysInMonth,
  isIsoDateString,
  isLeapYear,
  isoToDayNumber,
  parseIsoDate,
  validateLeaveRange,
} from "../../src/shared/dates.ts";

/**
 * `src/shared/dates.ts` is the whole of the application's calendar arithmetic (spec §2: "Keep SQL
 * DATE values as ISO date strings end-to-end, not JS midnight timestamps").
 *
 * **This file is run three times, under `TZ=UTC`, `TZ=Pacific/Kiritimati` (UTC+14) and
 * `TZ=Pacific/Niue` (UTC−11), by `npm run test:unit:tz`.** Every expectation below is an absolute
 * value, not a comparison against something else computed at runtime, so a `Date`-based
 * implementation cannot satisfy all three runs: `new Date("2026-03-02").getDate()` is 1 under
 * Niue, because the string parses as midnight **UTC** and the local day is still 1 March there;
 * and a `Date` built from local parts under Kiritimati serialises back to the previous day in
 * UTC. Those two offsets are the extremes of the tz database, so a rule that holds under all
 * three holds everywhere. Verified present on this machine before the matrix was added.
 */

const SUNDAY = 0;
const MONDAY = 1;
const FRIDAY = 5;
const SATURDAY = 6;

describe("the module makes no use of Date", () => {
  it("contains no `new Date`, `Date.now` or `Date.UTC`", () => {
    const source = readFileSync(resolve(process.cwd(), "src/shared/dates.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    expect(code).not.toMatch(/new\s+Date/u);
    expect(code).not.toMatch(/Date\s*\.\s*(now|UTC|parse)/u);
    expect(code).not.toMatch(/toLocale|getTimezoneOffset|Intl\./u);
  });
});

describe("parsing and calendar validity", () => {
  it("accepts a real date and rejects one that does not exist", () => {
    expect(isIsoDateString("2026-03-02")).toBe(true);
    // `new Date("2026-02-30")` would silently roll over to 2 March.
    expect(isIsoDateString("2026-02-30")).toBe(false);
    expect(isIsoDateString("2026-04-31")).toBe(false);
    expect(isIsoDateString("2026-13-01")).toBe(false);
    expect(isIsoDateString("2026-00-10")).toBe(false);
    expect(isIsoDateString("2026-01-00")).toBe(false);
  });

  it("insists on the zero-padded YYYY-MM-DD shape", () => {
    for (const value of [
      "2026-3-02",
      "2026-03-2",
      "26-03-02",
      "2026/03/02",
      " 2026-03-02",
      "2026-03-02 ",
      "2026-03-02T00:00:00Z",
      "",
    ]) {
      expect(isIsoDateString(value)).toBe(false);
    }
  });

  it("knows the leap years and February's length", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2026, 13)).toBe(0);
    expect(isIsoDateString("2024-02-29")).toBe(true);
    expect(isIsoDateString("2026-02-29")).toBe(false);
    expect(isIsoDateString("2100-02-29")).toBe(false);
    expect(isIsoDateString("2000-02-29")).toBe(true);
  });

  it("returns the integer parts, never a Date", () => {
    expect(parseIsoDate("2026-03-02")).toEqual({ year: 2026, month: 3, day: 2 });
    expect(parseIsoDate("2026-02-30")).toBeNull();
  });
});

describe("days from civil, fixed against known anchors", () => {
  it("counts from the Unix epoch", () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(isoToDayNumber("1970-01-01")).toBe(0);
    expect(isoToDayNumber("1969-12-31")).toBe(-1);
    expect(isoToDayNumber("1970-01-02")).toBe(1);
    expect(isoToDayNumber("2000-01-01")).toBe(10_957);
    expect(isoToDayNumber("2026-09-22")).toBe(20_718);
  });

  it("gives the same weekday for the anchors under every TZ", () => {
    expect(dayOfWeek("1970-01-01")).toBe(4); // a Thursday
    expect(dayOfWeek("2026-09-22")).toBe(2); // a Tuesday
    expect(dayOfWeek("2024-02-29")).toBe(4); // the leap day, a Thursday
    expect(dayOfWeek("2026-09-26")).toBe(SATURDAY);
    expect(dayOfWeek("2026-09-27")).toBe(SUNDAY);
    expect(dayOfWeek("2026-09-28")).toBe(MONDAY);
    expect(dayOfWeek("2026-10-02")).toBe(FRIDAY);
    expect(dayOfWeek("2026-02-30")).toBeNull();
  });

  it("orders dates lexicographically, which is chronologically", () => {
    expect(compareIsoDates("2026-01-02", "2026-01-10")).toBe(-1);
    expect(compareIsoDates("2026-01-10", "2026-01-02")).toBe(1);
    expect(compareIsoDates("2026-01-02", "2026-01-02")).toBe(0);
    expect(compareIsoDates("2025-12-31", "2026-01-01")).toBe(-1);
  });
});

describe("the illustrative Monday–Friday count", () => {
  it("counts a single day", () => {
    expect(countWeekdays("2026-09-22", "2026-09-22")).toBe(1); // Tuesday
    expect(countWeekdays("2026-09-26", "2026-09-26")).toBe(0); // Saturday
    expect(countWeekdays("2026-09-27", "2026-09-27")).toBe(0); // Sunday
    expect(countDays("2026-09-22", "2026-09-22")).toBe(1);
  });

  it("counts a whole week and whole multiples of one", () => {
    expect(countWeekdays("2026-09-21", "2026-09-27")).toBe(5); // Mon–Sun
    expect(countWeekdays("2026-09-21", "2026-10-04")).toBe(10); // two whole weeks
    expect(countWeekdays("2026-09-26", "2026-10-09")).toBe(10); // Sat–Fri, two weeks
    expect(countDays("2026-09-21", "2026-10-04")).toBe(14);
  });

  it("crosses a month boundary", () => {
    expect(countWeekdays("2026-01-30", "2026-02-02")).toBe(2); // Fri, Sat, Sun, Mon
    expect(countWeekdays("2026-09-28", "2026-10-02")).toBe(5); // Mon–Fri across the boundary
    expect(countWeekdays("2026-04-30", "2026-05-01")).toBe(2); // Thu, Fri
  });

  it("crosses a year boundary", () => {
    expect(countWeekdays("2025-12-31", "2026-01-02")).toBe(3); // Wed, Thu, Fri
    expect(countWeekdays("2025-12-29", "2026-01-09")).toBe(10);
    expect(countWeekdays("2026-12-31", "2027-01-01")).toBe(2); // Thu, Fri
  });

  it("counts the leap day and the day after it", () => {
    expect(countWeekdays("2024-02-29", "2024-02-29")).toBe(1); // Thursday
    expect(countWeekdays("2024-02-28", "2024-03-01")).toBe(3); // Wed, Thu, Fri
    expect(countWeekdays("2024-02-23", "2024-03-01")).toBe(6); // Fri + Mon–Fri
    // 2100 is not a leap year: 2100-02-29 does not exist, so 28 Feb (a Sunday) is followed
    // straight by 1 March (a Monday) and the range holds exactly one weekday.
    expect(isIsoDateString("2100-02-29")).toBe(false);
    expect(countWeekdays("2100-02-28", "2100-03-01")).toBe(1);
  });

  it("is zero for a weekend-only range, a malformed date and an inverted range", () => {
    expect(countWeekdays("2026-09-26", "2026-09-27")).toBe(0); // Sat–Sun
    expect(countWeekdays("2026-09-26", "2026-09-26")).toBe(0);
    expect(countWeekdays("2026-02-30", "2026-03-02")).toBe(0);
    expect(countWeekdays("2026-03-02", "2026-02-30")).toBe(0);
    expect(countWeekdays("2026-09-30", "2026-09-28")).toBe(0);
    expect(countDays("2026-09-30", "2026-09-28")).toBe(0);
  });

  it("stays linear-free: a decade-long range is counted without iterating it", () => {
    // 2016-01-01 (Fri) to 2025-12-31 (Wed): 3653 days, 2609 weekdays.
    expect(countWeekdays("2016-01-01", "2025-12-31")).toBe(2609);
    expect(countDays("2016-01-01", "2025-12-31")).toBe(3653);
  });
});

describe("validateLeaveRange — the one rule set the schema and the form share", () => {
  it("accepts a range with at least one weekday and reports the count", () => {
    expect(validateLeaveRange("2026-09-22", "2026-09-24")).toEqual({
      ok: true,
      weekdays: 3,
      days: 3,
    });
    // A weekend that touches one weekday is fine: the count is what it is.
    expect(validateLeaveRange("2026-09-25", "2026-09-27")).toEqual({
      ok: true,
      weekdays: 1,
      days: 3,
    });
  });

  it("names which date is malformed", () => {
    expect(validateLeaveRange("2026-02-30", "2026-03-05")).toEqual({
      ok: false,
      problem: "invalid_start",
    });
    expect(validateLeaveRange("2026-03-02", "not-a-date")).toEqual({
      ok: false,
      problem: "invalid_end",
    });
  });

  it("refuses an inverted range", () => {
    expect(validateLeaveRange("2026-03-05", "2026-03-02")).toEqual({
      ok: false,
      problem: "end_before_start",
    });
  });

  it("refuses a weekend-only range (spec §2: at least one weekday)", () => {
    expect(validateLeaveRange("2026-09-26", "2026-09-27")).toEqual({
      ok: false,
      problem: "no_weekday",
    });
    expect(validateLeaveRange("2026-09-27", "2026-09-27")).toEqual({
      ok: false,
      problem: "no_weekday",
    });
  });

  it("has a message for every problem it can report", () => {
    for (const problem of ["invalid_start", "invalid_end", "end_before_start", "no_weekday"] as const) {
      expect(LEAVE_RANGE_MESSAGES[problem].length).toBeGreaterThan(0);
    }
  });
});

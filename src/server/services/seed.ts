/**
 * `manage seed-demo` (spec §9 "fictional seed"; slice 5 Part S).
 *
 * Writes fictional employees and a handful of leave requests so a fresh database has something
 * to look at, through the **same repository functions** the web layer and `manage`'s account
 * commands use — never bespoke SQL — so nothing here can bypass a constraint the rest of the
 * application obeys.
 *
 * Two hard rules, both from D5.3 and the threat model's AC-43:
 *
 *  - **No account is ever created here.** `bootstrap` must still see an empty `accounts` table
 *    afterwards, so the operator's own hidden-prompt bootstrap keeps working on a freshly
 *    migrated-and-seeded database. Every audit row this module writes is attributed to the fixed
 *    `SEED_SYSTEM_ACTOR_ID`, which carries no `accounts` row and cannot log in.
 *  - **No leave request here is ever `approved` or `rejected`.** `leave_requests_decided_by_fkey`
 *    (`migrations/0001_init.sql`) requires `decided_by` to reference a real `accounts` row
 *    whenever status is `approved`/`rejected` (`leave_requests_decision_recorded`), and the first
 *    rule above means no such row exists. An earlier design note (`design/data-contract.md`
 *    §11.1, superseded by the 2026-09-22 simplified plan — see `ledger.md`) assumed
 *    `decided_by` carried no foreign key and planned to point *decided* seed rows at the system
 *    actor too; the schema actually shipped in slice 1 does carry that FK. So the "mix of
 *    statuses" this module produces is `pending` and `cancelled` only — both leave `decided_by`
 *    `NULL`, which every constraint allows. Recorded as a concern in the slice 5 report.
 */
import type { Pool, PoolClient } from "../db/pool.ts";

import { withClient, withTransaction } from "../db/pool.ts";
import { ProvisioningError } from "./accounts.ts";
import { SEED_SYSTEM_ACTOR_ID, insertAuditEvent } from "../repos/audit.ts";
import { countEmployees, insertEmployee, type EmployeeWriteInput } from "../repos/employees.ts";
import { cancelLeaveRequest, insertLeaveRequest } from "../repos/leave.ts";
import type { LeaveKind } from "../dto/leave.ts";
import { parseIsoDate } from "../../shared/dates.ts";

/** Four departments, reused across this app's fictional fixtures (go-live, tests, this seed). */
const DEPARTMENTS = ["Operations", "Engineering", "People", "Finance"] as const;

interface FixturePerson {
  readonly firstName: string;
  readonly lastName: string;
  readonly department: (typeof DEPARTMENTS)[number];
  readonly title: string;
  /** A plausible past hire date, `YYYY-MM-DD`. */
  readonly startDate: string;
}

/** Twelve fictional people, three per department, none sharing a name with the go-live seed. */
const FIXTURE_PEOPLE: readonly FixturePerson[] = [
  { firstName: "Mihai", lastName: "Dumitrescu", department: "Operations", title: "Coordinator", startDate: "2023-04-10" },
  { firstName: "Irina", lastName: "Constantin", department: "Operations", title: "Analyst", startDate: "2024-08-19" },
  { firstName: "Vlad", lastName: "Enache", department: "Operations", title: "Specialist", startDate: "2025-02-03" },
  { firstName: "Simona", lastName: "Barbu", department: "Engineering", title: "Engineer", startDate: "2022-11-14" },
  { firstName: "Radu", lastName: "Preda", department: "Engineering", title: "Engineer", startDate: "2023-09-01" },
  { firstName: "Alexandra", lastName: "Matei", department: "Engineering", title: "Tech Lead", startDate: "2021-06-21" },
  { firstName: "Cosmin", lastName: "Stoica", department: "People", title: "Recruiter", startDate: "2024-01-15" },
  { firstName: "Teodora", lastName: "Vasile", department: "People", title: "HR Generalist", startDate: "2025-05-12" },
  { firstName: "Andrei", lastName: "Munteanu", department: "People", title: "Coordinator", startDate: "2023-03-27" },
  { firstName: "Diana", lastName: "Petrescu", department: "Finance", title: "Accountant", startDate: "2022-10-05" },
  { firstName: "Sorin", lastName: "Lazar", department: "Finance", title: "Analyst", startDate: "2024-07-08" },
  { firstName: "Raluca", lastName: "Dinu", department: "Finance", title: "Controller", startDate: "2025-09-22" },
];

// A real runtime check, not just the type above: a future edit that mistypes a department name
// fails loudly here rather than silently drifting from the one canonical list.
for (const person of FIXTURE_PEOPLE) {
  if (!(DEPARTMENTS as readonly string[]).includes(person.department)) {
    throw new Error(`seed-demo: "${person.department}" is not one of the four fixed departments`);
  }
}

/** The first Monday of each month, January–September 2026 (verified against a real calendar). */
const FIRST_MONDAYS = [
  "2026-01-05",
  "2026-02-02",
  "2026-03-02",
  "2026-04-06",
  "2026-05-04",
  "2026-06-01",
  "2026-07-06",
  "2026-08-03",
  "2026-09-07",
] as const;

/**
 * `1`, `3` or `5` weekdays starting on `startMonday`, staying inside one Mon–Fri work week (so
 * the day-of-month arithmetic below never crosses a month boundary — every `FIRST_MONDAYS` entry
 * falls on or before the 7th, plus at most 4 more days is at most the 11th). Uses
 * `src/shared/dates.ts`'s own ISO parser rather than a hand-rolled split, per spec §2's rule
 * against ad hoc date handling.
 */
function weekRange(startMonday: string, weekdays: 1 | 3 | 5): { start_date: string; end_date: string } {
  const parsed = parseIsoDate(startMonday);
  if (parsed === null) {
    throw new Error(`seed-demo: ${startMonday} is not a real calendar date`);
  }
  const endDay = String(parsed.day + (weekdays - 1)).padStart(2, "0");
  const month = String(parsed.month).padStart(2, "0");
  return { start_date: startMonday, end_date: `${parsed.year}-${month}-${endDay}` };
}

const CODE_PREFIX = "E-2";
/** Matches exactly the codes this seed ever writes: `E-2` followed by three digits. */
const CODE_SUFFIX_SHAPE = /^E-2(\d{3})$/u;

async function nextCodeStart(client: PoolClient): Promise<number> {
  const result = await client.query<{ code: string }>(
    "SELECT code FROM employees WHERE code LIKE $1",
    [`${CODE_PREFIX}%`],
  );
  let max = 0;
  for (const row of result.rows) {
    const match = CODE_SUFFIX_SHAPE.exec(row.code);
    if (match !== null) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

function buildFixtureEmployees(startNumber: number): EmployeeWriteInput[] {
  return FIXTURE_PEOPLE.map((person, index) => {
    const number = startNumber + index;
    const code = `${CODE_PREFIX}${String(number).padStart(3, "0")}`;
    // The batch number rides in the local part so a `--force` append can never collide with an
    // earlier run's emails, whatever names repeat.
    const localPart = `${person.firstName}.${person.lastName}.${number}`.toLowerCase();
    return {
      code,
      full_name: `${person.firstName} ${person.lastName}`,
      work_email: `${localPart}@example.test`,
      title: person.title,
      department: person.department,
      start_date: person.startDate,
    };
  });
}

interface FixtureLeaveRequest {
  readonly employeeIndex: number;
  readonly kind: LeaveKind;
  readonly start_date: string;
  readonly end_date: string;
  readonly cancel: boolean;
}

/**
 * Six employees get three requests, six get two: 18 + 12 = 30. Each employee's own requests land
 * in distinct months (`FIRST_MONDAYS` indices never repeat within one employee's `j` loop, since
 * `j` only ever takes 3 consecutive values out of 9), so no employee ever holds two overlapping
 * ranges — `insertLeaveRequest` itself carries no overlap guard, unlike the web submit path.
 */
function buildFixtureLeaveRequests(): FixtureLeaveRequest[] {
  const requests: FixtureLeaveRequest[] = [];
  const weekdayCycle: readonly (1 | 3 | 5)[] = [1, 3, 5];
  for (let employeeIndex = 0; employeeIndex < FIXTURE_PEOPLE.length; employeeIndex += 1) {
    const count = employeeIndex < 6 ? 3 : 2;
    for (let j = 0; j < count; j += 1) {
      const globalIndex = requests.length;
      const monthIndex = (employeeIndex + j) % FIRST_MONDAYS.length;
      const weekdays = weekdayCycle[(employeeIndex + j) % weekdayCycle.length] as 1 | 3 | 5;
      const range = weekRange(FIRST_MONDAYS[monthIndex] as string, weekdays);
      requests.push({
        employeeIndex,
        kind: globalIndex % 2 === 0 ? "annual" : "personal",
        ...range,
        cancel: globalIndex % 2 === 1,
      });
    }
  }
  return requests;
}

export interface SeedDemoInput {
  readonly force: boolean;
  readonly correlationId: string;
}

export interface SeedDemoResult {
  readonly employeesCreated: number;
  readonly leaveRequestsCreated: number;
  readonly leaveRequestsCancelled: number;
  readonly startingCode: string;
}

async function auditSeedRow(
  client: PoolClient,
  objectType: "employee" | "leave_request",
  objectId: string,
  correlationId: string,
): Promise<void> {
  await insertAuditEvent(client, {
    actorAccountId: SEED_SYSTEM_ACTOR_ID,
    objectType,
    objectId,
    action: "seed",
    outcome: "ok",
    correlationId,
  });
}

/**
 * Seeds `~12` fictional employees and `~30` leave requests (`pending`/`cancelled` only — see this
 * file's header). Refuses outright when `employees` already holds any row, unless `force` is
 * set, in which case it appends a fresh batch with unique codes and emails rather than touching
 * what is already there. Writes no account, no password, and no `leave.submit`/`leave.cancel`
 * audit row: every row this seeds is attributed to `SEED_SYSTEM_ACTOR_ID` with action `seed`.
 */
export async function seedDemo(pool: Pool, input: SeedDemoInput): Promise<SeedDemoResult> {
  if (!input.force) {
    const existing = await withClient(pool, async (client) => countEmployees(client));
    if (existing > 0) {
      throw new ProvisioningError(
        "not_empty",
        "employees already exist: pass --force to append a fresh batch, or use `reset-demo`-style cleanup on a scratch database",
      );
    }
  }

  return withTransaction(pool, async (client) => {
    if (!input.force) {
      const existing = await countEmployees(client);
      if (existing > 0) {
        throw new ProvisioningError(
          "not_empty",
          "employees already exist: pass --force to append a fresh batch, or use `reset-demo`-style cleanup on a scratch database",
        );
      }
    }

    const startNumber = await nextCodeStart(client);
    const employeeFixtures = buildFixtureEmployees(startNumber);
    const employeeIds: string[] = [];
    for (const fixture of employeeFixtures) {
      const id = await insertEmployee(client, fixture);
      employeeIds.push(id);
      await auditSeedRow(client, "employee", id, input.correlationId);
    }

    const leaveFixtures = buildFixtureLeaveRequests();
    let cancelled = 0;
    for (const fixture of leaveFixtures) {
      const employeeId = employeeIds[fixture.employeeIndex] as string;
      const id = await insertLeaveRequest(client, {
        employeeId,
        kind: fixture.kind,
        startDate: fixture.start_date,
        endDate: fixture.end_date,
      });
      if (fixture.cancel) {
        const changed = await cancelLeaveRequest(client, id, 1);
        if (changed !== 1) {
          throw new Error(`seed-demo: could not cancel its own freshly inserted request ${id}`);
        }
        cancelled += 1;
      }
      await auditSeedRow(client, "leave_request", id, input.correlationId);
    }

    return {
      employeesCreated: employeeFixtures.length,
      leaveRequestsCreated: leaveFixtures.length,
      leaveRequestsCancelled: cancelled,
      startingCode: employeeFixtures[0]?.code ?? "",
    };
  });
}

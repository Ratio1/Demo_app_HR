import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseFields } from "../../src/server/http/forms.ts";
import {
  LEAVE_KINDS,
  LEAVE_RANGE_MESSAGE_FIELD,
  countLeaveWeekdays,
  leaveCancelSchema,
  leaveCreateSchema,
  leaveDecisionSchema,
  savedLeaveLocation,
  toApproval,
  toOwnLeave,
  type ApprovalRecord,
  type LeaveRequestRecord,
} from "../../src/server/dto/leave.ts";
import { LEAVE_RANGE_MESSAGES } from "../../src/shared/dates.ts";

/**
 * The leave contract, checked at the boundary the routes actually use: `parseFields` against the
 * three schemas, and the two projections (spec §2, §6 S4). Everything here is pure — no database,
 * no Next.js — so it runs in the unit project and under the TZ matrix with it.
 */

const CSRF = "csrf-token-value";
const EMPLOYEE_ID = "11111111-1111-4111-8111-111111111111";

function createBody(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    kind: "annual",
    start_date: "2026-09-22",
    end_date: "2026-09-24",
    csrf: CSRF,
    ...overrides,
  };
}

function leaveRecord(overrides: Partial<LeaveRequestRecord> = {}): LeaveRequestRecord {
  return {
    id: randomUUID(),
    employee_id: EMPLOYEE_ID,
    kind: "annual",
    start_date: "2026-09-22",
    end_date: "2026-09-24",
    status: "pending",
    decided_at: null,
    created_at: new Date("2026-09-20T08:30:00.000Z"),
    version: 1,
    ...overrides,
  };
}

function approvalRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    ...leaveRecord(),
    employee_code: "E-7001",
    employee_full_name: "Cy Staff",
    employee_department: "People",
    ...overrides,
  };
}

describe("leaveCreateSchema", () => {
  it("accepts the three fields and the token, and trims the dates", () => {
    const parsed = parseFields(leaveCreateSchema, createBody({ start_date: " 2026-09-22 " }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        kind: "annual",
        start_date: "2026-09-22",
        end_date: "2026-09-24",
        csrf: CSRF,
      });
    }
  });

  it("accepts both kinds and nothing else (spec §2: no medical category)", () => {
    for (const kind of LEAVE_KINDS) {
      expect(parseFields(leaveCreateSchema, createBody({ kind })).ok).toBe(true);
    }
    for (const kind of ["sick", "medical", "ANNUAL", "", "annual "]) {
      const parsed = parseFields(leaveCreateSchema, createBody({ kind }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok && parsed.reason === "invalid") {
        expect(parsed.fields.kind).toBeTruthy();
      }
    }
  });

  for (const key of [
    "reason",
    "note",
    "comment",
    "employee_id",
    "status",
    "decided_by",
    "decided_at",
    "weekdays",
    "version",
    "id",
    "created_at",
  ]) {
    it(`refuses an over-posted ${key} with no detail`, () => {
      const parsed = parseFields(leaveCreateSchema, createBody({ [key]: "x" }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toBe("unknown_key");
      }
    });
  }

  it("refuses a date that is not a real calendar date, on its own field", () => {
    const parsed = parseFields(leaveCreateSchema, createBody({ start_date: "2026-02-30" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.reason === "invalid") {
      expect(parsed.fields.start_date).toBe(LEAVE_RANGE_MESSAGES.invalid_start);
      // The cross-field rule must not add a second, misleading message while a date is malformed.
      expect(parsed.fields[LEAVE_RANGE_MESSAGE_FIELD]).toBeUndefined();
    }
  });

  it("refuses an inverted range on end_date", () => {
    const parsed = parseFields(
      leaveCreateSchema,
      createBody({ start_date: "2026-09-24", end_date: "2026-09-22" }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.reason === "invalid") {
      expect(parsed.fields.end_date).toBe(LEAVE_RANGE_MESSAGES.end_before_start);
    }
  });

  it("refuses a weekend-only range on end_date (≥1 weekday, spec §2)", () => {
    const parsed = parseFields(
      leaveCreateSchema,
      createBody({ start_date: "2026-09-26", end_date: "2026-09-27" }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.reason === "invalid") {
      expect(parsed.fields.end_date).toBe(LEAVE_RANGE_MESSAGES.no_weekday);
    }
  });

  it("requires the csrf field", () => {
    const body = createBody();
    delete body.csrf;
    expect(parseFields(leaveCreateSchema, body).ok).toBe(false);
  });
});

describe("leaveCancelSchema and leaveDecisionSchema", () => {
  it("take a positive integer version from either encoding", () => {
    const parsed = parseFields(leaveCancelSchema, { version: "3", csrf: CSRF });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.version).toBe(3);
    }
  });

  for (const version of ["0", "-1", "1.5", "", " ", "01", "9999999999", "abc"]) {
    it(`refuses the version ${JSON.stringify(version)}`, () => {
      expect(parseFields(leaveCancelSchema, { version, csrf: CSRF }).ok).toBe(false);
    });
  }

  it("refuses a status or decided_by smuggled into a cancel", () => {
    const parsed = parseFields(leaveCancelSchema, {
      version: "1",
      csrf: CSRF,
      status: "approved",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("unknown_key");
    }
  });

  it("accepts only approve and reject as a decision", () => {
    for (const action of ["approve", "reject"]) {
      expect(parseFields(leaveDecisionSchema, { action, version: "1", csrf: CSRF }).ok).toBe(true);
    }
    for (const action of ["cancel", "approved", "delete", ""]) {
      expect(parseFields(leaveDecisionSchema, { action, version: "1", csrf: CSRF }).ok).toBe(false);
    }
  });

  it("refuses a decided_by chosen by the caller", () => {
    const parsed = parseFields(leaveDecisionSchema, {
      action: "approve",
      version: "1",
      csrf: CSRF,
      decided_by: randomUUID(),
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("unknown_key");
    }
  });
});

describe("the projections", () => {
  it("gives the owner their own fields and never decided_by", () => {
    const decidedAt = new Date("2026-09-21T10:00:00.000Z");
    const dto = toOwnLeave(leaveRecord({ status: "approved", decided_at: decidedAt, version: 2 }));
    expect(Object.keys(dto).sort()).toEqual([
      "decided_at",
      "end_date",
      "id",
      "kind",
      "start_date",
      "status",
      "version",
      "weekdays",
    ]);
    expect(dto.decided_at).toBe("2026-09-21T10:00:00.000Z");
    expect(dto.weekdays).toBe(3);
    expect(dto.status).toBe("approved");
    expect(JSON.stringify(dto)).not.toContain("decided_by");
    expect(JSON.stringify(dto)).not.toContain(EMPLOYEE_ID);
  });

  it("leaves decided_at null while a request is pending", () => {
    expect(toOwnLeave(leaveRecord()).decided_at).toBeNull();
  });

  it("keeps the dates as the strings the database wrote", () => {
    const dto = toOwnLeave(leaveRecord());
    expect(dto.start_date).toBe("2026-09-22");
    expect(typeof dto.start_date).toBe("string");
    expect(typeof dto.end_date).toBe("string");
  });

  it("marks an approval as the viewer's own only for their own employee record", () => {
    const record = approvalRecord();
    expect(toApproval(record, EMPLOYEE_ID).own).toBe(true);
    expect(toApproval(record, "22222222-2222-4222-8222-222222222222").own).toBe(false);
    expect(toApproval(record, null).own).toBe(false);
  });

  it("gives an approver three employee fields and no work email", () => {
    const dto = toApproval(approvalRecord(), null);
    expect(Object.keys(dto.employee).sort()).toEqual(["code", "department", "full_name"]);
    expect(JSON.stringify(dto)).not.toContain("@");
    expect(JSON.stringify(dto)).not.toContain("decided_by");
    expect(dto.created_at).toBe("2026-09-20T08:30:00.000Z");
    expect(dto.weekdays).toBe(3);
  });

  it("derives the weekday count rather than trusting a stored one", () => {
    expect(countLeaveWeekdays("2026-09-26", "2026-09-27")).toBe(0);
    expect(countLeaveWeekdays("2026-09-21", "2026-09-25")).toBe(5);
    expect(countLeaveWeekdays("not-a-date", "2026-09-25")).toBe(0);
  });
});

describe("savedLeaveLocation", () => {
  it("sends the owner back to /leave and the approver to /approvals", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(savedLeaveLocation(id, "submitted")).toBe(`/leave?id=${id}&saved=submitted`);
    expect(savedLeaveLocation(id, "cancelled")).toBe(`/leave?id=${id}&saved=cancelled`);
    expect(savedLeaveLocation(id, "approved")).toBe(`/approvals?id=${id}&saved=approved`);
    expect(savedLeaveLocation(id, "rejected")).toBe(`/approvals?id=${id}&saved=rejected`);
  });

  it("escapes the id, so a crafted one cannot steer the navigation", () => {
    expect(savedLeaveLocation("../../evil?x=1", "submitted")).toBe(
      "/leave?id=..%2F..%2Fevil%3Fx%3D1&saved=submitted",
    );
  });
});

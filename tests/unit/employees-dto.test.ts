import { describe, expect, it } from "vitest";

import {
  CODE_MAX_LENGTH,
  NAME_MAX_LENGTH,
  codePointLength,
  employeeCreateSchema,
  employeeStatusSchema,
  employeeUpdateSchema,
  isIsoDateString,
  normalizeWorkEmail,
  projectDirectory,
  savedLocation,
  toDirectoryEntry,
  toHrDirectoryEntry,
  toHrEmployee,
  toOwnProfile,
  type EmployeeRecord,
} from "../../src/server/dto/employees.ts";
import { formToObject, jsonToFields, parseFields } from "../../src/server/http/forms.ts";

/**
 * The projection tables and the strict schemas of `src/server/dto/employees.ts`, with no
 * database (spec §3 "field-allowlisted DTOs", §6 S4). Every address is fictional.
 *
 * The point of the first block is **absence**: a DTO's key set is asserted exactly, so a field
 * added to the row shape later cannot reach a caller by being forgotten here.
 */
const LINKED: EmployeeRecord = {
  id: "8b1f0d4e-3a2c-4f6b-9c7d-0e1a2b3c4d5e",
  code: "E-1001",
  full_name: "Cy Staff",
  work_email: "cy.staff@example.test",
  title: "Analyst",
  department: "Operations",
  start_date: "2026-01-05",
  active: true,
  account_id: "11111111-2222-3333-4444-555555555555",
  account_email: "cy.staff@example.test",
  version: 3,
};

const UNLINKED: EmployeeRecord = {
  ...LINKED,
  id: "9c2e1f5a-4b3d-4a7c-8d6e-1f2a3b4c5d6f",
  code: "E-1002",
  full_name: "Dee Newcomer",
  work_email: "dee.newcomer@example.test",
  department: "Finance",
  active: false,
  account_id: null,
  account_email: null,
};

function csrf(): string {
  return "c".repeat(43);
}

const VALID_CREATE = {
  code: "E-2001",
  full_name: "Eli Fixture",
  work_email: "Eli.Fixture@Example.Test",
  title: "Coordinator",
  department: "People",
  start_date: "2026-03-02",
  csrf: csrf(),
};

describe("employee projections", () => {
  it("gives HR the minimal fields and the link as a flag plus an email, never an account id", () => {
    const dto = toHrEmployee(LINKED);
    expect(Object.keys(dto).sort()).toEqual(
      [
        "active",
        "code",
        "department",
        "full_name",
        "id",
        "link",
        "start_date",
        "title",
        "version",
        "work_email",
      ].sort(),
    );
    expect(dto.link).toEqual({ linked: true, email: "cy.staff@example.test" });
    expect(JSON.stringify(dto)).not.toContain(LINKED.account_id as string);
  });

  it("reports an unlinked record as linked:false with no email at all", () => {
    expect(toHrEmployee(UNLINKED).link).toEqual({ linked: false });
  });

  it("gives an employee exactly four directory fields", () => {
    expect(Object.keys(toDirectoryEntry(LINKED)).sort()).toEqual([
      "department",
      "full_name",
      "title",
      "work_email",
    ]);
  });

  it("gives HR the same four plus the code and the status", () => {
    expect(Object.keys(toHrDirectoryEntry(LINKED)).sort()).toEqual([
      "active",
      "code",
      "department",
      "full_name",
      "title",
      "work_email",
    ]);
  });

  it("gives /me the own-profile fields without version or link", () => {
    const own = toOwnProfile(LINKED);
    expect(Object.keys(own).sort()).toEqual([
      "active",
      "code",
      "department",
      "full_name",
      "start_date",
      "title",
      "work_email",
    ]);
    expect(own).not.toHaveProperty("version");
    expect(own).not.toHaveProperty("link");
  });

  it("splits the directory by role and never mixes the two shapes", () => {
    const asEmployee = projectDirectory("employee", [LINKED]);
    const asHr = projectDirectory("hr_admin", [LINKED]);
    expect(asEmployee.role).toBe("employee");
    expect(asHr.role).toBe("hr_admin");
    expect(asEmployee.entries[0]).not.toHaveProperty("code");
    expect(asHr.entries[0]).toHaveProperty("code");
  });

  it("builds the saved location from the id it is given, percent-encoded", () => {
    expect(savedLocation(LINKED.id, "created")).toBe(`/employees?id=${LINKED.id}&saved=created`);
    expect(savedLocation("a b&c=d", "status")).toBe("/employees?id=a%20b%26c%3Dd&saved=status");
  });
});

describe("ISO date strings", () => {
  it("accepts real calendar dates", () => {
    for (const value of ["2026-01-01", "2026-12-31", "2024-02-29", "2000-02-29"]) {
      expect(isIsoDateString(value)).toBe(true);
    }
  });

  it("rejects impossible days, the wrong shape and a non-leap 29 February", () => {
    for (const value of [
      "2026-02-29",
      "2100-02-29",
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "2026-1-5",
      "26-01-05",
      "2026/01/05",
      "2026-01-05T00:00:00Z",
      "",
      " 2026-01-05",
    ]) {
      expect(isIsoDateString(value), value).toBe(false);
    }
  });
});

describe("normalization helpers", () => {
  it("lowercases and trims a work email", () => {
    expect(normalizeWorkEmail("  Ada.First@Example.TEST ")).toBe("ada.first@example.test");
  });

  it("counts code points, not UTF-16 units, so the bound matches the database CHECK", () => {
    expect(codePointLength("ab")).toBe(2);
    expect(codePointLength("𝑨𝑩")).toBe(2);
    expect("𝑨𝑩".length).toBe(4);
  });
});

describe("the create schema", () => {
  it("accepts a valid body, trimming text and lowercasing the work email", () => {
    const parsed = employeeCreateSchema.safeParse({
      ...VALID_CREATE,
      full_name: "  Eli Fixture  ",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.full_name).toBe("Eli Fixture");
    expect(parsed.data?.work_email).toBe("eli.fixture@example.test");
    expect(parsed.data?.start_date).toBe("2026-03-02");
  });

  for (const key of ["account_id", "role", "id", "created_at", "active", "version", "nonsense"]) {
    it(`refuses an over-posted ${key} as an unknown key, never dropping it`, () => {
      const parsed = parseFields(employeeCreateSchema, { ...VALID_CREATE, [key]: "x" });
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.reason).toBe("unknown_key");
    });
  }

  it("bounds every text field in code points and names the field in the message", () => {
    const parsed = parseFields(employeeCreateSchema, {
      ...VALID_CREATE,
      code: "C".repeat(CODE_MAX_LENGTH + 1),
      full_name: "N".repeat(NAME_MAX_LENGTH + 1),
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok === false && parsed.reason === "invalid") {
      expect(Object.keys(parsed.fields).sort()).toEqual(["code", "full_name"]);
      expect(parsed.fields.code).toContain("32");
      expect(parsed.fields.full_name).toContain("160");
    } else {
      throw new Error("expected per-field errors");
    }
  });

  it("accepts a name of exactly 160 astral code points", () => {
    const parsed = employeeCreateSchema.safeParse({
      ...VALID_CREATE,
      full_name: "𝑨".repeat(NAME_MAX_LENGTH),
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a blank field after trimming, and a missing one, with a usable message", () => {
    const blank = parseFields(employeeCreateSchema, { ...VALID_CREATE, title: "   " });
    expect(blank.ok === false && blank.reason === "invalid" && blank.fields.title).toContain(
      "required",
    );
    const missing = parseFields(employeeCreateSchema, {
      code: VALID_CREATE.code,
      full_name: VALID_CREATE.full_name,
      work_email: VALID_CREATE.work_email,
      title: VALID_CREATE.title,
      department: VALID_CREATE.department,
      csrf: csrf(),
    });
    expect(
      missing.ok === false && missing.reason === "invalid" && missing.fields.start_date,
    ).toContain("required");
  });

  it("refuses a start date that is not a real calendar date or is outside the sanity window", () => {
    for (const start_date of ["2026-02-30", "1899-12-31", "2101-01-01"]) {
      const parsed = parseFields(employeeCreateSchema, { ...VALID_CREATE, start_date });
      expect(parsed.ok, start_date).toBe(false);
      expect(parsed.ok === false && parsed.reason).toBe("invalid");
    }
  });

  it("refuses a work email without an @ and a dot", () => {
    const parsed = parseFields(employeeCreateSchema, { ...VALID_CREATE, work_email: "not-email" });
    expect(parsed.ok === false && parsed.reason === "invalid" && parsed.fields.work_email).toBeTruthy();
  });
});

describe("the update and status schemas", () => {
  it("requires a positive integer version on an edit", () => {
    const ok = employeeUpdateSchema.safeParse({ ...VALID_CREATE, version: "7" });
    expect(ok.success && ok.data.version).toBe(7);
    for (const version of ["0", "-1", "1.5", "abc", "", " "]) {
      expect(employeeUpdateSchema.safeParse({ ...VALID_CREATE, version }).success, version).toBe(
        false,
      );
    }
  });

  it("takes only activate or deactivate, and takes no `active` field at all", () => {
    expect(
      employeeStatusSchema.safeParse({ action: "deactivate", version: "2", csrf: csrf() }).success,
    ).toBe(true);
    expect(
      employeeStatusSchema.safeParse({ action: "delete", version: "2", csrf: csrf() }).success,
    ).toBe(false);
    const overPost = parseFields(employeeStatusSchema, {
      action: "activate",
      version: "2",
      active: "true",
      csrf: csrf(),
    });
    expect(overPost.ok === false && overPost.reason).toBe("unknown_key");
  });
});

describe("body flattening", () => {
  it("turns JSON scalars into the same strings a form would have sent", () => {
    expect(jsonToFields({ action: "activate", version: 4, flag: true })).toEqual({
      action: "activate",
      version: "4",
      flag: "true",
    });
  });

  it("refuses anything that is not a flat object of scalars", () => {
    for (const value of [
      null,
      [],
      "string",
      42,
      { nested: { a: 1 } },
      { list: [1] },
      { missing: null },
      { infinite: Number.POSITIVE_INFINITY },
    ]) {
      expect(jsonToFields(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("keeps a __proto__ key visible so the strict schema can refuse it", () => {
    const fields = jsonToFields(JSON.parse('{"__proto__":"x","code":"E-1"}')) as Record<
      string,
      string
    >;
    expect(Object.keys(fields)).toContain("__proto__");
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    const parsed = parseFields(employeeCreateSchema, { ...VALID_CREATE, ...fields });
    expect(parsed.ok === false && parsed.reason).toBe("unknown_key");
  });

  it("refuses a form field sent twice rather than taking one of the two", () => {
    expect(formToObject(new URLSearchParams("code=A&code=B"))).toBeNull();
    expect(formToObject(new URLSearchParams("code=A&full_name=B"))).toEqual({
      code: "A",
      full_name: "B",
    });
  });

  it("keeps a __proto__ form field as an own property too", () => {
    const fields = formToObject(new URLSearchParams("__proto__=x&code=A")) as Record<
      string,
      string
    >;
    expect(Object.keys(fields)).toContain("__proto__");
  });
});

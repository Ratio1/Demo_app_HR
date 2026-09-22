import { describe, expect, it } from "vitest";

import { DATE_OID, registeredDateParser } from "../../src/server/db/pool.js";

/**
 * Spec §2: SQL DATE values stay ISO date strings end to end. The driver's default parser
 * turns them into JS Date objects at local midnight, which shifts the day in half the
 * world's time zones; importing the pool module must replace it.
 */
describe("DATE type parser", () => {
  it("is registered for OID 1082 and returns the string untouched", () => {
    const parse = registeredDateParser();
    for (const value of ["2026-03-01", "2026-12-31", "1999-01-01"]) {
      const parsed = parse(value);
      expect(typeof parsed).toBe("string");
      expect(parsed).toBe(value);
    }
  });

  it("uses the PostgreSQL DATE oid", () => {
    expect(DATE_OID).toBe(1082);
  });
});

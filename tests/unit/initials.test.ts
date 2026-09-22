import { describe, expect, it } from "vitest";

import { initials } from "../../src/app/_lib/initials.js";

describe("initials", () => {
  it("takes the first letter of the first and last word", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
  });

  it("uses only the first and last word for a three-part name", () => {
    expect(initials("Mary Jane Watson")).toBe("MW");
  });

  it("falls back to the first two characters of a single-word name", () => {
    expect(initials("Cher")).toBe("CH");
  });

  it("collapses repeated internal whitespace", () => {
    expect(initials("  Grace   Hopper  ")).toBe("GH");
  });

  it("returns an empty string for an empty name rather than throwing", () => {
    expect(initials("")).toBe("");
    expect(initials("   ")).toBe("");
  });

  it("uppercases lowercase input", () => {
    expect(initials("ada lovelace")).toBe("AL");
  });
});

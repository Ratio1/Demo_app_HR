import { describe, expect, it } from "vitest";

import { ConfigError, DEFAULT_DB_PORT, loadDbConfig } from "../../src/server/config/env.js";

/**
 * A value that must never reach a message, a log line or a stack: every failing case below
 * carries it as DB_PASSWORD and asserts it does not appear in what the loader throws.
 */
const SENTINEL = "SENTINEL-not-a-real-secret";

function env(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = {
    DB_SERVER: "db.example.test",
    DB_USER: "hr_app",
    DB_PASSWORD: SENTINEL,
    DB_NAME: "hr",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }
  return base;
}

function failure(overrides: Record<string, string | undefined>): ConfigError {
  let thrown: unknown;
  try {
    loadDbConfig(env(overrides));
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected loadDbConfig to refuse this environment").toBeInstanceOf(ConfigError);
  return thrown as ConfigError;
}

describe("host and port resolution", () => {
  it("defaults to 5432 when DB_SERVER carries no port", () => {
    const config = loadDbConfig(env({ DB_SERVER: "db.example.test" }));
    expect(config.host).toBe("db.example.test");
    expect(config.port).toBe(DEFAULT_DB_PORT);
  });

  it("takes the port out of DB_SERVER", () => {
    const config = loadDbConfig(env({ DB_SERVER: "db.example.test:26257" }));
    expect(config.host).toBe("db.example.test");
    expect(config.port).toBe(26257);
  });

  it("uses DB_PORT when DB_SERVER carries no port", () => {
    const config = loadDbConfig(env({ DB_SERVER: "db.example.test", DB_PORT: "26257" }));
    expect(config.port).toBe(26257);
  });

  it("accepts DB_PORT that agrees with DB_SERVER", () => {
    const config = loadDbConfig(env({ DB_SERVER: "db.example.test:5432", DB_PORT: "5432" }));
    expect(config.port).toBe(5432);
  });

  it("refuses a DB_PORT that contradicts DB_SERVER", () => {
    const error = failure({ DB_SERVER: "db.example.test:5432", DB_PORT: "26257" });
    expect(error.message).toContain("DB_SERVER carries port 5432 but DB_PORT is 26257");
  });

  it("accepts a bracketed IPv6 literal with and without a port", () => {
    expect(loadDbConfig(env({ DB_SERVER: "[::1]" }))).toMatchObject({
      host: "::1",
      port: DEFAULT_DB_PORT,
    });
    expect(loadDbConfig(env({ DB_SERVER: "[2001:db8::1]:26257" }))).toMatchObject({
      host: "2001:db8::1",
      port: 26257,
    });
  });

  it("refuses an unbracketed IPv6 literal instead of guessing where the port is", () => {
    expect(failure({ DB_SERVER: "::1" }).message).toContain("bracket it");
    expect(failure({ DB_SERVER: "2001:db8::1:5432" }).message).toContain("bracket it");
  });

  it("refuses a URL, a path or a userinfo prefix", () => {
    expect(failure({ DB_SERVER: "postgres://db.example.test:5432/hr" }).message).toContain(
      "not a URL",
    );
    expect(failure({ DB_SERVER: "db.example.test/hr" }).message).toContain("not a URL");
    expect(failure({ DB_SERVER: "hr_app@db.example.test" }).message).toContain("not a URL");
  });

  it("refuses ports outside 1-65535 and non-numeric ports", () => {
    for (const port of ["0", "65536", "abc", "54 32", "-1", "5432.0"]) {
      expect(failure({ DB_PORT: port }).problems.join(" ")).toMatch(/DB_PORT/);
    }
    expect(failure({ DB_SERVER: "db.example.test:0" }).message).toContain("the port in DB_SERVER");
    expect(failure({ DB_SERVER: "db.example.test:" }).message).toContain("names no port");
  });

  it("refuses whitespace in DB_SERVER", () => {
    expect(failure({ DB_SERVER: " db.example.test" }).message).toContain("whitespace");
  });
});

describe("empty is not the same as unset", () => {
  it("distinguishes the two for every required variable", () => {
    for (const name of ["DB_SERVER", "DB_USER", "DB_PASSWORD", "DB_NAME"]) {
      expect(failure({ [name]: undefined }).problems).toContain(`${name} is not set`);
      expect(failure({ [name]: "" }).problems).toContain(`${name} is set but empty`);
    }
  });

  it("treats an empty DB_PORT as a mistake, not as unset", () => {
    expect(failure({ DB_PORT: "" }).message).toContain("DB_PORT is set but empty");
    expect(loadDbConfig(env({ DB_PORT: undefined })).port).toBe(DEFAULT_DB_PORT);
  });

  it("reports every missing variable at once", () => {
    const error = failure({ DB_SERVER: undefined, DB_USER: undefined, DB_NAME: "" });
    expect(error.problems).toHaveLength(3);
  });
});

describe("the password is handled but never shown", () => {
  it("is preserved byte for byte, spaces and all", () => {
    const password = "  a pass phrase with spaces and ünicode ✓  ";
    expect(loadDbConfig(env({ DB_PASSWORD: password })).password).toBe(password);
  });

  it("never appears in a refusal message", () => {
    const cases: Record<string, string | undefined>[] = [
      { DB_SERVER: undefined },
      { DB_SERVER: "" },
      { DB_SERVER: "postgres://db.example.test/hr" },
      { DB_SERVER: "::1" },
      { DB_SERVER: "db.example.test:5432", DB_PORT: "26257" },
      { DB_PORT: "" },
      { DB_PORT: "abc" },
      { DB_USER: undefined },
      { DB_NAME: "" },
    ];
    for (const overrides of cases) {
      const error = failure(overrides);
      const text = `${error.message} ${error.problems.join(" ")} ${error.stack ?? ""}`;
      expect(text).not.toContain(SENTINEL);
    }
  });
});

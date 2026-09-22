import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { createPool, readCaCertificate, withClient } from "../../src/server/db/pool.js";
import { APP_ENV_FILE, testConfig } from "./helpers.js";

/**
 * The TLS shape proven by spike S0 from inside the container, asserted here from the test
 * runner: the connection verifies against the bundled CA, a different CA is refused, and the
 * pool's bounded timeouts actually reach the server.
 */
const appConfig = testConfig(APP_ENV_FILE);
const appPool = createPool(appConfig);

// A real CA bundle that did not sign the dev server's certificate.
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const TLS_CHAIN_FAILURES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

afterAll(async () => {
  await appPool.end();
});

describe("the pool's TLS", () => {
  it("connects as the runtime role with the connection encrypted", async () => {
    const row = await withClient(appPool, async (client) => {
      const result = await client.query<{
        current_user: string;
        ssl: boolean;
        version: string | null;
      }>(
        `SELECT current_user, s.ssl, s.version
           FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()`,
      );
      return result.rows[0];
    });
    expect(row?.current_user).toBe(appConfig.user);
    expect(row?.ssl).toBe(true);
    expect(row?.version).toMatch(/^TLSv1\.[23]$/);
  });

  it("refuses the same server when the CA does not sign its certificate", async () => {
    if (!existsSync(SYSTEM_CA_BUNDLE)) {
      // Nothing to test against on a machine without a system trust store.
      return;
    }
    const wrongCaPool = createPool(appConfig, SYSTEM_CA_BUNDLE);
    try {
      let code: string | undefined;
      try {
        await withClient(wrongCaPool, async (client) => client.query("SELECT 1"));
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code, "the connection must not succeed against the wrong CA").toBeDefined();
      expect(TLS_CHAIN_FAILURES.has(code as string)).toBe(true);
    } finally {
      await wrongCaPool.end();
    }
  });

  it("says where the CA belongs when it is missing", () => {
    expect(() => readCaCertificate("certs/not-here.crt")).toThrowError(/certs\/not-here\.crt/);
  });

  it("applies the bounded statement timeout on every connection", async () => {
    const timeout = await withClient(appPool, async (client) => {
      const result = await client.query<{ statement_timeout: string }>("SHOW statement_timeout");
      return result.rows[0]?.statement_timeout;
    });
    expect(timeout).toBe("10s");
  });

  it("hands DATE values to the application as ISO strings, not JS dates", async () => {
    const value = await withClient(appPool, async (client) => {
      const result = await client.query<{ d: unknown }>("SELECT DATE '2026-03-01' AS d");
      return result.rows[0]?.d;
    });
    expect(typeof value).toBe("string");
    expect(value).toBe("2026-03-01");
  });
});

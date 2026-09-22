/**
 * `manage` - the maintenance CLI (spec §4). It runs once, outside serving, with the
 * maintenance role's credentials in the same five environment variables the server uses.
 *
 * Compiled by tsconfig.cli.json to dist/cli/manage.mjs and run as
 * `node dist/cli/manage.mjs <command>`. It shares src/server/** with the Next server, which
 * is why nothing under src/server/** may import `server-only` (ruling O1).
 *
 * Slice 1 part A ships `migrate`; the account commands are added alongside it.
 * No password is ever accepted as an argument, printed, or logged.
 */
import { ConfigError, loadDbConfig } from "../server/config/env.js";
import { deriveAppRole, runMigrations, verifySchema } from "../server/db/migrate.js";
import { createPool } from "../server/db/pool.js";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

type Command = (args: readonly string[]) => Promise<number>;

function usage(): void {
  console.error("usage: node dist/cli/manage.mjs <command>");
  console.error("");
  console.error("commands:");
  console.error("  migrate    apply pending migrations from migrations/ (safe to re-run)");
  console.error("");
  console.error(
    "Credentials come from DB_SERVER, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME; migrations need the '_owner' role.",
  );
}

const migrate: Command = async (args) => {
  if (args.length > 0) {
    console.error("migrate takes no arguments");
    return EXIT_USAGE;
  }

  const config = loadDbConfig();
  const appRole = deriveAppRole(config.user);
  const pool = createPool(config);
  try {
    const result = await runMigrations(pool, {
      appRole,
      log: (line) => {
        console.log(`migrate: ${line}`);
      },
    });
    console.log(
      `migrate: ${result.applied.length} applied, ${result.alreadyApplied.length} already present`,
    );

    const report = await verifySchema(pool, appRole);
    if (!report.ok) {
      for (const table of report.missingTables) {
        console.error(`migrate: postcondition failed - table ${table} is missing`);
      }
      for (const grant of report.missingGrants) {
        console.error(`migrate: postcondition failed - ${appRole} is missing ${grant}`);
      }
      for (const grant of report.unexpectedGrants) {
        console.error(`migrate: postcondition failed - ${appRole} unexpectedly holds ${grant}`);
      }
      return EXIT_FAILED;
    }
    console.log(
      `migrate: postconditions verified - ${result.applied.length + result.alreadyApplied.length} migration(s) journalled, grants for ${appRole} exact`,
    );
    return EXIT_OK;
  } finally {
    await pool.end();
  }
};

const COMMANDS: Readonly<Record<string, Command>> = { migrate };

export async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    usage();
    return name === undefined ? EXIT_USAGE : EXIT_OK;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    console.error(`unknown command '${name}'`);
    usage();
    return EXIT_USAGE;
  }
  return command(args);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Configuration problems name the variable at fault and never its value; anything else
    // is reported by message only, so no connection string or row reaches the log.
    const message =
      error instanceof ConfigError || error instanceof Error ? error.message : "command failed";
    console.error(`manage: ${message}`);
    process.exitCode = error instanceof ConfigError ? EXIT_USAGE : EXIT_FAILED;
  });

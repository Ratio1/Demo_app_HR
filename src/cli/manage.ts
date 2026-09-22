/**
 * `manage` - the maintenance CLI (spec §4). It runs once, outside serving, with the
 * maintenance role's credentials in the same five environment variables the server uses.
 *
 * Compiled by tsconfig.cli.json to dist/cli/manage.mjs and run as
 * `node dist/cli/manage.mjs <command>`. It shares src/server/** with the Next server, which
 * is why nothing under src/server/** may import `server-only` (ruling O1). Every account
 * command calls the same service and repository functions the web layer calls - in particular
 * `disableAccount`, whose last-active-HR-admin re-count therefore protects the CLI too.
 *
 * No password is ever accepted as an argument, printed, or logged: they are read from a hidden
 * prompt on an interactive terminal and from nowhere else.
 */
import { ConfigError, loadDbConfig } from "../server/config/env.ts";
import { deriveAppRole, runMigrations, verifySchema } from "../server/db/migrate.ts";
import { createPool } from "../server/db/pool.ts";
import { ACCOUNT_ROLES, type AccountRole } from "../server/repos/accounts.ts";
import { newCorrelationId } from "../server/repos/audit.ts";
import {
  ProvisioningError,
  bootstrap,
  createUser,
  currentOrigin,
  disableUser,
  resetPassword,
  setOrigin,
} from "../server/services/accounts.ts";
import { PromptError, askNewPassword, createPrompter, type Prompter } from "./prompt.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

type Command = (args: readonly string[]) => Promise<number>;

function usage(): void {
  console.error("usage: node dist/cli/manage.mjs <command> [arguments]");
  console.error("");
  console.error("commands:");
  console.error("  migrate                            apply pending migrations (safe to re-run)");
  console.error("  bootstrap                          create the first HR admin and the public origin");
  console.error("  set-origin <url>                   change the public origin mutations are checked against");
  console.error("  create-user --role hr_admin|employee [--email <address>] [--employee <code>]");
  console.error("  reset-password <email>             set a new password and revoke that account's sessions");
  console.error("  disable-user <email>               deactivate an account (never the last active HR admin)");
  console.error("");
  console.error(
    "Credentials come from DB_SERVER, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME; every command here needs the '_owner' role.",
  );
  console.error("Passwords are typed at a hidden prompt: they are never arguments and never logged.");
}

/**
 * Maintenance runs with the owner role (spec §4). Refusing the runtime role here is the same
 * check `migrate` makes, so a stray `--env-file .env` cannot provision accounts with the
 * serving credentials.
 */
function requireOwnerRole(user: string): void {
  if (!user.endsWith("_owner") || user === "_owner") {
    throw new ProvisioningError(
      "wrong_role",
      "maintenance commands must run with the maintenance role: DB_USER has to end in '_owner'",
    );
  }
}

interface Options {
  readonly flags: ReadonlyMap<string, string>;
  readonly positional: readonly string[];
}

/** A tiny parser that refuses anything it does not know, rather than ignoring it. */
function parseArgs(args: readonly string[], allowed: readonly string[]): Options {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (!allowed.includes(name)) {
      throw new ProvisioningError("bad_usage", `unknown option --${name}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ProvisioningError("bad_usage", `--${name} needs a value`);
    }
    if (flags.has(name)) {
      throw new ProvisioningError("bad_usage", `--${name} was given twice`);
    }
    flags.set(name, value);
    index += 1;
  }
  return { flags, positional };
}

/** Opens the pool, runs `body`, and always closes it again. */
async function withOwnerPool<T>(body: (pool: ReturnType<typeof createPool>) => Promise<T>): Promise<T> {
  const config = loadDbConfig();
  requireOwnerRole(config.user);
  const pool = createPool(config);
  try {
    return await body(pool);
  } finally {
    await pool.end();
  }
}

async function withPrompter<T>(body: (prompter: Prompter) => Promise<T>): Promise<T> {
  const prompter = createPrompter();
  try {
    return await body(prompter);
  } finally {
    prompter.close();
  }
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

const bootstrapCommand: Command = async (args) => {
  if (args.length > 0) {
    console.error("bootstrap takes no arguments: it asks for what it needs");
    return EXIT_USAGE;
  }

  return withOwnerPool(async (pool) => {
    const answers = await withPrompter(async (prompter) => {
      console.log("bootstrap: provisioning the first HR administrator.");
      const email = (await prompter.ask("Administrator email: ")).trim();
      const password = await askNewPassword(prompter, "Password (15-128 characters)");
      const origin = (
        await prompter.ask("Public origin (for example https://hr.example.test): ")
      ).trim();
      return { email, password, origin };
    });

    const result = await bootstrap(pool, {
      email: answers.email,
      password: answers.password,
      publicOrigin: answers.origin,
      correlationId: newCorrelationId(),
    });
    console.log(`bootstrap: created HR administrator ${result.email}`);
    console.log(`bootstrap: public origin set to ${result.publicOrigin}`);
    return EXIT_OK;
  });
};

const setOriginCommand: Command = async (args) => {
  const { positional } = parseArgs(args, []);
  if (positional.length !== 1) {
    console.error("usage: set-origin <url>");
    return EXIT_USAGE;
  }

  return withOwnerPool(async (pool) => {
    const before = await currentOrigin(pool);
    const value = await setOrigin(pool, {
      origin: positional[0] as string,
      correlationId: newCorrelationId(),
    });
    console.log(`set-origin: ${before ?? "(unset)"} -> ${value}`);
    return EXIT_OK;
  });
};

function parseRole(raw: string | undefined): AccountRole {
  if (raw === undefined) {
    throw new ProvisioningError("bad_usage", "--role is required (hr_admin or employee)");
  }
  if (!(ACCOUNT_ROLES as readonly string[]).includes(raw)) {
    throw new ProvisioningError("bad_usage", "--role must be hr_admin or employee");
  }
  return raw as AccountRole;
}

const createUserCommand: Command = async (args) => {
  const { flags, positional } = parseArgs(args, ["role", "email", "employee"]);
  if (positional.length > 0) {
    console.error("usage: create-user --role hr_admin|employee [--email <address>] [--employee <code>]");
    return EXIT_USAGE;
  }
  const role = parseRole(flags.get("role"));

  return withOwnerPool(async (pool) => {
    const answers = await withPrompter(async (prompter) => {
      const email = (flags.get("email") ?? (await prompter.ask("Email: "))).trim();
      const password = await askNewPassword(prompter, "Password (15-128 characters)");
      return { email, password };
    });

    const result = await createUser(pool, {
      email: answers.email,
      password: answers.password,
      role,
      employeeCode: flags.get("employee"),
      correlationId: newCorrelationId(),
    });
    console.log(
      `create-user: created ${result.role} ${result.email}${result.employeeCode === null ? "" : ` linked to employee ${result.employeeCode}`}`,
    );
    return EXIT_OK;
  });
};

const resetPasswordCommand: Command = async (args) => {
  const { positional } = parseArgs(args, []);
  if (positional.length !== 1) {
    console.error("usage: reset-password <email>");
    return EXIT_USAGE;
  }
  const email = positional[0] as string;

  return withOwnerPool(async (pool) => {
    const password = await withPrompter(async (prompter) =>
      askNewPassword(prompter, `New password for ${email} (15-128 characters)`),
    );
    const result = await resetPassword(pool, {
      email,
      password,
      correlationId: newCorrelationId(),
    });
    console.log(
      `reset-password: password replaced; ${result.revokedSessions} session(s) of that account revoked`,
    );
    return EXIT_OK;
  });
};

const disableUserCommand: Command = async (args) => {
  const { positional } = parseArgs(args, []);
  if (positional.length !== 1) {
    console.error("usage: disable-user <email>");
    return EXIT_USAGE;
  }

  return withOwnerPool(async (pool) => {
    const result = await disableUser(pool, {
      email: positional[0] as string,
      correlationId: newCorrelationId(),
    });
    console.log(
      `disable-user: account deactivated; ${result.revokedSessions} session(s) revoked`,
    );
    return EXIT_OK;
  });
};

const COMMANDS: Readonly<Record<string, Command>> = {
  migrate,
  bootstrap: bootstrapCommand,
  "set-origin": setOriginCommand,
  "create-user": createUserCommand,
  "reset-password": resetPasswordCommand,
  "disable-user": disableUserCommand,
};

export async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    usage();
    return name === undefined ? EXIT_USAGE : EXIT_OK;
  }
  // Defence in depth: a password must never reach a process listing or a shell history.
  if (args.some((argument) => /^--(password|pass|pwd)(=|$)/u.test(argument))) {
    console.error("manage: passwords are never passed as arguments - you will be prompted");
    return EXIT_USAGE;
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
      error instanceof ConfigError ||
      error instanceof ProvisioningError ||
      error instanceof PromptError ||
      error instanceof Error
        ? error.message
        : "command failed";
    console.error(`manage: ${message}`);
    process.exitCode =
      error instanceof ConfigError ||
      (error instanceof ProvisioningError && error.code === "bad_usage")
        ? EXIT_USAGE
        : EXIT_FAILED;
  });

/**
 * The complete configuration surface of Demo_App_HR (spec §4).
 *
 * Exactly five variables exist: DB_SERVER, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME. Everything
 * else - the public origin, the listening port, timeouts, pool sizes - is a code default or
 * lives in the database.
 *
 * `loadDbConfig` is a pure function of an environment map so the same code path is exercised
 * by the unit matrix and by the running server. No value is ever echoed in an error: the
 * messages name variables, never their contents, and DB_PASSWORD is never touched by them.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface DbConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/** Every variable the application reads. Nothing outside this list is configuration. */
export const DB_ENV_VAR_NAMES = [
  "DB_SERVER",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
] as const;

export const DEFAULT_DB_PORT = 5432;

/** Refusal to start. `problems` is safe to print: it names variables, never values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid database configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function present(env: EnvSource, name: string): string | undefined {
  const value = env[name];
  return value === undefined ? undefined : value;
}

function requiredValue(env: EnvSource, name: string, problems: string[]): string | undefined {
  const value = present(env, name);
  if (value === undefined) {
    problems.push(`${name} is not set`);
    return undefined;
  }
  if (value === "") {
    problems.push(`${name} is set but empty`);
    return undefined;
  }
  return value;
}

function parsePort(label: string, text: string, problems: string[]): number | undefined {
  if (!/^[0-9]{1,5}$/.test(text)) {
    problems.push(`${label} must be a whole number between 1 and 65535`);
    return undefined;
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    problems.push(`${label} must be between 1 and 65535`);
    return undefined;
  }
  return port;
}

interface ParsedServer {
  readonly host?: string;
  readonly port?: number;
}

/**
 * `host`, `host:port`, `[ipv6]` or `[ipv6]:port`. An unbracketed value with more than one
 * colon is refused rather than guessed: a bare `::1` is ambiguous.
 */
export function parseDbServer(raw: string, problems: string[]): ParsedServer {
  if (/\s/.test(raw)) {
    problems.push("DB_SERVER must not contain whitespace");
    return {};
  }
  if (raw.includes("://") || raw.includes("/") || raw.includes("?") || raw.includes("@")) {
    problems.push("DB_SERVER must be host or host:port, not a URL or connection string");
    return {};
  }

  let host: string;
  let portText: string | undefined;

  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) {
      problems.push('DB_SERVER has an unclosed "[": write a bracketed IPv6 literal such as [::1]:5432');
      return {};
    }
    host = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (rest !== "" && !rest.startsWith(":")) {
      problems.push('DB_SERVER has trailing characters after "]": expected [host] or [host]:port');
      return {};
    }
    portText = rest === "" ? undefined : rest.slice(1);
    if (!/^[0-9A-Fa-f:.]+$/.test(host)) {
      problems.push("DB_SERVER bracketed host is not an IPv6 literal");
      return {};
    }
  } else {
    const colons = raw.length - raw.replaceAll(":", "").length;
    if (colons > 1) {
      problems.push("DB_SERVER looks like an IPv6 address: bracket it, for example [::1]:5432");
      return {};
    }
    if (colons === 1) {
      const index = raw.indexOf(":");
      host = raw.slice(0, index);
      portText = raw.slice(index + 1);
    } else {
      host = raw;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(host)) {
      problems.push("DB_SERVER host must be a hostname or an IPv4 address");
      return {};
    }
  }

  if (portText === undefined) {
    return { host };
  }
  if (portText === "") {
    problems.push('DB_SERVER ends with ":" but names no port');
    return { host };
  }
  const port = parsePort("the port in DB_SERVER", portText, problems);
  return port === undefined ? { host } : { host, port };
}

/**
 * Reads the five variables and refuses to start on anything missing, empty, malformed or
 * self-contradictory. Never throws with a value in the message.
 */
export function loadDbConfig(env: EnvSource = process.env): DbConfig {
  const problems: string[] = [];

  const server = requiredValue(env, "DB_SERVER", problems);
  const user = requiredValue(env, "DB_USER", problems);
  const password = requiredValue(env, "DB_PASSWORD", problems);
  const database = requiredValue(env, "DB_NAME", problems);

  const parsed = server === undefined ? {} : parseDbServer(server, problems);

  const portRaw = present(env, "DB_PORT");
  let overridePort: number | undefined;
  if (portRaw === "") {
    problems.push(
      "DB_PORT is set but empty: unset it to use the port in DB_SERVER, or the default 5432",
    );
  } else if (portRaw !== undefined) {
    overridePort = parsePort("DB_PORT", portRaw, problems);
  }

  if (parsed.port !== undefined && overridePort !== undefined && parsed.port !== overridePort) {
    problems.push(
      `DB_SERVER carries port ${parsed.port} but DB_PORT is ${overridePort}: set only one of them, or set both to the same value`,
    );
  }

  if (problems.length > 0 || parsed.host === undefined || user === undefined || password === undefined || database === undefined) {
    throw new ConfigError(problems.length > 0 ? problems : ["DB_SERVER host could not be determined"]);
  }

  return {
    host: parsed.host,
    port: parsed.port ?? overridePort ?? DEFAULT_DB_PORT,
    user,
    password,
    database,
  };
}

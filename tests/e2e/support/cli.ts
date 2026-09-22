/**
 * Drives `manage.mjs` inside a throw-away `demo-hr-e2e-*` container over a real pseudo-tty, so
 * `src/cli/prompt.ts`'s `isTTY` + `setRawMode` check sees an interactive terminal and hides the
 * password exactly as it does for an operator (slice-3-B-report's proven pattern: `script -qec`
 * wrapping `docker run -it`, reproduced here for the test harness rather than a hand-typed
 * shell session).
 *
 * A password is never a CLI argument, never printed and never logged: each secret lives only
 * in a caller-supplied string (itself read from a 0600 file — see `env.ts`'s `secretDir()`)
 * and is written straight to the pty's stdin. The full transcript is scanned for every marked
 * secret before this module hands anything back, exactly as the container journeys in
 * slice-3-B-report did, as a second line of defence against a prompt string changing shape and
 * silently echoing a password some day.
 */
import { spawn } from "node:child_process";

import { IMAGE_TAG, OWNER_ENV_FILE } from "./env.ts";

export interface CliStep {
  /** A substring that must appear in the accumulated transcript before `answer` is sent. */
  readonly expect: string;
  readonly answer: string;
  /** true for a password: asserted absent from the transcript once the run finishes. */
  readonly secret?: boolean;
}

export interface CliResult {
  readonly transcript: string;
  readonly exitCode: number | null;
}

/** Single-quotes a shell word; the values here are fixed test fixtures, never user input. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Runs `node manage.mjs <args>` inside `--rm --name <containerName> <IMAGE_TAG>`, answering
 * each `steps` prompt in order as it appears. Resolves once the container process exits.
 *
 * `envFile` defaults to the owner credentials (every `manage` command but the server itself
 * needs `_owner`, enforced by `requireOwnerRole` in `src/cli/manage.ts`).
 */
export async function driveManageCli(
  containerName: string,
  args: readonly string[],
  steps: readonly CliStep[],
  options: { readonly envFile?: string; readonly timeoutMs?: number } = {},
): Promise<CliResult> {
  const envFile = options.envFile ?? OWNER_ENV_FILE;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const dockerCommand = [
    "docker run -it --rm --name",
    shellQuote(containerName),
    "--env-file",
    shellQuote(envFile),
    shellQuote(IMAGE_TAG),
    "manage.mjs",
    ...args.map(shellQuote),
  ].join(" ");
  // `-qec`: quiet (no "Script started" banner), exit with the inner command's own status,
  // command to run; the typescript (session recording) goes to /dev/null — only the live
  // stdout this process pipes is kept, and that is discarded by global-teardown too.
  const scriptCommand = `script -qec ${shellQuote(dockerCommand)} /dev/null`;

  const child = spawn("bash", ["-c", scriptCommand], { stdio: ["pipe", "pipe", "pipe"] });

  let transcript = "";
  const waiters: Array<{ pattern: string; resolve: () => void }> = [];

  function onChunk(chunk: Buffer): void {
    transcript += chunk.toString("utf8");
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter !== undefined && transcript.includes(waiter.pattern)) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  function waitFor(pattern: string): Promise<void> {
    if (transcript.includes(pattern)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for ${JSON.stringify(pattern)} from ${containerName}\n--- transcript so far ---\n${transcript}`,
          ),
        );
      }, timeoutMs);
      waiters.push({
        pattern,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  const exitCode = await (async () => {
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    for (const step of steps) {
      await waitFor(step.expect);
      // `prompt.ts` writes the question, *then* switches the tty to raw mode; answering in
      // that window would land in cooked mode and echo a hidden field. A short settle avoids
      // the race without depending on timing for correctness (the transcript scan below still
      // catches a leak if this is ever not enough).
      await new Promise((resolve) => setTimeout(resolve, 150));
      child.stdin.write(`${step.answer}\r`);
    }

    return exitPromise;
  })();

  for (const step of steps) {
    if (step.secret === true && transcript.includes(step.answer)) {
      throw new Error(`secret leaked into the ${containerName} transcript — refusing to return it`);
    }
  }

  return { transcript, exitCode };
}

/** `manage.mjs migrate` takes no prompts: a plain run is enough, still through the same image. */
export async function runManageNonInteractive(
  containerName: string,
  args: readonly string[],
  envFile: string,
  timeoutMs = 30_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["run", "--rm", "--name", containerName, "--env-file", envFile, IMAGE_TAG, "manage.mjs", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let transcript = "";
    child.stdout.on("data", (chunk: Buffer) => {
      transcript += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      transcript += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${containerName} timed out\n${transcript}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ transcript, exitCode: code });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

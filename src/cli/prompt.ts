/**
 * Terminal prompts for `manage` (spec §4: "hide password entry").
 *
 * A password is read from an interactive terminal and from nowhere else: never an argument,
 * never an environment variable, never a file, never a pipe. If stdin is not a TTY the command
 * refuses rather than reading a password that some shell history or CI log already holds.
 *
 * Echo suppression is the shape spike S5 proved inside the pinned image: the interface's own
 * output writer is replaced, the prompt text is written directly, and the newline the user's
 * Return would have produced is written back afterwards.
 */
import { createInterface, type Interface } from "node:readline/promises";

/** The internals readline exposes for echo control; typed rather than cast to `any`. */
interface EchoControllable {
  _writeToOutput?: (text: string) => void;
}

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

export interface Prompter {
  /** A visible prompt: email addresses, origins, confirmations. */
  ask(question: string): Promise<string>;
  /** A hidden prompt. Refuses unless stdin is an interactive terminal. */
  askSecret(question: string): Promise<string>;
  close(): void;
}

export function createPrompter(): Prompter {
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let muted = false;
  (rl as unknown as EchoControllable)._writeToOutput = (text: string): void => {
    if (!muted) {
      process.stdout.write(text);
    }
  };

  async function read(question: string, hidden: boolean): Promise<string> {
    if (hidden && process.stdin.isTTY !== true) {
      throw new PromptError(
        "a password can only be entered on an interactive terminal: run this command with `docker run -it` (or under `script`), never from a pipe",
      );
    }
    process.stdout.write(question);
    muted = hidden;
    try {
      const answer = await rl.question("");
      return answer;
    } finally {
      muted = false;
      if (hidden) {
        process.stdout.write("\n");
      }
    }
  }

  return {
    ask: (question) => read(question, false),
    askSecret: (question) => read(question, true),
    close: () => {
      rl.close();
    },
  };
}

/**
 * Asks twice and refuses a mismatch, so a typo cannot lock the operator out of the account
 * they are provisioning. The two answers are compared and then dropped.
 */
export async function askNewPassword(
  prompter: Prompter,
  label: string,
): Promise<string> {
  const first = await prompter.askSecret(`${label}: `);
  const second = await prompter.askSecret(`${label} (again): `);
  if (first !== second) {
    throw new PromptError("the two passwords did not match");
  }
  return first;
}

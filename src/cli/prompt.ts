/**
 * Terminal prompts for `manage` (spec §4: "hide password entry").
 *
 * A password is read from an interactive terminal and from nowhere else: never an argument,
 * never an environment variable, never a file, never a pipe. If stdin is not a TTY the command
 * refuses rather than reading a password that some shell history or CI log already holds.
 *
 * The reader is deliberately written against the stream API rather than `readline`. Spike S5
 * suppressed the echo by overriding `readline`'s internal `_writeToOutput`, and that override
 * is silently ignored by `node:readline/promises` on Node 24 - the password was echoed in
 * full. Here the terminal is put in raw mode, which turns the line discipline's echo off, and
 * this module decides character by character what to print: everything for a visible prompt,
 * nothing at all for a hidden one. Pasting works, because a paste arrives as an ordinary chunk.
 */
import type { Readable, Writable } from "node:stream";

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

/** The part of `process.stdin` this module needs; narrowed so tests can supply their own. */
export interface PromptInput extends Readable {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface PromptOutput extends Writable {
  write(chunk: string): boolean;
}

export interface Prompter {
  /** A visible prompt: email addresses, origins, confirmations. */
  ask(question: string): Promise<string>;
  /** A hidden prompt. Refuses unless stdin is an interactive terminal. */
  askSecret(question: string): Promise<string>;
  close(): void;
}

const ENTER = new Set(["\r", "\n"]);
const BACKSPACE = new Set(["\u0008", "\u007F"]);
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";

export interface PrompterOptions {
  readonly input?: PromptInput;
  readonly output?: PromptOutput;
}

export function createPrompter(options: PrompterOptions = {}): Prompter {
  const input = options.input ?? (process.stdin as PromptInput);
  const output = options.output ?? (process.stdout as PromptOutput);
  let closed = false;

  function isInteractive(): boolean {
    return input.isTTY === true && typeof input.setRawMode === "function";
  }

  function setRaw(mode: boolean): void {
    if (typeof input.setRawMode === "function") {
      input.setRawMode(mode);
    }
  }

  async function read(question: string, hidden: boolean): Promise<string> {
    if (closed) {
      throw new PromptError("the prompter is closed");
    }
    if (hidden && !isInteractive()) {
      throw new PromptError(
        "a password can only be entered on an interactive terminal: run this command with `docker run -it` (or under `script`), never from a pipe",
      );
    }

    output.write(question);
    const interactive = isInteractive();
    if (interactive) {
      setRaw(true);
    }
    input.resume();
    input.setEncoding("utf8");

    return new Promise<string>((resolve, reject) => {
      let buffer = "";

      const finish = (settle: () => void): void => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
        if (interactive) {
          setRaw(false);
        }
        input.pause();
        output.write("\n");
        settle();
      };

      const onData = (chunk: string): void => {
        for (const character of chunk) {
          if (ENTER.has(character)) {
            finish(() => {
              resolve(buffer);
            });
            return;
          }
          if (character === CTRL_C || (character === CTRL_D && buffer === "")) {
            finish(() => {
              reject(new PromptError("cancelled"));
            });
            return;
          }
          if (BACKSPACE.has(character)) {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              if (!hidden && interactive) {
                output.write("\u0008 \u0008");
              }
            }
            continue;
          }
          // Ignore the remaining C0 controls (escape sequences from arrow keys, for example)
          // rather than storing them in a password.
          if (character < " " && character !== "\t") {
            continue;
          }
          buffer += character;
          if (!hidden && interactive) {
            output.write(character);
          }
        }
      };

      const onEnd = (): void => {
        finish(() => {
          resolve(buffer);
        });
      };

      const onError = (error: Error): void => {
        finish(() => {
          reject(new PromptError(`could not read from the terminal: ${error.message}`));
        });
      };

      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onError);
    });
  }

  return {
    ask: (question) => read(question, false),
    askSecret: (question) => read(question, true),
    close: () => {
      closed = true;
      setRaw(false);
      input.pause();
    },
  };
}

/**
 * Asks twice and refuses a mismatch, so a typo cannot lock the operator out of the account
 * they are provisioning. The two answers are compared and then dropped.
 */
export async function askNewPassword(prompter: Prompter, label: string): Promise<string> {
  const first = await prompter.askSecret(`${label}: `);
  const second = await prompter.askSecret(`${label} (again): `);
  if (first !== second) {
    throw new PromptError("the two passwords did not match");
  }
  return first;
}

import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  PromptError,
  askNewPassword,
  createPrompter,
  type PromptInput,
  type PromptOutput,
} from "../../src/cli/prompt.ts";

/**
 * The regression test for the bug this module was rewritten to fix: spike S5 hid the password
 * by overriding `readline`'s internal `_writeToOutput`, and `node:readline/promises` ignores
 * that override on Node 24 - the password was echoed in full in the container check. These
 * tests assert on **what reaches the output stream**, so any future reader that echoes a
 * secret fails here rather than in a terminal transcript.
 *
 * The "password" below is a fictional string used only as an echo sentinel.
 */
const SENTINEL = "never-echo-this-42";

interface Harness {
  /** The same object as `input`, typed so the test can push characters into it. */
  readonly stream: PassThrough;
  readonly input: PromptInput;
  readonly output: PromptOutput;
  readonly written: () => string;
  readonly rawModeCalls: readonly boolean[];
}

function harness(isTty: boolean): Harness {
  const stream = new PassThrough();
  const input = stream as unknown as PromptInput;
  const rawModeCalls: boolean[] = [];
  input.isTTY = isTty;
  if (isTty) {
    input.setRawMode = (mode: boolean) => {
      rawModeCalls.push(mode);
      return input;
    };
  }
  let written = "";
  const output = {
    write(chunk: string): boolean {
      written += chunk;
      return true;
    },
  } as unknown as PromptOutput;
  return { stream, input, output, written: () => written, rawModeCalls };
}

describe("hidden prompts (spec §4)", () => {
  it("never writes the typed password to the terminal", async () => {
    const { stream, input, output, written, rawModeCalls } = harness(true);
    const prompter = createPrompter({ input, output });
    const answer = prompter.askSecret("Password: ");
    stream.write(`${SENTINEL}\r`);

    expect(await answer).toBe(SENTINEL);
    expect(written()).toBe("Password: \n"); // the prompt and the newline, nothing else
    expect(written()).not.toContain(SENTINEL);
    expect(rawModeCalls).toEqual([true, false]); // raw while reading, restored afterwards
    prompter.close();
  });

  it("accepts a pasted password arriving in several chunks", async () => {
    const { stream, input, output, written } = harness(true);
    const prompter = createPrompter({ input, output });
    const answer = prompter.askSecret("Password: ");
    stream.write("never-");
    stream.write("echo-");
    stream.write("this-42\n");

    expect(await answer).toBe(SENTINEL);
    expect(written()).not.toContain("echo-this");
    prompter.close();
  });

  it("honours backspace without echoing anything", async () => {
    const { stream, input, output, written } = harness(true);
    const prompter = createPrompter({ input, output });
    const answer = prompter.askSecret("Password: ");
    stream.write(`${SENTINEL}X\u007F\r`);

    expect(await answer).toBe(SENTINEL);
    expect(written()).toBe("Password: \n");
    prompter.close();
  });

  it("refuses to read a password when stdin is not a terminal", async () => {
    const { input, output } = harness(false);
    const prompter = createPrompter({ input, output });
    await expect(prompter.askSecret("Password: ")).rejects.toBeInstanceOf(PromptError);
    prompter.close();
  });

  it("treats Ctrl-C as a cancellation rather than an empty password", async () => {
    const { stream, input, output } = harness(true);
    const prompter = createPrompter({ input, output });
    const answer = prompter.askSecret("Password: ");
    stream.write("\u0003");
    await expect(answer).rejects.toMatchObject({ message: "cancelled" });
    prompter.close();
  });

  it("refuses two passwords that do not match", async () => {
    const { stream, input, output } = harness(true);
    const prompter = createPrompter({ input, output });
    const answer = askNewPassword(prompter, "Password");
    stream.write(`${SENTINEL}\r`);
    await new Promise((resolve) => setImmediate(resolve));
    stream.write(`${SENTINEL}-different\r`);

    await expect(answer).rejects.toMatchObject({ message: "the two passwords did not match" });
    prompter.close();
  });
});

describe("visible prompts", () => {
  it("echoes what is typed, and reads a line from a pipe too", async () => {
    const tty = harness(true);
    const prompter = createPrompter({ input: tty.input, output: tty.output });
    const answer = prompter.ask("Email: ");
    tty.stream.write("ops.admin@example.test\r");
    expect(await answer).toBe("ops.admin@example.test");
    expect(tty.written()).toContain("ops.admin@example.test");
    prompter.close();

    const piped = harness(false);
    const pipedPrompter = createPrompter({ input: piped.input, output: piped.output });
    const fromPipe = pipedPrompter.ask("Email: ");
    piped.stream.write("ops.admin@example.test\n");
    expect(await fromPipe).toBe("ops.admin@example.test");
    pipedPrompter.close();
  });
});

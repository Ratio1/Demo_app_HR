/**
 * A bounded concurrency gate (spec §6 S6).
 *
 * Argon2id at 19 MiB × 2 passes is the only deliberately expensive operation in the process,
 * and the container has half a core and one gibibyte. The gate therefore admits **one** active
 * hash at a time and lets at most **eight** callers wait; the ninth waiter is refused outright
 * with a sanitized 429 rather than queued behind an unbounded backlog.
 *
 * Nothing here is configurable: the numbers are code constants (spec §4 — no fifth variable).
 */

/** One active hash, eight queued; the ninth caller is refused. */
export const ARGON2_MAX_ACTIVE = 1;
export const ARGON2_MAX_QUEUED = 8;

/** How long a refused caller is told to wait. Seconds, as `Retry-After` wants it. */
export const CAPACITY_RETRY_AFTER_SECONDS = 2;

/**
 * Thrown when the queue is full. The message is safe to log: it names no principal, no
 * password and no row.
 */
export class CapacityError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number = CAPACITY_RETRY_AFTER_SECONDS) {
    super("the hashing queue is full");
    this.name = "CapacityError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface Semaphore {
  /** Runs `task` once a slot is free, or throws `CapacityError` if the queue is full. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Current occupancy, for tests and for the report. */
  readonly stats: { readonly active: number; readonly queued: number };
}

export interface SemaphoreOptions {
  readonly maxActive?: number;
  readonly maxQueued?: number;
  readonly retryAfterSeconds?: number;
}

export function createSemaphore(options: SemaphoreOptions = {}): Semaphore {
  const maxActive = options.maxActive ?? ARGON2_MAX_ACTIVE;
  const maxQueued = options.maxQueued ?? ARGON2_MAX_QUEUED;
  const retryAfterSeconds = options.retryAfterSeconds ?? CAPACITY_RETRY_AFTER_SECONDS;

  let active = 0;
  const waiters: Array<() => void> = [];

  function release(): void {
    active -= 1;
    const next = waiters.shift();
    if (next !== undefined) {
      active += 1;
      next();
    }
  }

  return {
    get stats() {
      return { active, queued: waiters.length };
    },
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < maxActive) {
        active += 1;
      } else {
        if (waiters.length >= maxQueued) {
          throw new CapacityError(retryAfterSeconds);
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/** The process-wide Argon2 gate. One per container, which is what S6 bounds. */
export const argon2Semaphore = createSemaphore();

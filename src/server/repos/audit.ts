/**
 * The audit writer (spec §6 S7).
 *
 * Every audit row is inserted with the **same `PoolClient`** as the business mutation it
 * describes, inside that mutation's transaction, so the two commit together or not at all.
 * There is no fire-and-forget path and no separate connection: an audit write cannot succeed
 * while the change it records rolls back, nor the other way round.
 *
 * The runtime role holds `INSERT` and `SELECT` on `audit_events` and nothing else, so this
 * process cannot rewrite or erase what it has written (S7; grants in `migrations/0001_init.sql`).
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "../db/pool.ts";

/**
 * The closed action vocabulary. Slice 1 wrote the account, session and settings actions; slice 2
 * added the four employee actions and `leave.cancel`, which the deactivation cascade writes once
 * per pending request it cancels; slice 3 adds `leave.submit`, `leave.approve` and
 * `leave.reject`, and makes `leave.cancel` the owner's withdrawal as well. Later slices extend
 * the list; nothing else is written.
 *
 * **What is audited.** Every *effective* mutation, with `outcome: 'ok'`, in its own transaction —
 * and, in slice 3, one extra `denied` row: a refused self-approval (`leave.approve` /
 * `leave.reject`, outcome `denied`). Spec §2 makes that bar a named control ("never bypass
 * self-approval"), so an attempt on it is the one refusal worth a receipt. Conflict losers
 * (`conflict_overlap`, `conflict_not_pending`, `conflict_stale`) write nothing: they roll back,
 * and a per-attempt row would turn the concurrency tests' "exactly one audit row" into noise.
 */
export const AUDIT_ACTIONS = [
  "account.bootstrap",
  "account.create",
  "account.disable",
  "account.reset_password",
  "employee.activate",
  "employee.create",
  "employee.deactivate",
  "employee.update",
  "leave.approve",
  "leave.cancel",
  "leave.reject",
  "leave.submit",
  "login",
  "logout",
  "password.change",
  "settings.set_origin",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** `ok` for a completed action, `denied` for a refused one, `error` for a failed one. */
export const AUDIT_OUTCOMES = ["ok", "denied", "error"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_OBJECT_TYPES = [
  "account",
  "employee",
  "leave_request",
  "session",
  "settings",
] as const;
export type AuditObjectType = (typeof AUDIT_OBJECT_TYPES)[number];

export interface AuditEventInput {
  /** The account that acted, or `null` when the actor could not be identified. */
  readonly actorAccountId: string | null;
  readonly objectType: AuditObjectType;
  readonly objectId: string | null;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  /** One id per request or per CLI command, so related rows can be read together. */
  readonly correlationId: string;
}

/** A correlation id for one request or one CLI command. */
export function newCorrelationId(): string {
  return randomUUID();
}

export async function insertAuditEvent(
  client: PoolClient,
  event: AuditEventInput,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO audit_events
       (id, actor_account_id, object_type, object_id, action, outcome, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      event.actorAccountId,
      event.objectType,
      event.objectId,
      event.action,
      event.outcome,
      event.correlationId,
    ],
  );
  return id;
}

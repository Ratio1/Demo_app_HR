-- 0002_tighten_grants — narrow the runtime role to the privileges it actually uses.
--
-- 0001_init granted `SELECT, INSERT, UPDATE, DELETE` on `accounts`, `sessions`, `settings`,
-- `employees` and `leave_requests` to {{APP_ROLE}} as one block. access-matrix.md's D-017,
-- D-032, D-045 and D-062 document a narrower grant as the intended database-level backstop for
-- four of those five tables (defence-in-depth: today nothing in `src/server/**` or `src/cli/**`
-- performs any of the revoked statements as the runtime role, so this closes a gap rather than
-- changing behaviour):
--
--  * `accounts` — never `INSERT`ed or `DELETE`d by the runtime. Accounts are CLI-provisioned
--    only (spec §4: no sign-up); `manage bootstrap`/`create-user`/`disable-user` run under the
--    owner role, which owns the tables and needs no grant at all. The runtime only ever reads a
--    session's account and `UPDATE`s it (failed-login counters, lockout, password hash,
--    `active`).
--  * `employees` / `leave_requests` — never `DELETE`d by the runtime. Deactivating an employee
--    and cancelling a leave request are both status changes (`UPDATE`), never a row removal;
--    `INSERT` stays granted because the runtime does create both kinds of row.
--  * `settings` — never `INSERT`ed or `DELETE`d by the runtime. The singleton row is written
--    only by `manage bootstrap`/`set-origin` under the owner role (`repos/settings.ts`'s
--    `setPublicOrigin`: `UPDATE` first, `INSERT` only if that touched nothing — portable SQL,
--    no vendor upsert); the runtime only ever reads it and, on that one CLI path, updates it.
--
-- `sessions` is unchanged: the runtime both creates sessions (login) and removes them (logout,
-- rotation, revocation), so it keeps all four privileges.
--
-- {{APP_ROLE}} is substituted by the runner exactly as in 0001_init.sql. `REVOKE` only — 0001 is
-- already journalled and is never edited after the fact.

REVOKE INSERT, DELETE ON accounts FROM {{APP_ROLE}};
REVOKE DELETE ON employees FROM {{APP_ROLE}};
REVOKE DELETE ON leave_requests FROM {{APP_ROLE}};
REVOKE INSERT, DELETE ON settings FROM {{APP_ROLE}};

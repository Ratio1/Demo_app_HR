-- 0001_init — Demo_App_HR initial schema.
--
-- Portable SQL only (spec §5): application-generated UUIDs, text/boolean/date/timestamptz/
-- integer columns, text + CHECK enums, foreign keys and plain indexes. No extension, no
-- SERIAL, no vendor UPSERT, no trigger, no advisory lock, no RLS.
--
-- The runner applies this file in one transaction and journals it in schema_migrations.
-- {{APP_ROLE}} is replaced by the runner with the quoted runtime role derived from DB_USER
-- (…_owner → …_app), so no role name is hard-coded here.

CREATE TABLE schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schema_migrations_id_length CHECK (char_length(id) BETWEEN 1 AND 128)
);

-- Accounts are created by the operator through `manage`; there is no sign-up.
CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_email_key UNIQUE (email),
  CONSTRAINT accounts_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT accounts_email_length CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT accounts_role_allowed CHECK (role IN ('hr_admin', 'employee')),
  CONSTRAINT accounts_password_hash_length CHECK (char_length(password_hash) BETWEEN 1 AND 512),
  CONSTRAINT accounts_failed_logins_range CHECK (failed_logins >= 0),
  CONSTRAINT accounts_version_positive CHECK (version >= 1)
);

CREATE INDEX accounts_role_active_idx ON accounts (role, active);

-- Opaque session tokens: only the SHA-256 hex digest is stored (S2).
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_sha256 text NOT NULL,
  csrf_token text NOT NULL,
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_token_sha256_key UNIQUE (token_sha256),
  CONSTRAINT sessions_token_sha256_format CHECK (char_length(token_sha256) = 64),
  CONSTRAINT sessions_csrf_token_length CHECK (char_length(csrf_token) BETWEEN 32 AND 128),
  CONSTRAINT sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id)
);

CREATE INDEX sessions_account_id_idx ON sessions (account_id);
CREATE INDEX sessions_absolute_expires_at_idx ON sessions (absolute_expires_at);

-- Singleton row: the exact public origin every mutation compares Origin against (§4, S3).
CREATE TABLE settings (
  id integer PRIMARY KEY,
  public_origin text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_singleton CHECK (id = 1),
  CONSTRAINT settings_public_origin_length CHECK (char_length(public_origin) BETWEEN 1 AND 255)
);

-- Append-only from the runtime role's point of view: it may INSERT and SELECT, nothing else.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_account_id uuid,
  object_type text NOT NULL,
  object_id uuid,
  action text NOT NULL,
  outcome text NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_object_type_length CHECK (char_length(object_type) BETWEEN 1 AND 64),
  CONSTRAINT audit_events_action_length CHECK (char_length(action) BETWEEN 1 AND 64),
  CONSTRAINT audit_events_outcome_length CHECK (char_length(outcome) BETWEEN 1 AND 64)
);

CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at);
CREATE INDEX audit_events_actor_account_id_idx ON audit_events (actor_account_id);
CREATE INDEX audit_events_correlation_id_idx ON audit_events (correlation_id);

CREATE TABLE employees (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  full_name text NOT NULL,
  work_email text NOT NULL,
  title text NOT NULL,
  department text NOT NULL,
  start_date date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  account_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employees_code_key UNIQUE (code),
  CONSTRAINT employees_code_length CHECK (char_length(code) BETWEEN 1 AND 32),
  CONSTRAINT employees_full_name_length CHECK (char_length(full_name) BETWEEN 1 AND 160),
  CONSTRAINT employees_title_length CHECK (char_length(title) BETWEEN 1 AND 160),
  CONSTRAINT employees_department_length CHECK (char_length(department) BETWEEN 1 AND 160),
  CONSTRAINT employees_work_email_key UNIQUE (work_email),
  CONSTRAINT employees_work_email_lowercase CHECK (work_email = lower(work_email)),
  CONSTRAINT employees_work_email_length CHECK (char_length(work_email) BETWEEN 3 AND 254),
  CONSTRAINT employees_account_id_key UNIQUE (account_id),
  CONSTRAINT employees_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts (id),
  CONSTRAINT employees_version_positive CHECK (version >= 1)
);

CREATE INDEX employees_active_department_idx ON employees (active, department);

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL,
  kind text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_requests_kind_allowed CHECK (kind IN ('annual', 'personal')),
  CONSTRAINT leave_requests_status_allowed
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT leave_requests_date_order CHECK (start_date <= end_date),
  CONSTRAINT leave_requests_pending_undecided
    CHECK (status <> 'pending' OR (decided_by IS NULL AND decided_at IS NULL)),
  CONSTRAINT leave_requests_decision_recorded
    CHECK (status NOT IN ('approved', 'rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT leave_requests_version_positive CHECK (version >= 1),
  CONSTRAINT leave_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES employees (id),
  CONSTRAINT leave_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES accounts (id)
);

CREATE INDEX leave_requests_employee_id_status_idx ON leave_requests (employee_id, status);
CREATE INDEX leave_requests_status_start_date_idx ON leave_requests (status, start_date);

-- Grants for the DML-only runtime role. The runtime can never UPDATE or DELETE an audit row
-- (S7) and can never change the migration journal.
GRANT USAGE ON SCHEMA public TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON settings TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON employees TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_requests TO {{APP_ROLE}};
GRANT INSERT, SELECT ON audit_events TO {{APP_ROLE}};
GRANT SELECT ON schema_migrations TO {{APP_ROLE}};

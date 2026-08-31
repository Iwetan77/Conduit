-- Staff, grouped.
--
-- One person routinely runs more than one business, and before this the roster
-- was a single flat list per account: everybody they pay, from every business
-- they run, in one column. Paying one business's staff meant pausing everybody
-- else and remembering to unpause them, which is a manual step that silently
-- pays the wrong people the moment somebody forgets it.
--
-- A group is a payroll's scope, not a permission or an org chart. It exists so
-- "pay staff1" is a thing a merchant can press.
CREATE TABLE employee_groups (
    id         TEXT PRIMARY KEY,                     -- egrp_xxx
    account_id TEXT NOT NULL REFERENCES accounts(id),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One name per account, case-insensitively. "Staff1" and "staff1" being two
-- groups is how a merchant ends up paying half a team.
CREATE UNIQUE INDEX idx_employee_groups_account_name
    ON employee_groups (account_id, lower(name));

CREATE INDEX idx_employee_groups_account
    ON employee_groups (account_id, created_at DESC);

-- Nullable, and deliberately so. Every employee that exists today has no group,
-- and an account that never makes one keeps working exactly as it did: a run
-- with no group named pays everybody, which is the behaviour that shipped.
ALTER TABLE employees
    ADD COLUMN group_id TEXT REFERENCES employee_groups(id) ON DELETE SET NULL;

-- ON DELETE SET NULL, never CASCADE.
--
-- Deleting a group must not delete people. The group is a label on a roster;
-- the roster is the record of who a business pays and what it paid them, and
-- cascading would take payroll history with it. Removing a group returns its
-- members to ungrouped, where they are still visible and still payable.
COMMENT ON COLUMN employees.group_id IS
    'Optional group. NULL means ungrouped. Deleting a group sets this NULL rather than removing the employee -- payroll history references employees and must not be orphaned.';

CREATE INDEX idx_employees_group
    ON employees (group_id, status) WHERE group_id IS NOT NULL;

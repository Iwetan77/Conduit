-- Every employee belongs to exactly one payroll group.
--
-- Existing loose employees move into a predictable General group per account.
-- An existing group named General is reused, so the migration is idempotent
-- with businesses that already organized themselves that way.
INSERT INTO employee_groups (id, account_id, name)
SELECT 'egrp_' || substr(md5(a.id || ':general'), 1, 24), a.id, 'General'
FROM accounts a
WHERE EXISTS (
    SELECT 1 FROM employees e
    WHERE e.account_id = a.id AND e.group_id IS NULL
)
ON CONFLICT (account_id, lower(name)) DO NOTHING;

UPDATE employees e
SET group_id = g.id,
    updated_at = now()
FROM employee_groups g
WHERE e.account_id = g.account_id
  AND e.group_id IS NULL
  AND lower(g.name) = 'general';

ALTER TABLE employees
    ALTER COLUMN group_id SET NOT NULL,
    DROP CONSTRAINT employees_group_id_fkey,
    ADD CONSTRAINT employees_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES employee_groups(id) ON DELETE RESTRICT;

COMMENT ON COLUMN employees.group_id IS
    'Required payroll group. Groups with members cannot be deleted; move or remove members first.';

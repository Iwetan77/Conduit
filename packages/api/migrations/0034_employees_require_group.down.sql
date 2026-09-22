ALTER TABLE employees
    ALTER COLUMN group_id DROP NOT NULL,
    DROP CONSTRAINT employees_group_id_fkey,
    ADD CONSTRAINT employees_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES employee_groups(id) ON DELETE SET NULL;

COMMENT ON COLUMN employees.group_id IS
    'Optional group. NULL means ungrouped. Deleting a group sets this NULL.';

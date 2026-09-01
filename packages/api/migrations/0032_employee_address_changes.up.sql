-- Moving an employee to a new wallet, with a record of who did it and when.
--
-- `Employees.Update` deliberately refuses to change the address, and that
-- refusal is right: changing where somebody is paid is not an edit to their
-- record, it is a different destination for their salary, and doing it quietly
-- on a row a scheduled run reads is the shape of money going somewhere nobody
-- chose.
--
-- But there was no replacement path either, so an employee who genuinely
-- changed wallet had to be archived and re-added. That breaks the link every
-- past payroll run holds to them -- which is precisely the history the archive
-- rule exists to protect. The refusal was correct and the absence of an
-- alternative made it harmful.
--
-- So: an explicit, separate, audited route. Not a field on an update.
CREATE TABLE employee_address_changes (
    id          TEXT PRIMARY KEY,                     -- eac_xxx
    employee_id TEXT NOT NULL REFERENCES employees(id),
    account_id  TEXT NOT NULL REFERENCES accounts(id),
    old_address TEXT NOT NULL,
    new_address TEXT NOT NULL,
    -- Free text from the caller. Nullable, because requiring a reason produces
    -- "reason" in the box rather than a reason.
    note        TEXT,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A change to the same address is not a change, and recording one would
    -- put noise in the only log that answers "when did this move".
    CONSTRAINT employee_address_changes_actually_moved
        CHECK (lower(old_address) <> lower(new_address))
);

CREATE INDEX idx_employee_address_changes_employee
    ON employee_address_changes (employee_id, changed_at DESC);

COMMENT ON TABLE employee_address_changes IS
    'Every wallet move, kept forever. payroll_run_items.address is snapshotted at draft time and is NOT rewritten by a move -- a past run records where the money actually went, and this table is how that is reconciled against where the person is paid now.';

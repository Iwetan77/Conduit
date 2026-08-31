-- People a business pays regularly.
--
-- Numbered 0027, not the 0023 the payroll work order calls it: that number was
-- taken by the settlement work before payroll started. Migrations are ordered by
-- filename, so the label follows the repository rather than the document.
CREATE TABLE employees (
    id           TEXT PRIMARY KEY,                     -- emp_xxx
    account_id   TEXT NOT NULL REFERENCES accounts(id),
    name         TEXT NOT NULL,
    -- Where they are actually paid. Resolved from a username when one was given,
    -- and stored, because a username can be looked up wrong once but a payment
    -- goes to an address.
    address      TEXT NOT NULL,
    -- The name they were added by, kept for display. Nullable: an employee can
    -- be added by raw address, and plenty are.
    username     TEXT,
    pay_currency TEXT NOT NULL,
    pay_type     TEXT NOT NULL CHECK (pay_type IN ('fixed', 'variable')),
    -- Minor units, like every other amount here. Never a float: a salary
    -- rounded by a floating point is a salary paid wrong every month.
    amount       NUMERIC(78,0),
    status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'paused', 'archived')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A fixed employee is one whose amount is known in advance; a variable one
    -- is not. Storing an amount for a variable employee means somebody will
    -- eventually pay it by accident, and a fixed employee with no amount is a
    -- payroll line that cannot be built.
    CONSTRAINT employees_amount_matches_type
        CHECK ((pay_type = 'fixed') = (amount IS NOT NULL)),
    CONSTRAINT employees_amount_positive
        CHECK (amount IS NULL OR amount > 0)
);

-- One row per person per account, keyed on where they are paid.
--
-- Case-insensitively, because case in a hex address is a checksum rather than an
-- identity -- two casings of one address are one person, and letting them be two
-- rows is how somebody gets paid twice in a single run.
CREATE UNIQUE INDEX idx_employees_account_address
    ON employees (account_id, lower(address));

CREATE INDEX idx_employees_account ON employees (account_id, status, created_at DESC);

-- Nothing here is ever hard-deleted; 'archived' is the end state.
--
-- A deleted row breaks the history of every payroll run that paid them: the run
-- would still record what it paid, and the person it paid would be a dangling
-- id. Somebody leaving is a normal event and must not corrupt the record of
-- what they were owed while they were there.
COMMENT ON COLUMN employees.status IS
    'active | paused | archived. Paused is excluded from the next run without losing history; archived is the end state. Employees are never hard-deleted.';

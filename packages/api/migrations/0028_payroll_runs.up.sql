-- A payroll run, and what it said it owed at the moment it was built.
--
-- Numbered 0028; the payroll work order calls this 0024, which was taken by the
-- settlement work before payroll started.
CREATE TABLE payroll_runs (
    id          TEXT PRIMARY KEY,                      -- pr_xxx
    account_id  TEXT NOT NULL REFERENCES accounts(id),
    status      TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'converting', 'executing', 'completed', 'partial', 'failed')),
    -- The treasury currency the business actually holds. Everything else in the
    -- run has to be converted into it before it can be paid out.
    treasury_currency TEXT NOT NULL,
    -- Caller-supplied idempotency key for EXECUTION.
    --
    -- A double-clicked payroll button that pays everyone twice is the worst bug
    -- this feature can have, and it is not a bug the UI can prevent -- a second
    -- click, a retried request, a browser restoring a tab, all produce the same
    -- second call. So it is refused here, in the one place that sees every
    -- attempt.
    run_key     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    executed_at TIMESTAMPTZ
);

-- One execution per key per account. This is the constraint that makes paying
-- twice impossible rather than unlikely.
CREATE UNIQUE INDEX idx_payroll_runs_run_key
    ON payroll_runs (account_id, run_key) WHERE run_key IS NOT NULL;

CREATE INDEX idx_payroll_runs_account ON payroll_runs (account_id, created_at DESC);

-- What each person was owed, frozen when the run was built.
--
-- The snapshot is not optional and not an optimisation. Editing somebody's
-- salary must never change what a past run says it paid them -- the same rule
-- that governs a settlement intent's address, and for the same reason: a record
-- of what happened cannot be allowed to follow the thing it was recording.
--
-- It is also what makes a crash survivable. If the process dies mid-run, the
-- database already knows exactly what was owed and to whom, so the retry pays
-- the unpaid rather than starting from an employee list that may have changed.
CREATE TABLE payroll_run_items (
    id          TEXT PRIMARY KEY,                      -- pri_xxx
    run_id      TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    -- Kept even when the employee is later archived, which is why employees are
    -- never hard-deleted: this reference is the link between a payment and the
    -- person it was for.
    employee_id TEXT NOT NULL REFERENCES employees(id),
    address     TEXT NOT NULL,
    currency    TEXT NOT NULL,
    amount      NUMERIC(78,0) NOT NULL CHECK (amount > 0),
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'paid', 'failed')),
    tx_hash     TEXT,
    error       TEXT,

    -- Paid means there is a transaction to point at. A 'paid' line with no hash
    -- is a payment nobody can find, which is indistinguishable from one that
    -- never happened when somebody asks why they were not paid.
    CONSTRAINT payroll_run_items_paid_has_tx
        CHECK ((status = 'paid') = (tx_hash IS NOT NULL))
);

-- One line per employee per run. The same person cannot appear twice in one
-- run, whatever the employee list looked like when it was built.
CREATE UNIQUE INDEX idx_payroll_run_items_unique
    ON payroll_run_items (run_id, employee_id);

CREATE INDEX idx_payroll_run_items_run ON payroll_run_items (run_id, currency);

COMMENT ON COLUMN payroll_runs.status IS
    'draft | converting | executing | completed | partial | failed. Partial is a first-class outcome, not an error: one currency group can pay while another fails, and the run must say exactly who got paid.';

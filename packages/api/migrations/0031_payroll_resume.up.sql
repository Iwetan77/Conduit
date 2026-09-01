-- Recovering a payroll run that stranded itself.
--
-- `Execute` claims a run with status='executing' and consumes its run_key. The
-- browser then signs each leg and reports it. If the tab closes, the wallet
-- hangs, or the merchant walks away between those two things, the run sits at
-- 'executing' with items still 'pending' forever:
--
--   * Execute requires status='draft', so it cannot be retried.
--   * settleRunStatus returns early while pending > 0, so it never resolves.
--   * The unique index on (account_id, run_key) means the key cannot be reused.
--
-- Nothing recovered it, and nothing told the merchant which employees had been
-- paid. On a payroll that is not an edge case; it is somebody not getting their
-- salary and nobody being able to say why.

-- Every run key ever consumed, kept forever.
--
-- Resume needs a NEW key -- reusing the old one would make a stalled run
-- indistinguishable from a duplicate submission of the original request, which
-- is the exact thing run keys exist to tell apart. But moving payroll_runs.run_key
-- to the new value would FREE the old one, since the uniqueness lives on that
-- column: the original key would become replayable the moment a run was resumed.
--
-- So consumed keys live here instead, and the column on payroll_runs becomes a
-- record of the most recent attempt rather than the thing enforcing idempotency.
CREATE TABLE payroll_run_keys (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    run_key    TEXT NOT NULL,
    run_id     TEXT NOT NULL REFERENCES payroll_runs(id),
    used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, run_key)
);

CREATE INDEX idx_payroll_run_keys_run ON payroll_run_keys (run_id, used_at);

-- Backfill, so keys already consumed stay consumed across this migration.
-- Without it, every key used before today becomes replayable.
INSERT INTO payroll_run_keys (account_id, run_key, run_id, used_at)
SELECT account_id, run_key, id, COALESCE(executed_at, created_at)
  FROM payroll_runs
 WHERE run_key IS NOT NULL
ON CONFLICT DO NOTHING;

-- When the run last moved, as opposed to when it was first executed.
--
-- The sweeper needs to distinguish "started twenty minutes ago and still
-- signing" from "started twenty minutes ago and abandoned nineteen minutes
-- ago". executed_at cannot: it is set once. This is touched on every recorded
-- leg, so a run that is progressing slowly is never mistaken for a stalled one.
ALTER TABLE payroll_runs ADD COLUMN last_progress_at TIMESTAMPTZ;

UPDATE payroll_runs SET last_progress_at = COALESCE(executed_at, created_at)
 WHERE last_progress_at IS NULL;

-- Set once, when a stall is first reported, so the webhook fires exactly once
-- per stall rather than on every sweep.
ALTER TABLE payroll_runs ADD COLUMN stalled_at TIMESTAMPTZ;

CREATE INDEX idx_payroll_runs_executing
    ON payroll_runs (status, last_progress_at) WHERE status = 'executing';

COMMENT ON TABLE payroll_run_keys IS
    'Every run key ever consumed, per account. Resume issues a NEW key; this is what keeps the OLD one permanently unusable, which payroll_runs.run_key alone cannot do once it has been overwritten.';

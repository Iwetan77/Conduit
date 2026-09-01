DROP INDEX IF EXISTS idx_payroll_runs_executing;
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS stalled_at;
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS last_progress_at;
DROP TABLE IF EXISTS payroll_run_keys;

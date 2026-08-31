-- Reverting drops the history of every payroll ever run: what was owed, to
-- whom, and which transaction paid it. The payments themselves happened on
-- chain and are unaffected, but the record connecting them to people is gone
-- and cannot be rebuilt from the chain alone.
DROP TABLE IF EXISTS payroll_run_items;
DROP TABLE IF EXISTS payroll_runs;

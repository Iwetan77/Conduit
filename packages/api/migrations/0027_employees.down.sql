-- Reverting drops every employee record. No payroll run has been built on them
-- yet at this migration's point in the sequence, so nothing else loses its
-- meaning -- but the list itself is gone and has to be re-entered.
DROP TABLE IF EXISTS employees;

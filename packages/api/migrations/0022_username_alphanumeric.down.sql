-- Reverting re-allows underscores in new usernames. Nothing stored changes:
-- 0022 never rewrote a row, so there is nothing to put back.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_username_format;

ALTER TABLE accounts ADD CONSTRAINT accounts_username_format
    CHECK (username IS NULL OR username ~ '^[A-Za-z0-9][A-Za-z0-9_]{1,18}[A-Za-z0-9]$');

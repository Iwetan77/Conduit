-- Reverting re-allows an account with a subject and no provider, which is a row
-- its own owner cannot sign in to.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_auth_identity_complete;

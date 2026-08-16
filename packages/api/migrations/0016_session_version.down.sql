-- Reverting drops the ability to revoke a session; tokens signed with a version
-- stop verifying, so every dashboard session ends. Same one-time cost as the up
-- migration, in the other direction.
ALTER TABLE accounts DROP COLUMN session_version;

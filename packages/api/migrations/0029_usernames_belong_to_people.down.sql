-- Puts personal handles back on the business account of the same owner.
--
-- Best effort, and it says so rather than pretending otherwise. The up
-- migration does not record which business a name came from -- it does not need
-- to, and storing a rollback breadcrumb on the accounts table would outlive the
-- rollback it was for. So this reverses the RULE (a name on a person, moved to
-- their company) rather than replaying a log, and it moves a name back only
-- where exactly one business on that wallet has none.
--
-- What it deliberately does not undo: the personal accounts created above. An
-- account is not a side effect to be swept up -- it may have been used by the
-- time anybody rolls back, and deleting a row that settlements or intents point
-- at would fail on the foreign keys anyway. An unused personal account costs
-- nothing and is what the payer path would have created on its own.
CREATE TEMP TABLE username_unmoves ON COMMIT DROP AS
SELECT DISTINCT ON (p.id) p.id AS personal_id, b.id AS business_id, p.username
  FROM accounts p
  JOIN accounts b
    ON (b.privy_user_id IS NOT NULL OR b.auth_subject IS NOT NULL)
   AND lower(b.login_wallet) = lower(p.login_wallet)
   AND b.username IS NULL
 WHERE p.privy_user_id IS NULL AND p.auth_subject IS NULL
   AND p.username IS NOT NULL
 ORDER BY p.id, b.created_at;

-- Cleared before written, for the same reason as the up: the unique index on
-- lower(username) is checked as each row is written, so the name cannot exist
-- on both rows for even an instant.
UPDATE accounts SET username = NULL
 WHERE id IN (SELECT personal_id FROM username_unmoves);

UPDATE accounts a
   SET username = u.username
  FROM username_unmoves u
 WHERE a.id = u.business_id;

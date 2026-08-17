-- auth_provider and auth_subject are one fact, not two.
--
-- Both are nullable and nothing tied them together, so a row could carry a
-- subject with no provider. The unique index is on the pair, so such a row
-- inserts happily -- and then lookupAuthPrincipal, which matches on BOTH
-- columns, can never find it. The account exists and its owner cannot sign in,
-- with nothing reporting an error anywhere.
--
-- Matching on both columns is deliberate (a subject is only unique within the
-- provider that issued it), so the fix belongs here: make the pair be present
-- together or absent together.
--
-- NOT VALID first, then VALIDATE: the constraint applies to new writes
-- immediately without taking a lock long enough to matter, and existing rows are
-- checked afterwards. If validation fails, there is already a half-identity row
-- to look at -- which is the bug, not a reason to drop the constraint.
ALTER TABLE accounts
    ADD CONSTRAINT accounts_auth_identity_complete
    CHECK ((auth_provider IS NULL) = (auth_subject IS NULL))
    NOT VALID;

ALTER TABLE accounts VALIDATE CONSTRAINT accounts_auth_identity_complete;

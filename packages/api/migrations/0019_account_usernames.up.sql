-- Usernames, so money can be sent to a name instead of 42 hex characters.
--
-- Bound to the ACCOUNT, not to the wallet address, and that distinction is the
-- whole design. A merchant account shares its wallet with the person's own
-- personal account today, so keying on the address would mean one address with
-- two names and no way to say which was meant. Keying on the account gives
-- @ivan -> the personal account and @acme -> the merchant account, both on one
-- wallet, each resolving to its own settle_address.
--
-- It also survives the change that is coming: when merchants get a settlement
-- address of their own, @acme simply points at the new one. Nothing about the
-- username has to move, and no backfill is needed.
ALTER TABLE accounts ADD COLUMN username TEXT;

-- Case-insensitive uniqueness, case-preserving storage.
--
-- Someone who types "Ivan" should see "Ivan", but nobody else may then take
-- "ivan" -- two names that differ only in case are the same name to a person
-- sending money, and that ambiguity is worth nothing and costs a misdirected
-- payment. The lookup lowercases to match this index.
CREATE UNIQUE INDEX idx_accounts_username ON accounts (lower(username))
    WHERE username IS NOT NULL;

-- The format is enforced in Go, where a rejection can explain itself. This is
-- the backstop: a bad row here would be resolvable by nobody and reachable by
-- no code path that validated, so the database refuses it outright.
--
-- 3-20 characters, letters/digits/underscore. No leading or trailing
-- underscore, and no dots or hyphens: those are the characters that make two
-- distinct names look identical in a chat message, which is exactly where these
-- get typed.
-- POSIX ERE, so no non-capturing groups: first character, 1-18 middle, last.
-- That is a minimum of 3 and a maximum of 20.
ALTER TABLE accounts ADD CONSTRAINT accounts_username_format
    CHECK (username IS NULL OR username ~ '^[A-Za-z0-9][A-Za-z0-9_]{1,18}[A-Za-z0-9]$');

-- A username names a person, so it must sit on a person's account.
--
-- 0019 bound usernames to the account rather than the wallet, and said why: one
-- wallet could hold both a personal account and a merchant account, so @ivan
-- resolving to the person and @acme to the business needed two rows, not two
-- addresses. That reasoning still holds. What it got wrong is a prediction it
-- makes at the end -- that when merchants got a settlement address of their own,
-- "@acme simply points at the new one" and "no backfill is needed".
--
-- No backfill was needed for @acme. It was needed for @ivan. While a business
-- settled to the wallet its owner signed in with, a name on the business row and
-- a name on the personal row resolved to the SAME address, so nothing ever
-- distinguished them. Provisioned settlement wallets separated those addresses,
-- and the dashboard's naming prompt writes against whichever account you are
-- signed in as -- so a person who claimed their own name while signed in as
-- their company ended up with their personal handle pointing at the company's
-- money.
--
-- This moves those names to where they were always meant to be. Handlers claim
-- against the personal account from here on (see usernameAccountFor), so this
-- runs once and has nothing to do on any later deployment.

-- Owners who have never needed a personal account get one now.
--
-- Same shape as personalAccountForWallet writes: settles to the login wallet,
-- source 'login_wallet', which for a personal account is the literal truth
-- rather than a default. The id is hex rather than the base32 NewID produces --
-- these ids are opaque and nothing parses them, and reproducing Go's alphabet
-- in SQL would buy nothing but a chance to get it subtly wrong.
--
-- DISTINCT ON, because one wallet can be behind more than one business and this
-- must create at most one personal account for it.
INSERT INTO accounts (id, name, settle_currency, settle_address, login_wallet,
                      settle_address_source, livemode)
SELECT DISTINCT ON (lower(b.login_wallet))
       'acct_' || substr(encode(gen_random_bytes(15), 'hex'), 1, 20),
       'Personal', 'USDC', b.login_wallet, b.login_wallet, 'login_wallet', false
  FROM accounts b
 WHERE b.username IS NOT NULL
   AND b.login_wallet IS NOT NULL
   AND (b.privy_user_id IS NOT NULL OR b.auth_subject IS NOT NULL)
   AND NOT EXISTS (
       SELECT 1 FROM accounts p
        WHERE p.privy_user_id IS NULL AND p.auth_subject IS NULL
          AND lower(p.login_wallet) = lower(b.login_wallet))
 ORDER BY lower(b.login_wallet);

-- Which name goes where, decided before anything moves.
--
-- Held in a temp table rather than done as one UPDATE ... FROM because the
-- unique index on lower(username) is checked per row as it is written: setting
-- the personal row's name while the business row still holds it is a collision
-- with itself. So the pairs are recorded, the old rows are cleared, and only
-- then are the new ones written.
--
-- DISTINCT ON (p.id): if two businesses on one wallet both hold a name, only one
-- can move -- the personal account has room for exactly one. The older name
-- wins, being the one more likely to have been given out, and the other is left
-- exactly where it is rather than silently dropped.
CREATE TEMP TABLE username_moves ON COMMIT DROP AS
SELECT DISTINCT ON (p.id) b.id AS business_id, p.id AS personal_id, b.username
  FROM accounts b
  JOIN accounts p
    ON p.privy_user_id IS NULL AND p.auth_subject IS NULL
   AND lower(p.login_wallet) = lower(b.login_wallet)
 WHERE b.username IS NOT NULL
   AND (b.privy_user_id IS NOT NULL OR b.auth_subject IS NOT NULL)
   -- Never over the top of a name the person already has. Somebody holding both
   -- keeps their personal one; the business one stays put and is a support
   -- question, not something a migration should decide.
   AND p.username IS NULL
 ORDER BY p.id, b.created_at;

UPDATE accounts SET username = NULL
 WHERE id IN (SELECT business_id FROM username_moves);

UPDATE accounts a
   SET username = m.username
  FROM username_moves m
 WHERE a.id = m.personal_id;

-- Usernames are letters and digits, starting with a letter.
--
-- 0019 allowed underscores. A username is what somebody types from memory into
-- a send box, or reads off a receipt and types back in, and the underscore is
-- the character people most reliably drop, double, or turn into a hyphen. Every
-- one of those is a payment addressed to nobody -- or, once somebody registers
-- the lookalike, to the wrong person entirely.
--
-- Requiring a letter first also means a name can never be all digits, so a
-- username cannot be mistaken for an id or an amount anywhere the two are shown
-- together.
--
-- POSIX ERE, so no non-capturing groups: first character, then 2-19 more. That
-- is a minimum of 3 and a maximum of 20, matching handlers.ValidateUsername.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_username_format;

-- NOT VALID, and deliberately never validated.
--
-- The constraint applies to every new claim and every update from this moment,
-- which is the whole point. Existing rows are left alone: a username already
-- claimed is somebody's identity, other people have already saved it and sent
-- money to it, and rewriting one to fit a new rule would silently redirect the
-- next payment addressed from memory. Refusing to boot over one would be worse
-- still -- the API runs migrations at startup and fails hard on error, so
-- validating here would take the whole service down for a name that works.
--
-- A pre-0022 name containing an underscore therefore keeps working and cannot
-- be re-created. That asymmetry is intended.
ALTER TABLE accounts ADD CONSTRAINT accounts_username_format
    CHECK (username IS NULL OR username ~ '^[A-Za-z][A-Za-z0-9]{2,19}$')
    NOT VALID;

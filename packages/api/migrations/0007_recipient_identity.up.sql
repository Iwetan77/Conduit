-- Phase 4: recipient identity. accounts.name already serves as the
-- required "display_name" the spec asks for (required at account creation
-- since migration 0001) -- the only genuinely new field is a logo.
ALTER TABLE accounts ADD COLUMN logo_url TEXT;

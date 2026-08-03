-- Personal (payer) accounts were named "Personal 0x<full 42-char address>".
-- That name is shown to payers as display_name on /pay for payer-created
-- (si_) links, where the full address overflowed the header on mobile. New
-- accounts are now named just "Personal"; backfill the existing ones. The
-- wallet is still available (login_wallet / settle_address) and is rendered
-- shortened on the pay screen already.
UPDATE accounts
SET name = 'Personal'
WHERE privy_user_id IS NULL
  AND name LIKE 'Personal 0x%';

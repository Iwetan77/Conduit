DROP INDEX IF EXISTS idx_payment_links_storefront;
ALTER TABLE payment_links DROP COLUMN IF EXISTS is_storefront;

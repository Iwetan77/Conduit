-- The standing payment link behind a storefront's printed QR code.
--
-- Storefronts (accounts with parent_id set) had a QR encoding their raw
-- settle_address. A phone camera can do nothing with a bare "0x..." string,
-- and any wallet that did parse it would send a raw transfer: no amount, no
-- FX conversion to the storefront's settle_currency, no cross-chain, and --
-- the whole point of a per-location QR -- no settlement row attributing the
-- takings to that storefront.
--
-- The QR should instead open the hosted pay page for a reusable, open-amount
-- link bound to the storefront. This flag marks that one link so it can be
-- fetched (or provisioned) idempotently per account rather than duplicated
-- every time the Storefronts page loads.
ALTER TABLE payment_links ADD COLUMN is_storefront BOOLEAN NOT NULL DEFAULT false;

-- At most one LIVE storefront link per account. Void/expired are excluded so
-- that retiring a storefront's link (a sticker walked off, a till moved) leaves
-- room to mint its replacement, while the partial index still makes the
-- get-or-create race-safe against two dashboard tabs loading at once.
--
-- Deliberately NOT scoped to status='active': Pay() moves a link to 'viewed'
-- the moment a customer opens checkout, so an active-only index would stop
-- matching mid-sale and provision a second link behind the same storefront.
CREATE UNIQUE INDEX idx_payment_links_storefront
    ON payment_links(account_id)
    WHERE is_storefront AND status NOT IN ('void', 'expired');

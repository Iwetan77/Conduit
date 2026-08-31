-- Reverting loses any outstanding verification challenges. Already-verified
-- destinations keep their verified_at and stay payable; anyone mid-verification
-- starts again.
ALTER TABLE payout_destinations DROP CONSTRAINT IF EXISTS payout_destinations_nonce_complete;
ALTER TABLE payout_destinations DROP COLUMN IF EXISTS nonce_expires_at;
ALTER TABLE payout_destinations DROP COLUMN IF EXISTS verification_nonce;

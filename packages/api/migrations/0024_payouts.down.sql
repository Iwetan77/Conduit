-- Reverting drops the record of every withdrawal a merchant made. The money has
-- moved regardless -- these rows describe transactions on chain, they are not
-- the transactions -- and the balance_transactions entries they produced are
-- left in place, so the ledger still shows the money leaving.
DROP TABLE IF EXISTS payouts;

-- The /quote step's own EIP-712 typed data (sig #1's target) needs to persist
-- between POST /:id/quote and POST /:id/prepare so /prepare can pass the
-- exact signed message back to StableFX's trade-creation call. Discovered
-- live (see internal/fx/stablefx.go's PrepareWithSignature doc comment) that
-- StableFX requires two signatures, not the one the original schema assumed
-- funding_typed_data alone would cover.
ALTER TABLE fx_trades ADD COLUMN quote_typed_data JSONB;
ALTER TABLE fx_trades ADD COLUMN pay_address TEXT;
-- StableFX's trade UUID (trade.id) is distinct from contract_trade_id
-- (trade.contractTradeId, the on-chain numeric id) -- both are needed:
-- contract_trade_id for the presign call, this for polling trade status.
ALTER TABLE fx_trades ADD COLUMN stablefx_trade_uuid TEXT;

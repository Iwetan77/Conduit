# Currencies

Generated from a live `GET /v1/currencies` call — this is what's actually routable right now (registered in `CurrencyRegistry` on-chain, confirmed against StableFX/AMM coverage), not a static list someone forgot to update. Re-run `scripts/generate-currencies-doc.ts` to refresh.

| ISO | Token | Address | Decimals |
|---|---|---|---|
| USD | USDC | `0x3600000000000000000000000000000000000000` | 6 |
| EUR | EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | 6 |
| BRL | BRLA | `0x8629020763F6239643a02e664a25BF4AD7787254` | 18 |
| AUD | AUDF | `0xd2a530170D71a9Cfe1651Fb468E2B98F7Ed7456b` | 6 |
| MXN | MXNB | `0x836F73Fbc370A9329Ba4957E47912DfDBA6BA461` | 6 |
| CAD | QCAD | `0x23d7CFFd0876f3ABb6B074287ba2aeefBc83825d` | 6 |
| GBP | GBPA | `0xa42e82b5D25E84d107Cd8549CA432ef489CbaD32` | 6 |
| ZAR | ZARU | `0x47b025D6002234a5038bCD94767bd82b27C2b96F` | 18 |
| KRW | KRW1 | `0xC5bD9EBB09446F5F94E3b3D899072fC2eC5d3a1a` | 18 |
| CHF | CHFAU | `0x74ef206336F87843485E5f3fdaEA13ba4ec309E7` | 6 |
| EURAU | EURAU | `0x67521a2b4b385eEB2c65695C23457e04dC8A6331` | 6 |

Not every pair above is routable against every other — see [docs/fx-capability.md](./fx-capability.md) for the hub-and-spoke constraint: StableFX quotes go through USDC on one leg.

There is no AMM fallback. An on-chain swap route was built and is not used: Arc has no USDC/EURC pool, so it could never settle a payment. Circle StableFX is the only cross-currency path. The code for the AMM route still exists (`ConduitRouter.executeWithAmm`, the SDK's `swap`), unreferenced by the app and the API.

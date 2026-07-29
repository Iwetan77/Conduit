# State diagrams

Two lifecycles, not one — the settlement intent and the FX trade nested inside it move
independently.

## Settlement intent

```mermaid
stateDiagram-v2
    [*] --> created
    created --> quoted: POST /:id/quote
    quoted --> funding: POST /:id/prepare
    funding --> settling: POST /:id/confirm
    settling --> settled
    created --> expired
    quoted --> expired
    funding --> failed
    created --> canceled: POST /:id/cancel
```

## FX trade (nested inside quoted -> settled above)

```mermaid
stateDiagram-v2
    [*] --> quoted
    quoted --> trade_created
    trade_created --> presigned
    presigned --> awaiting_signature
    awaiting_signature --> submitted
    submitted --> settled
    quoted --> expired
    trade_created --> expired
    presigned --> expired
    awaiting_signature --> expired
    submitted --> failed
```

Illegal transitions are rejected in code, not just documented — `fx_trades.state` only
ever moves forward along the arrows above (or into `expired`/`failed`), never sideways or
backward.

**What happens if the process dies between `prepare` and `confirm`:** nothing
automatically recovers it today. The `fx_trades` row sits in `presigned` (or
`awaiting_signature`) state forever. A sweeper for stale rows past `quote_expires_at`
doesn't exist yet — this is a real, open gap, not an oversight buried in code. Money
isn't at risk (nothing was funded on-chain yet at that point in the flow — funding only
happens in `confirm`), but the intent will look permanently stuck rather than cleanly
`expired` until that sweeper is built.

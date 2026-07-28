package fx

import (
	"context"
	"fmt"
	"math/big"
	"time"
)

// DirectProvider handles same-currency settlement: no FX at all, just
// ConduitRouter.execute(). Unchanged by this build per the architecture delta.
type DirectProvider struct{}

func (DirectProvider) Name() string { return "direct" }

func (DirectProvider) Quote(ctx context.Context, from, to string, settleAmount *big.Int, recipientAddress string) (Quote, error) {
	if from != to {
		return Quote{}, fmt.Errorf("fx: DirectProvider.Quote called with different currencies %s != %s", from, to)
	}
	return Quote{
		Provider:     "direct",
		FromCurrency: from,
		ToCurrency:   to,
		FromAmount:   new(big.Int).Set(settleAmount),
		ToAmount:     new(big.Int).Set(settleAmount),
		Rate:         "1",
		ExpiresAt:    time.Now().Add(10 * time.Minute).Unix(),
	}, nil
}

func (DirectProvider) Prepare(ctx context.Context, q Quote, payer, recipient string) (Preparation, error) {
	// Same-currency settlement goes through ConduitRouter.execute() (a plain
	// ERC-20 approve + call, no Permit2/EIP-712 signing) — there's nothing to
	// presign here. The handler layer skips straight to submission for direct
	// payments; this exists only so DirectProvider satisfies Provider.
	return Preparation{Provider: "direct"}, nil
}

func (DirectProvider) Submit(ctx context.Context, p Preparation, signature string) (string, error) {
	return "", fmt.Errorf("fx: DirectProvider.Submit not used — same-currency settlement calls onchain.SubmitDirect")
}

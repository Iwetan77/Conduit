package handlers

import (
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// A merchant's settle address receives a continuous stream of transfers, most
// never claimed by a /record call. Matching a reported transaction on "some
// transfer of the settle token reached the merchant for at least the amount"
// therefore let anyone create an intent against that merchant, watch for an
// unclaimed transfer, and report it -- the intent settles and
// settlement.succeeded fires, so the merchant ships goods having been paid once
// for two orders.
//
// Requiring our own router's PaymentSettled closes it, because a stray transfer
// does not carry one. These exercise that predicate directly: it is the whole
// of the new check, and it is pure, so it can be tested without a chain.
func TestRouterSettledThisIntent(t *testing.T) {
	var (
		router    = common.HexToAddress("0x80f996e86C003AF309635B67A53dC6e63e623318")
		other     = common.HexToAddress("0x1111111111111111111111111111111111111111")
		recipient = common.HexToAddress("0x0000000000000000000000000000000000000009")
		attacker  = common.HexToAddress("0x000000000000000000000000000000000000dEaD")
		token     = common.HexToAddress("0x3600000000000000000000000000000000000000")
		otherTok  = common.HexToAddress("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a")
		amount    = big.NewInt(100_000_000)
	)

	// data = payerToken | recipientToken | payerAmount | recipientAmount | ...
	data := func(payerTok, recipTok common.Address, payerAmt, recipAmt *big.Int) []byte {
		b := make([]byte, 0, 192)
		b = append(b, common.LeftPadBytes(payerTok.Bytes(), 32)...)
		b = append(b, common.LeftPadBytes(recipTok.Bytes(), 32)...)
		b = append(b, common.LeftPadBytes(payerAmt.Bytes(), 32)...)
		b = append(b, common.LeftPadBytes(recipAmt.Bytes(), 32)...)
		b = append(b, make([]byte, 64)...) // declarationId, settledAt
		return b
	}
	settledLog := func(emitter, recip common.Address, d []byte) *types.Log {
		return &types.Log{
			Address: emitter,
			Topics: []common.Hash{
				paymentSettledTopic,
				common.HexToHash("0x01"),          // receiptId
				common.HexToHash("0x02"),          // payer
				common.BytesToHash(recip.Bytes()), // recipient
			},
			Data: d,
		}
	}

	good := settledLog(router, recipient, data(token, token, amount, amount))

	cases := []struct {
		name string
		logs []*types.Log
		want bool
	}{
		{
			name: "our router settled exactly this payment",
			logs: []*types.Log{good},
			want: true,
		},
		{
			// The attack: a real transfer to the merchant, no router event.
			name: "a bare transfer to the merchant is not evidence",
			logs: []*types.Log{{
				Address: token,
				Topics: []common.Hash{
					erc20TransferTopic,
					common.BytesToHash(attacker.Bytes()),
					common.BytesToHash(recipient.Bytes()),
				},
				Data: common.LeftPadBytes(amount.Bytes(), 32),
			}},
			want: false,
		},
		{
			name: "no logs at all",
			logs: nil,
			want: false,
		},
		{
			// Anyone can deploy a contract that emits this shape.
			name: "the same event from a different contract",
			logs: []*types.Log{settledLog(other, recipient, data(token, token, amount, amount))},
			want: false,
		},
		{
			name: "our router paid somebody else",
			logs: []*types.Log{settledLog(router, attacker, data(token, token, amount, amount))},
			want: false,
		},
		{
			name: "right recipient, wrong token",
			logs: []*types.Log{settledLog(router, recipient, data(otherTok, otherTok, amount, amount))},
			want: false,
		},
		{
			name: "less than the intent requires",
			logs: []*types.Log{settledLog(router, recipient, data(token, token, amount, big.NewInt(99_000_000)))},
			want: false,
		},
		{
			// Overpayment is not this intent either: the router delivers
			// exactly instruction.amount.
			name: "more than the intent requires",
			logs: []*types.Log{settledLog(router, recipient, data(token, token, amount, big.NewInt(101_000_000)))},
			want: false,
		},
		{
			name: "truncated data is not decoded optimistically",
			logs: []*types.Log{{
				Address: router,
				Topics: []common.Hash{
					paymentSettledTopic,
					common.HexToHash("0x01"),
					common.HexToHash("0x02"),
					common.BytesToHash(recipient.Bytes()),
				},
				Data: make([]byte, 64),
			}},
			want: false,
		},
		{
			name: "found among unrelated logs",
			logs: []*types.Log{
				{Address: otherTok, Topics: []common.Hash{erc20TransferTopic}},
				good,
			},
			want: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := routerSettledThisIntent(
				&types.Receipt{Logs: tc.logs}, router, recipient, token, amount)
			if got != tc.want {
				t.Errorf("routerSettledThisIntent = %v, want %v", got, tc.want)
			}
		})
	}
}

// The test above builds its logs from the same topic and byte offsets the
// predicate reads, so it would pass just as happily if both were wrong. This
// checks those two assumptions against the contract's real ABI -- the same one
// the indexer decodes with -- so the layout is verified rather than agreed with
// itself.
func TestPaymentSettledLayoutMatchesTheABI(t *testing.T) {
	const paymentSettledABI = `[{"anonymous":false,"inputs":[
	  {"indexed":true,"name":"receiptId","type":"bytes32"},
	  {"indexed":true,"name":"payer","type":"address"},
	  {"indexed":true,"name":"recipient","type":"address"},
	  {"indexed":false,"name":"payerToken","type":"address"},
	  {"indexed":false,"name":"recipientToken","type":"address"},
	  {"indexed":false,"name":"payerAmount","type":"uint256"},
	  {"indexed":false,"name":"recipientAmount","type":"uint256"},
	  {"indexed":false,"name":"declarationId","type":"bytes32"},
	  {"indexed":false,"name":"settledAt","type":"uint256"}
	],"name":"PaymentSettled","type":"event"}]`

	parsed, err := abi.JSON(strings.NewReader(paymentSettledABI))
	if err != nil {
		t.Fatalf("parse ABI: %v", err)
	}
	ev, ok := parsed.Events["PaymentSettled"]
	if !ok {
		t.Fatal("PaymentSettled missing from the ABI")
	}

	if ev.ID != paymentSettledTopic {
		t.Fatalf("topic hash disagrees with the ABI:\n  ours: %s\n  abi:  %s\n"+
			"the predicate would match no real event", paymentSettledTopic, ev.ID)
	}

	// And the offsets: unpack data built the way the test above builds it, and
	// check the ABI reads back the fields the predicate reads by slicing.
	token := common.HexToAddress("0x3600000000000000000000000000000000000000")
	want := big.NewInt(100_000_000)

	data := make([]byte, 0, 192)
	data = append(data, common.LeftPadBytes(token.Bytes(), 32)...)
	data = append(data, common.LeftPadBytes(token.Bytes(), 32)...)
	data = append(data, common.LeftPadBytes(big.NewInt(123).Bytes(), 32)...)
	data = append(data, common.LeftPadBytes(want.Bytes(), 32)...)
	data = append(data, make([]byte, 64)...)

	var out struct {
		PayerToken      common.Address
		RecipientToken  common.Address
		PayerAmount     *big.Int
		RecipientAmount *big.Int
		DeclarationId   [32]byte
		SettledAt       *big.Int
	}
	if err := parsed.UnpackIntoInterface(&out, "PaymentSettled", data); err != nil {
		t.Fatalf("unpack: %v", err)
	}
	if out.RecipientToken != token {
		t.Errorf("recipientToken at bytes 32:64 disagrees with the ABI: got %s", out.RecipientToken)
	}
	if out.RecipientAmount.Cmp(want) != 0 {
		t.Errorf("recipientAmount at bytes 96:128 disagrees with the ABI: got %s, want %s",
			out.RecipientAmount, want)
	}
}

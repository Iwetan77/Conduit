package handlers

// Giving a business an address that is actually its own.
//
// A merchant account's settle_address has always defaulted to the wallet used
// to sign in, silently, and nothing ever asked. So business income arrives in a
// personal wallet by default. The fix is not to ask a better question at
// onboarding -- Arc is new, and almost nobody has a second Arc address to name
// -- it is to hand the account one that was always theirs.
//
// The wallet is created by the BROWSER, not here. Circle's user-controlled
// wallets derive their key material on the user's own device, so the API
// returns a challenge and the SDK finishes it; there is no server-side path
// that produces a wallet, by design (see docs/circle-wallet-capability.md).
// What the server can do -- and the only thing that makes this safe -- is
// refuse to believe the browser about which address it got.
//
// So the request carries a wallet ID and nothing else. The address is read back
// from Circle, for this user's token, and written from THAT. A handler that
// stored an address out of the request body would hand anyone who can call it
// the ability to redirect a merchant's income, which is the exact hole this
// work exists to close.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/auth"
	"github.com/kzn-labs/conduit/api/internal/circle"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

type SettlementWallet struct {
	Pool   *pgxpool.Pool
	Client *circle.Client
	// The blockchain identifier an Arc wallet carries in ListWallets.
	//
	// Read back from Circle rather than assumed: the probe confirmed it matches
	// what /user/initialize is sent, but those are two different APIs and only
	// one of them is what a wallet actually reports.
	ArcBlockchain string
}

type provisionSettlementWalletRequest struct {
	// The id of the wallet the browser just created. Deliberately the ONLY
	// field. An address here would be an address we did not verify.
	WalletID string `json:"wallet_id"`
}

type settlementWalletResponse struct {
	SettleAddress         string `json:"settle_address"`
	SettleWalletID        string `json:"settle_wallet_id"`
	SettleAddressSource   string `json:"settle_address_source"`
	SettlementWalletReady bool   `json:"settlement_wallet_ready"`
}

// account state this handler needs, read once.
type settlementAccount struct {
	loginWallet    *string
	settleWalletID *string
	settleAddress  string
	source         *string
	// A row with no identity in ANY identity column is a payer's wallet-keyed
	// account, not a business. Same predicate as personalAccountForWallet and
	// as migration 0015's index -- written once, in one place, because getting
	// it wrong is what 0015 exists to correct.
	personal bool
}

func (h *SettlementWallet) load(r *http.Request, accountID string) (*settlementAccount, error) {
	var a settlementAccount
	err := h.Pool.QueryRow(r.Context(),
		`SELECT login_wallet, settle_wallet_id, settle_address, settle_address_source,
		        (privy_user_id IS NULL AND auth_subject IS NULL) AS personal
		   FROM accounts WHERE id = $1`,
		accountID,
	).Scan(&a.loginWallet, &a.settleWalletID, &a.settleAddress, &a.source, &a.personal)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (a *settlementAccount) ready() bool {
	return a.settleWalletID != nil && a.source != nil && *a.source == sourceProvisioned
}

const (
	sourceProvisioned = "provisioned"
	sourceLoginWallet = "login_wallet"
	sourceExternal    = "external"
)

// settlementWalletReady reports whether an account may take payments yet.
//
// The rule is narrow on purpose. It refuses exactly one situation: a business
// that signed in with Google, was never given an address of its own, and would
// therefore settle to its owner's personal wallet. Everything else passes --
//
//   - API-key accounts supplied their own address on creation ('external'),
//     which is a decision somebody made rather than a default nobody saw.
//   - Personal accounts settle to the wallet that signed in by definition.
//   - Storefronts inherit their parent's address and are checked through it.
//
// Refusing rather than defaulting is the point. The alternative is a payment
// link, printed and pasted and outliving this decision, quietly pointing a
// business's income at its owner's own wallet.
func settlementWalletReady(ctx context.Context, pool *pgxpool.Pool, accountID string) *apierrors.APIError {
	var source *string
	var hasIdentity bool
	err := pool.QueryRow(ctx,
		`SELECT settle_address_source,
		        (privy_user_id IS NOT NULL OR auth_subject IS NOT NULL) AS has_identity
		   FROM accounts WHERE id = COALESCE((SELECT parent_id FROM accounts WHERE id = $1), $1)`,
		accountID,
	).Scan(&source, &hasIdentity)
	if err != nil {
		// A missing account is not this check's problem to report -- the caller
		// is about to fail on it far more precisely.
		return nil
	}
	if !hasIdentity {
		return nil
	}
	if source != nil && (*source == sourceProvisioned || *source == sourceExternal) {
		return nil
	}
	return apierrors.E(apierrors.CodeSettlementWalletRequired, "")
}

// Provision is POST /v1/accounts/me/settlement_wallet.
//
// Session auth, plus the caller's Circle user token: the server cannot mint one
// of those for a Google user (Circle refuses `POST /v1/w3s/users/token` for an
// SSO user outright), so acting on a merchant's wallets is only possible while
// their browser is holding the session. That is a constraint of Circle's design
// rather than a choice here, and it is why this is a request rather than a
// background job.
func (h *SettlementWallet) Provision(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}
	var req provisionSettlementWalletRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "body"))
		return
	}
	req.WalletID = strings.TrimSpace(req.WalletID)
	if req.WalletID == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "wallet_id"))
		return
	}

	acct, err := h.load(r, principal.AccountID)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, apierrors.E(apierrors.CodeNotFound, ""))
			return
		}
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	// Personal accounts are out of scope, and not as an oversight. A payer's
	// wallet-keyed row settles to the wallet that signed in BY DEFINITION --
	// there is no second party whose money could land in the wrong place, and
	// provisioning one would move a payer's own funds somewhere they did not
	// ask for.
	if acct.personal {
		writeErr(w, apierrors.E(apierrors.CodeForbidden, ""))
		return
	}

	// Idempotent, and deliberately BEFORE Circle is consulted.
	//
	// The address behind this wallet was verified against Circle when it was
	// first written; asking again proves nothing new and would make a retry
	// fail whenever Circle is briefly unreachable. A repeated call is the
	// normal case, not an edge one: the browser re-runs provisioning whenever
	// it loads an account that is not ready yet.
	if acct.settleWalletID != nil && *acct.settleWalletID == req.WalletID {
		writeJSON(w, http.StatusOK, settlementWalletResponse{
			SettleAddress:         acct.settleAddress,
			SettleWalletID:        *acct.settleWalletID,
			SettleAddressSource:   derefOr(acct.source, ""),
			SettlementWalletReady: acct.ready(),
		})
		return
	}

	// A DIFFERENT wallet on an account that already has one is not
	// provisioning, it is moving where income lands. That is a deliberate act
	// with its own confirmation, and it does not belong on a path the browser
	// runs automatically at sign-in.
	if acct.settleWalletID != nil {
		writeErr(w, apierrors.E(apierrors.CodeSettlementWalletSet, ""))
		return
	}

	// The Circle session is demanded HERE, not at the top, because only what
	// follows needs it. Whether an account is a business, and whether it is
	// already provisioned, are facts about our own database — answering them
	// first means a repeat call still succeeds when Circle is unreachable, and
	// a payer's account is refused without a round trip to anyone.
	if h.Client == nil || !h.Client.Configured() {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	token := userToken(r)
	if token == "" {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}

	wallets, err := h.Client.ListWallets(r.Context(), token)
	if err != nil {
		// The caller's token is what this call is made with, so a rejection
		// from Circle is far more likely to be an expired session than an
		// outage. Say unauthorized rather than blaming the server for it.
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, "X-Circle-User-Token"))
		return
	}

	var found *circle.Wallet
	for i := range wallets {
		if wallets[i].ID == req.WalletID {
			found = &wallets[i]
			break
		}
	}
	// Not in this user's list means the caller does not own it -- whether it is
	// somebody else's wallet or one that never existed. This single check is
	// what makes the whole endpoint safe to expose.
	if found == nil {
		writeErr(w, apierrors.E(apierrors.CodeSettlementWalletUnknown, "wallet_id"))
		return
	}
	if !strings.EqualFold(found.Blockchain, h.ArcBlockchain) {
		// Conduit settles on Arc. An address on another chain would be a
		// perfectly valid address that no payment can ever reach.
		writeErr(w, apierrors.E(apierrors.CodeSettlementWalletInvalid, "blockchain"))
		return
	}
	if found.Address == "" {
		writeErr(w, apierrors.E(apierrors.CodeSettlementWalletInvalid, "address"))
		return
	}
	// The sign-in wallet is the thing being moved AWAY from. Accepting it would
	// satisfy every check here and change nothing -- business income would
	// still be landing in the owner's personal wallet, now with a record
	// claiming somebody chose that.
	if acct.loginWallet != nil && strings.EqualFold(found.Address, *acct.loginWallet) {
		writeErr(w, apierrors.E(apierrors.CodeSettlementWalletInvalid, "wallet_id"))
		return
	}

	// The address comes from `found`, which came from Circle. Never from req.
	//
	// Provisioning also answers the payout question, so it records that too.
	// The one-time "where should this business be paid?" prompt exists because
	// settle_address defaulted to the sign-in wallet with nobody choosing it --
	// which is no longer true of this account. Leaving it unanswered would ask a
	// merchant to pick an address seconds after being given one.
	const q = `UPDATE accounts
	              SET settle_wallet_id = $1,
	                  settle_address = $2,
	                  -- Remembered separately from settle_address, which can be
	                  -- pointed elsewhere later. This is the address to come
	                  -- back to, and the server cannot ask Circle for it again.
	                  provisioned_address = $2,
	                  settle_address_source = 'provisioned',
	                  payout_confirmed_at = COALESCE(payout_confirmed_at, now())
	            WHERE id = $3 AND settle_wallet_id IS NULL`
	tag, err := h.Pool.Exec(r.Context(), q, found.ID, found.Address, principal.AccountID)
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	// `settle_wallet_id IS NULL` in the WHERE rather than a re-read: two tabs
	// finishing their challenges at once would otherwise both pass the check
	// above and the second would overwrite the first. Losing the race here
	// means somebody else already provisioned, which is a success for the
	// caller's purposes -- report what actually landed.
	if tag.RowsAffected() == 0 {
		acct, err = h.load(r, principal.AccountID)
		if err != nil {
			writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
			return
		}
		writeJSON(w, http.StatusOK, settlementWalletResponse{
			SettleAddress:         acct.settleAddress,
			SettleWalletID:        derefOr(acct.settleWalletID, ""),
			SettleAddressSource:   derefOr(acct.source, ""),
			SettlementWalletReady: acct.ready(),
		})
		return
	}

	writeJSON(w, http.StatusOK, settlementWalletResponse{
		SettleAddress:         found.Address,
		SettleWalletID:        found.ID,
		SettleAddressSource:   sourceProvisioned,
		SettlementWalletReady: true,
	})
}

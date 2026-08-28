package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kzn-labs/conduit/api/internal/auth"
	apierrors "github.com/kzn-labs/conduit/api/internal/errors"
)

// Usernames lets an account be paid by name instead of by address.
//
// The name belongs to the ACCOUNT, not to the wallet -- see migration 0019 for
// why. Everything here follows from that: resolution answers with the
// account's settle_address, so the day a merchant gets an address of its own,
// the same name starts pointing at it with nothing to migrate.
type Usernames struct {
	Pool *pgxpool.Pool
}

// usernamePattern mirrors the CHECK constraint in migration 0019 exactly.
//
// Two copies of one rule is a thing that drifts, so the intent is worth
// stating: the database's copy exists to make an invalid row impossible from
// ANY path, and this copy exists so a person typing a name gets told why it was
// refused instead of a generic failure. If one changes, the other must.
var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_]{1,18}[A-Za-z0-9]$`)

// Names nobody may claim.
//
// Two separate reasons, deliberately kept in one list because the check is the
// same: names that would let someone impersonate Conduit itself ("support",
// "admin"), and names already meaningful as routes or as the suffix every
// username is displayed with. A payer who sees "@support" in a chat has no way
// to tell it is not us.
var reservedUsernames = map[string]bool{
	"conduit": true, "admin": true, "support": true, "help": true, "root": true,
	"official": true, "team": true, "security": true, "billing": true, "system": true,
	"api": true, "www": true, "app": true, "docs": true, "dashboard": true,
	"send": true, "pay": true, "create": true, "links": true, "history": true,
	"settings": true, "login": true, "logout": true, "signup": true, "account": true,
	"me": true, "claim": true, "available": true, "wallets": true, "usernames": true, "null": true, "undefined": true, "anonymous": true, "conduitpay": true,
}

var errUsernameTaken = errors.New("username taken")

// ValidateUsername reports why a name cannot be used, or nil if it can.
//
// Length is checked before the pattern so "too short" does not surface as
// "invalid characters", which is the kind of wrong-but-technically-true error
// that makes someone try the same thing three times.
func ValidateUsername(name string) error {
	switch {
	case len(name) < 3:
		return errors.New("username must be at least 3 characters")
	case len(name) > 20:
		return errors.New("username must be at most 20 characters")
	case !usernamePattern.MatchString(name):
		return errors.New("username may use only letters, numbers and underscores, and must start and end with a letter or number")
	case reservedUsernames[strings.ToLower(name)]:
		return errors.New("that username is reserved")
	}
	return nil
}

type usernameResolution struct {
	Username string `json:"username"`
	// What to show a sender before they confirm. The account's own name, so a
	// business resolves to the business.
	DisplayName string `json:"display_name"`
	// Where a payment to this name settles. The reason the endpoint is public:
	// a payer typing a name has no API key and needs an address to pay to.
	SettleAddress  string `json:"settle_address"`
	SettleCurrency string `json:"settle_currency"`
	// "personal" or "business".
	//
	// One wallet can hold both, and both can hold a name, so a name alone does
	// not say which you are paying. @Ivan resolving to "Ivan and Sons" is
	// correct and still reads as a surprise unless the surface can say it is
	// the BUSINESS. The namespace stays single and unambiguous -- one name, one
	// destination -- and this is what removes the confusion instead.
	AccountType string `json:"account_type"`
}

// Resolve turns a name into the address to pay. Public, and necessarily so.
//
// Deliberately exposes only what is needed to address a payment: the name, the
// display name and the settlement address. Not the account id, not the owner's
// login identity, and nothing about their balances or history -- a username is
// a mailbox, and knowing someone's mailbox must not reveal what is in it.
func (h *Usernames) Resolve(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(chi.URLParam(r, "username"))
	if name == "" {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "username"))
		return
	}

	var res usernameResolution
	err := h.Pool.QueryRow(r.Context(),
		`SELECT username, name, settle_address, settle_currency,
		        CASE WHEN privy_user_id IS NULL AND auth_subject IS NULL
		             THEN 'personal' ELSE 'business' END AS account_type
		   FROM accounts
		  WHERE lower(username) = lower($1)`,
		name,
	).Scan(&res.Username, &res.DisplayName, &res.SettleAddress, &res.SettleCurrency,
		&res.AccountType)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, apierrors.E(apierrors.CodeNotFound, "no account with that username"))
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// Available answers the live check while someone types a name.
//
// Always 200, with the answer in the body. A 4xx here would be read by every
// layer in between -- fetch wrappers, error boundaries, logs -- as a failure,
// when "that name is taken" is a perfectly successful answer to the question
// being asked.
func (h *Usernames) Available(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(chi.URLParam(r, "username"))

	if err := ValidateUsername(name); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "reason": err.Error()})
		return
	}

	var exists bool
	if err := h.Pool.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM accounts WHERE lower(username) = lower($1))`, name,
	).Scan(&exists); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	if exists {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "reason": "that username is taken"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": true})
}

type claimUsernameRequest struct {
	Username string `json:"username"`
}

// Claim sets the calling account's username, once.
//
// Once is the point. A username is what other people save and send money to,
// so letting it be reassigned means a payment addressed from memory can land
// with a stranger who picked up the abandoned name. Changing one is a support
// action with a redirect behind it, not a settings field, and until that
// exists the honest behaviour is to refuse.
func (h *Usernames) Claim(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, apierrors.E(apierrors.CodeUnauthorized, ""))
		return
	}

	var req claimUsernameRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "malformed JSON body"))
		return
	}
	name := strings.TrimSpace(req.Username)
	if err := ValidateUsername(name); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, err.Error()))
		return
	}

	switch err := claimUsername(r.Context(), h.Pool, principal.AccountID, name); {
	case errors.Is(err, errUsernameTaken):
		writeErr(w, apierrors.E(apierrors.CodeUsernameTaken, ""))
		return
	case errors.Is(err, errUsernameAlreadySet):
		writeErr(w, apierrors.E(apierrors.CodeUsernameAlreadySet, ""))
		return
	case err != nil:
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"username": name})
}

// ── Wallet-signature claiming ───────────────────────────────────────────────
//
// A payer with only an EVM wallet has no session and no API key -- their
// personal account is created lazily the first time they send. So the
// session-authenticated Claim above cannot reach them, and they are half the
// people this feature is for.
//
// Proof of wallet control is the credential instead, exactly as
// /v1/wallet_settlements does it: a personal_sign over a fixed message with a
// timestamp. Reusing that verification rather than inventing a second one, so
// there is one signature path to get right.
//
// Solana wallets are absent by construction. The message is EIP-191 and the
// recovery yields an Ethereum address, so a Solana signature cannot verify
// here -- which matches the rule that a name may only be bound to an address
// Conduit can actually settle to on Arc.

type claimUsernameWithWalletRequest struct {
	Wallet    string `json:"wallet"`
	Timestamp int64  `json:"timestamp"`
	Signature string `json:"signature"`
	Username  string `json:"username"`
}

// usernameClaimMessage is what the wallet signs. Fixed format, no free text,
// and it names the ACTION -- someone approving this is told they are claiming a
// username, not handed an opaque blob.
func usernameClaimMessage(wallet, username string, timestamp int64) string {
	return "Conduit: claim username\n\nUsername: " + username +
		"\nWallet: " + strings.ToLower(wallet) +
		"\nTimestamp: " + strconv.FormatInt(timestamp, 10)
}

// ClaimWithWallet claims a name for the wallet's own personal account.
func (h *Usernames) ClaimWithWallet(w http.ResponseWriter, r *http.Request) {
	var req claimUsernameWithWalletRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "malformed JSON body"))
		return
	}
	if !common.IsHexAddress(req.Wallet) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "wallet"))
		return
	}
	name := strings.TrimSpace(req.Username)
	if err := ValidateUsername(name); err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, err.Error()))
		return
	}

	// Same ten-minute window as the history read: generous enough for clock
	// skew and a slow connection, tight enough that a leaked signature is not a
	// standing credential.
	now := time.Now().Unix()
	if req.Timestamp == 0 || req.Timestamp < now-600 || req.Timestamp > now+120 {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "timestamp"))
		return
	}
	// The username is INSIDE the signed message, so a captured signature cannot
	// be replayed to claim a different name than the one approved.
	if !verifyPersonalSign(req.Wallet, usernameClaimMessage(req.Wallet, name, req.Timestamp), req.Signature) {
		writeErr(w, apierrors.E(apierrors.CodeSignatureInvalid, "signature"))
		return
	}

	// The account is created here if this wallet has never sent anything, which
	// is the normal case for someone claiming a name on their first visit.
	// USDC is the default settle currency for a personal account, matching what
	// a direct send would have chosen.
	accountID, err := personalAccountForWallet(r.Context(), h.Pool, req.Wallet, "USDC")
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}

	switch err := claimUsername(r.Context(), h.Pool, accountID, name); {
	case errors.Is(err, errUsernameTaken):
		writeErr(w, apierrors.E(apierrors.CodeUsernameTaken, ""))
		return
	case errors.Is(err, errUsernameAlreadySet):
		writeErr(w, apierrors.E(apierrors.CodeUsernameAlreadySet, ""))
		return
	case err != nil:
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"username": name})
}

// ByWallet reports the name held by a wallet's personal account, if any.
//
// Public, and it discloses nothing new: username -> address is already public
// because that is the whole feature, and this is the same pairing read the
// other way. It exists so the app can show someone their own name, and so a
// sender can see that an address they already have is a known handle.
func (h *Usernames) ByWallet(w http.ResponseWriter, r *http.Request) {
	wallet := strings.TrimSpace(chi.URLParam(r, "address"))
	if !common.IsHexAddress(wallet) {
		writeErr(w, apierrors.E(apierrors.CodeInvalidRequest, "address"))
		return
	}
	// ANY account on this wallet, not just the personal one.
	//
	// It filtered to personal accounts, which is the wrong question. One wallet
	// can hold both a personal account and a merchant account -- that is the
	// whole reason usernames bind to accounts -- and the name may sit on either.
	// Someone who claimed a name while signed in as their business then saw the
	// anonymous dot in the nav forever: the name existed, on an account this
	// query refused to look at.
	//
	// Personal first when both have one, because this is the fallback used when
	// there is NO session; with a session the caller prefers /accounts/me, which
	// is the authoritative answer for whoever is actually signed in.
	var username *string
	err := h.Pool.QueryRow(r.Context(),
		`SELECT username FROM accounts
		  WHERE lower(login_wallet) = lower($1) AND username IS NOT NULL
		  ORDER BY (privy_user_id IS NULL AND auth_subject IS NULL) DESC
		  LIMIT 1`,
		wallet,
	).Scan(&username)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && username == nil) {
		// Not an error. Most wallets have no username, and a 404 here would be
		// logged and surfaced as a failure on every page load that asks.
		writeJSON(w, http.StatusOK, map[string]any{"username": nil})
		return
	}
	if err != nil {
		writeErr(w, apierrors.E(apierrors.CodeInternal, ""))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"username": username})
}

var errUsernameAlreadySet = errors.New("username already set")

// claimUsername writes the name, refusing both a second name for one account
// and a name already held by another.
//
// The WHERE clause carries the "only if unset" rule rather than a read followed
// by a write, which two requests in the same moment would both pass. The unique
// index carries the "nobody else has it" rule for the same reason: a prior
// SELECT proves only that it was free a moment ago, and the moment matters when
// two people are typing the same name at once.
func claimUsername(ctx context.Context, pool *pgxpool.Pool, accountID, name string) error {
	tag, err := pool.Exec(ctx,
		`UPDATE accounts SET username = $1 WHERE id = $2 AND username IS NULL`,
		name, accountID,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return errUsernameTaken
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return errUsernameAlreadySet
	}
	return nil
}

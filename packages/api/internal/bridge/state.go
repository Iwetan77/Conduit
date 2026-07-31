// Package bridge models the Circle Gateway cross-chain funding pre-stage
// that runs ahead of Conduit's existing settlement engine when a payer funds
// an intent from a non-Arc chain. This state graph was originally written
// for raw CCTP's burn/attest/mint mechanism and is REUSED, not rebuilt, for
// Gateway's deposit/burn-intent/forwarder-mint mechanism -- the shape of a
// multi-step funding pipeline with an irreversible first step and a
// possible-while-payer-absent completion doesn't change just because the
// provider underneath does (see audit/BRIDGE-SCRAP.md's KEEP-AND-GENERALIZE
// verdict). This is deliberately a separate state machine from settlement's
// own status column -- a bridge transfer either lands on Arc or it doesn't,
// and only once it has (state == minted) does the settlement
// engine's own quote/settle flow begin. See README.md for the orphaned-burn
// failure model this state machine exists to make explicit.
package bridge

import (
	"errors"
	"fmt"
)

// State is a bridge_transfers.state value. Keep in sync with the CHECK
// constraint in migrations/0003_bridge_transfers.up.sql.
type State string

const (
	StateInitiated           State = "initiated"
	StateBurnSubmitted       State = "burn_submitted"
	StateBurnConfirmed       State = "burn_confirmed"
	StateAttestationPending  State = "attestation_pending"
	StateAttested            State = "attested"
	StateMintSubmitted       State = "mint_submitted"
	StateMinted              State = "minted"
	StateHandoffToSettlement State = "handoff_to_settlement"
	StateFailed              State = "failed"
	StateOrphaned            State = "orphaned"
)

// AllStates lists every valid state, for tests and validation -- not derived
// from allowedTransitions so a typo in that map can't silently narrow test
// coverage.
var AllStates = []State{
	StateInitiated, StateBurnSubmitted, StateBurnConfirmed, StateAttestationPending,
	StateAttested, StateMintSubmitted, StateMinted, StateHandoffToSettlement,
	StateFailed, StateOrphaned,
}

// allowedTransitions is the single source of truth for legal state changes.
// Any (from, to) pair not listed here is rejected by Transition.
var allowedTransitions = map[State][]State{
	StateInitiated:          {StateBurnSubmitted, StateFailed},
	StateBurnSubmitted:      {StateBurnConfirmed, StateFailed},
	StateBurnConfirmed:      {StateAttestationPending, StateFailed},
	StateAttestationPending: {StateAttested, StateFailed, StateOrphaned},
	StateAttested:           {StateMintSubmitted, StateOrphaned},
	StateMintSubmitted:      {StateMinted, StateFailed},
	StateMinted:             {StateHandoffToSettlement},
	// The burn is irreversible and the USDC WILL mint on Arc once attested --
	// orphaned is a detour, not a dead end. The reconciler resumes exactly
	// where a live session would have: submitting the mint. See README.md.
	StateOrphaned:            {StateMintSubmitted},
	StateHandoffToSettlement: {},
	StateFailed:              {},
}

// ErrIllegalTransition is wrapped by Transition's error so callers can
// errors.Is check it without string matching.
var ErrIllegalTransition = errors.New("bridge: illegal state transition")

// Transition validates moving a bridge_transfers row from `from` to `to`.
// It does not mutate anything -- callers apply the UPDATE themselves inside
// the same transaction that checked this, so the check and the write don't
// race under concurrent callers (a live session and the orphan reconciler
// both touching the same row).
func Transition(from, to State) error {
	for _, allowed := range allowedTransitions[from] {
		if allowed == to {
			return nil
		}
	}
	return fmt.Errorf("%w: %s -> %s", ErrIllegalTransition, from, to)
}

// IsTerminal reports whether a state has no legal outgoing transitions.
// handoff_to_settlement and failed are terminal; orphaned is NOT terminal --
// it always has a path back to mint_submitted.
func IsTerminal(s State) bool {
	return len(allowedTransitions[s]) == 0
}

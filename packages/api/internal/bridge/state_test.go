package bridge

import "testing"

// legalPairs is the expected transition graph, kept independently of
// allowedTransitions in state.go so this test isn't just re-asserting the
// implementation against itself.
var legalPairs = map[State]map[State]bool{
	StateInitiated:           {StateBurnSubmitted: true, StateFailed: true},
	StateBurnSubmitted:       {StateBurnConfirmed: true, StateFailed: true},
	StateBurnConfirmed:       {StateAttestationPending: true, StateFailed: true},
	StateAttestationPending:  {StateAttested: true, StateFailed: true, StateOrphaned: true},
	StateAttested:            {StateMintSubmitted: true, StateOrphaned: true},
	StateMintSubmitted:       {StateMinted: true, StateFailed: true},
	StateMinted:              {StateHandoffToSettlement: true},
	StateOrphaned:            {StateMintSubmitted: true},
	StateHandoffToSettlement: {},
	StateFailed:              {},
}

func TestBridgeStateMachine(t *testing.T) {
	for _, from := range AllStates {
		for _, to := range AllStates {
			wantLegal := legalPairs[from][to]
			err := Transition(from, to)

			if wantLegal && err != nil {
				t.Errorf("Transition(%s, %s): want legal, got error: %v", from, to, err)
			}
			if !wantLegal && err == nil {
				t.Errorf("Transition(%s, %s): want illegal transition rejected, got nil error", from, to)
			}
			if !wantLegal && err != nil {
				// Same-state "transitions" (from == to) are also illegal and
				// must still wrap ErrIllegalTransition, not some other error.
				if err.Error() == "" {
					t.Errorf("Transition(%s, %s): error message empty", from, to)
				}
			}
		}
	}
}

func TestBridgeStateMachine_OrphanedReachableFromAttestationPendingAndAttested(t *testing.T) {
	if err := Transition(StateAttestationPending, StateOrphaned); err != nil {
		t.Errorf("attestation_pending -> orphaned must be legal (session dies while waiting on Iris): %v", err)
	}
	if err := Transition(StateAttested, StateOrphaned); err != nil {
		t.Errorf("attested -> orphaned must be legal (session dies after attestation, before mint submitted): %v", err)
	}
}

func TestBridgeStateMachine_OrphanedIsRecoverableNotTerminal(t *testing.T) {
	if IsTerminal(StateOrphaned) {
		t.Error("orphaned must not be terminal -- the burn is irreversible and WILL mint, the reconciler must be able to resume it")
	}
	if err := Transition(StateOrphaned, StateMintSubmitted); err != nil {
		t.Errorf("orphaned -> mint_submitted must be legal (reconciler resumes the mint): %v", err)
	}
}

func TestBridgeStateMachine_TerminalStatesRejectEverything(t *testing.T) {
	for _, terminal := range []State{StateHandoffToSettlement, StateFailed} {
		if !IsTerminal(terminal) {
			t.Errorf("%s must be terminal", terminal)
		}
		for _, to := range AllStates {
			if err := Transition(terminal, to); err == nil {
				t.Errorf("%s -> %s: terminal state must reject every transition", terminal, to)
			}
		}
	}
}

func TestBridgeStateMachine_NoSelfTransitions(t *testing.T) {
	for _, s := range AllStates {
		if err := Transition(s, s); err == nil {
			t.Errorf("%s -> %s: self-transition must be rejected", s, s)
		}
	}
}

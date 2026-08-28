package handlers

import "testing"

// The name rules, which decide who a payment reaches.
//
// Worth testing rather than eyeballing because two of them are security
// properties wearing validation clothing: a reserved name lets someone pose as
// Conduit in a chat message, and a name differing only in case from another
// lets someone stand next to a real account and collect payments meant for it.

func TestUsernameRules(t *testing.T) {
	cases := []struct {
		name  string
		input string
		ok    bool
		why   string
	}{
		{"ordinary", "ivan", true, ""},
		{"minimum length", "abc", true, "three is the floor, not below it"},
		{"maximum length", "abcdefghijklmnopqrst", true, "twenty is allowed, not rejected"},
		{"digits and underscore inside", "a_1_b", true, ""},
		{"mixed case is kept", "Ivan", true, "display case is the claimer's choice"},

		{"too short", "ab", false, "two characters"},
		{"too long", "abcdefghijklmnopqrstu", false, "twenty-one characters"},
		{"empty", "", false, ""},
		{"leading underscore", "_ivan", false, "must start with a letter or digit"},
		{"trailing underscore", "ivan_", false, "must end with a letter or digit"},
		{"contains a dot", "iv.an", false, "dots make two names look alike in a chat"},
		{"contains a hyphen", "iv-an", false, "same reason as the dot"},
		{"contains a space", "iv an", false, ""},
		{"contains an at sign", "iv@n", false, "the @ is the suffix, never part of the name"},
		{"non-ascii lookalike", "ivаn", false, "the a here is Cyrillic U+0430"},

		{"reserved", "conduit", false, "impersonates us"},
		{"reserved, different case", "SUPPORT", false, "the reserved check must be case-insensitive"},
		{"reserved route", "settings", false, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateUsername(tc.input)
			if tc.ok && err != nil {
				t.Fatalf("ValidateUsername(%q) = %v, want accepted (%s)", tc.input, err, tc.why)
			}
			if !tc.ok && err == nil {
				t.Fatalf("ValidateUsername(%q) accepted, want rejected (%s)", tc.input, tc.why)
			}
		})
	}
}

// A rejection has to say which rule was broken, or someone retries the same
// name until they give up. Specifically: "ab" is too SHORT, and saying
// "invalid characters" about it would be true of nothing in it.
func TestUsernameRejectionNamesTheRule(t *testing.T) {
	tooShort := ValidateUsername("ab")
	if tooShort == nil {
		t.Fatal("expected a rejection")
	}
	if got := tooShort.Error(); got != "username must be at least 3 characters" {
		t.Fatalf("short name reported as %q, want the length rule", got)
	}

	reserved := ValidateUsername("admin")
	if reserved == nil {
		t.Fatal("expected a rejection")
	}
	if got := reserved.Error(); got != "that username is reserved" {
		t.Fatalf("reserved name reported as %q, want the reserved rule", got)
	}
}

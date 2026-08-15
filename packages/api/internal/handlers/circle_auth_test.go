package handlers

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

// Every /v1/auth/circle/* route answers without a credential, so whatever the
// error envelope carries is readable by anyone who can reach the API. `param`
// is serialised into the body, so it must name the operation and nothing more.
//
// This previously passed the upstream error through verbatim.
func TestUpstreamDoesNotEchoProviderText(t *testing.T) {
	h := &CircleAuth{}
	w := httptest.NewRecorder()

	const detail = "app_id 9f3c-not-a-real-id rejected: internal quota exceeded for merchant tier"
	h.upstream(w, "initialize", errors.New(detail))

	body := w.Body.String()
	if strings.Contains(body, detail) {
		t.Errorf("response echoed the upstream error text:\n%s", body)
	}
	// A few individually recognisable fragments, so a partial echo is caught
	// as well as a whole one.
	for _, frag := range []string{"quota", "app_id", "merchant tier", "9f3c"} {
		if strings.Contains(body, frag) {
			t.Errorf("response leaked %q from the upstream error:\n%s", frag, body)
		}
	}
	// The operation name is what makes a client report correlatable with the
	// log line that does have the detail.
	if !strings.Contains(body, "initialize") {
		t.Errorf("response should name the failing operation, got:\n%s", body)
	}
}

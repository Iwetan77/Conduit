// e2e-webhook-listener is a minimal real HTTP receiver for
// scripts/e2e-crosschain.sh -- it independently re-verifies each webhook's
// Conduit-Signature HMAC (using internal/webhooks.Verify, the same function
// a real receiver would use) and appends one JSON line per received event to
// a log file, so the e2e script can assert the full event trail arrived, in
// order, all independently verified.
//
// Usage: e2e-webhook-listener <port> <secret> <logFilePath>
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/kzn-labs/conduit/api/internal/webhooks"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: e2e-webhook-listener <port> <secret> <logFilePath>")
		os.Exit(1)
	}
	port, secret, logPath := os.Args[1], os.Args[2], os.Args[3]

	logFile, err := os.Create(logPath)
	if err != nil {
		log.Fatalf("create log file: %v", err)
	}
	defer logFile.Close()

	http.HandleFunc("/webhook", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		sig := r.Header.Get("Conduit-Signature")
		verifyErr := webhooks.Verify(secret, sig, body, time.Now())

		var parsed struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(body, &parsed)

		status := "VERIFIED"
		if verifyErr != nil {
			status = "FAILED:" + verifyErr.Error()
		}
		line := fmt.Sprintf(`{"event_type":%q,"hmac_status":%q,"received_at":%q,"body":%s}`+"\n",
			parsed.Type, status, time.Now().Format(time.RFC3339Nano), string(body))
		if _, err := logFile.WriteString(line); err != nil {
			log.Printf("write log: %v", err)
		}
		logFile.Sync()

		log.Printf("received %s hmac=%s", parsed.Type, status)
		w.WriteHeader(http.StatusOK)
	})

	log.Printf("e2e-webhook-listener on :%s, logging to %s", port, logPath)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

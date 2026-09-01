package handlers

// Telling a merchant their payroll stopped, rather than waiting for an employee
// to ask where their salary is.
//
// A run claimed as 'executing' and then abandoned -- closed tab, hung wallet,
// merchant walked away mid-signature -- sits with items still pending and
// nothing driving it. Phase C2 gave it a resume path; this is what makes anyone
// aware there is something to resume.
//
// Deliberately only OBSERVES. It marks the run and fires a webhook. It does not
// cancel, does not fail the items, and does not resume anything by itself:
// every one of those decisions belongs to somebody who can see whether the
// wallet is still open, and a sweeper that acted on its own would eventually
// cancel a run a merchant was three seconds from confirming.

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kzn-labs/conduit/api/internal/webhooks"
)

type PayrollSweeper struct {
	Pool     *pgxpool.Pool
	Webhooks *webhooks.Dispatcher
	// Interval between sweeps. Zero means the default.
	Interval time.Duration
}

// Run sweeps until ctx is cancelled.
func (s *PayrollSweeper) Run(ctx context.Context) {
	interval := s.Interval
	if interval <= 0 {
		// 15 minutes, matching the other background workers, and for their
		// reason rather than for this one's.
		//
		// A 5 minute tick would report stalls sooner and would also keep a
		// serverless Postgres permanently awake: it suspends after roughly five
		// minutes of inactivity, so a sweeper on that period wakes it exactly
		// as it was about to sleep and the compute bills for every hour of the
		// month. A stall is already 30 minutes old before it is worth
		// reporting, so nothing is gained by checking more often than the
		// database can afford.
		interval = 15 * time.Minute
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.sweep(ctx); err != nil {
				log.Printf("payroll sweeper: %v", err)
			}
		}
	}
}

func (s *PayrollSweeper) sweep(ctx context.Context) error {
	// Claimed by the UPDATE itself, so two instances of the API sweeping at the
	// same time cannot both report the same stall. stalled_at is set once and
	// cleared whenever the run moves again, which is what makes this fire once
	// per stall rather than once per sweep.
	rows, err := s.Pool.Query(ctx,
		`UPDATE payroll_runs
		    SET stalled_at = now()
		  WHERE status = 'executing'
		    AND stalled_at IS NULL
		    AND last_progress_at < now() - $1::interval
		  RETURNING id, account_id`,
		payrollStallThreshold.String())
	if err != nil {
		return err
	}
	type stalled struct{ runID, accountID string }
	var found []stalled
	for rows.Next() {
		var st stalled
		if err := rows.Scan(&st.runID, &st.accountID); err != nil {
			rows.Close()
			return err
		}
		found = append(found, st)
	}
	rows.Close()

	for _, st := range found {
		// Which people are still owed. A webhook saying only "your payroll
		// stalled" leaves the merchant to work out what that means for whom,
		// which is the question they will immediately have.
		var pending, paid int
		_ = s.Pool.QueryRow(ctx,
			`SELECT count(*) FILTER (WHERE status = 'pending'),
			        count(*) FILTER (WHERE status = 'paid')
			   FROM payroll_run_items WHERE run_id = $1`,
			st.runID).Scan(&pending, &paid)

		log.Printf("payroll sweeper: run %s stalled with %d unpaid of %d", st.runID, pending, pending+paid)

		if s.Webhooks != nil {
			_ = s.Webhooks.Enqueue(ctx, st.accountID, "payroll.run.stalled", map[string]any{
				"run_id": st.runID,
				"status": "executing",
				"paid":   paid,
				"unpaid": pending,
				// Named, because the merchant's next question is what to do
				// and the answer is a specific call.
				"resume_with": "POST /v1/payroll_runs/" + st.runID + "/resume",
			})
		}
	}
	return nil
}

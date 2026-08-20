// Polling that starts fast and backs off.
//
// A flat interval is the wrong shape for settlement. Arc settles in about a
// second, so a 3s poll spends most of its first tick waiting on money that has
// already arrived -- and then keeps asking at the same rate for the ten minutes
// a slow cross-chain transfer can take. Both halves are wrong in opposite
// directions: too slow when it matters, too eager when it does not.
//
// The ramp below is faster than the old flat interval exactly where latency is
// visible (the first few seconds, where most payments land) and cheaper
// everywhere after, so it reduces both the wait and the number of requests.
//
// Wall-clock driven rather than tick-counted: a backgrounded tab throttles
// timers, and counting ticks would keep such a tab in the "fast" phase long
// after it should have backed off.

interface Phase {
  /** Use this delay until the poll has been running for `untilMs`. */
  untilMs: number;
  everyMs: number;
}

const DEFAULT_PHASES: Phase[] = [
  { untilMs: 10_000, everyMs: 800 },
  { untilMs: 45_000, everyMs: 2_000 },
  { untilMs: Infinity, everyMs: 5_000 },
];

function delayFor(elapsed: number, phases: Phase[]): number {
  for (const p of phases) if (elapsed < p.untilMs) return p.everyMs;
  return phases[phases.length - 1].everyMs;
}

/**
 * Run `tick` on a ramping schedule until it returns true, or until cancelled.
 *
 * Returns the cancel function. `tick` returning true means "done, stop" -- so
 * a caller never has to clear the timer from inside its own callback, which is
 * where interval-based versions of this leak.
 *
 * One tick is in flight at a time: the next delay is measured from when the
 * previous tick FINISHED, so a slow response cannot stack requests on top of
 * each other. That is the other failure of setInterval here -- a 3s interval
 * against a 4s response builds a queue.
 */
export function pollWithBackoff(
  tick: () => Promise<boolean | void>,
  opts: { phases?: Phase[]; immediate?: boolean } = {},
): () => void {
  const phases = opts.phases ?? DEFAULT_PHASES;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const run = async () => {
    if (cancelled) return;
    let done: boolean | void = false;
    try {
      done = await tick();
    } catch {
      // A failed poll is not a reason to stop polling: the next one may
      // succeed, and giving up here would leave a settled payment unreported.
    }
    if (cancelled || done === true) return;
    timer = setTimeout(run, delayFor(Date.now() - started, phases));
  };

  if (opts.immediate) {
    void run();
  } else {
    timer = setTimeout(run, delayFor(0, phases));
  }

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

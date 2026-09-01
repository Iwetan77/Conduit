# Known issues

Things observed and deliberately not fixed yet, with what is known about each
so the next person does not start from zero.

## D1 — stale render on navigation (route flash)

**Reported:** a dashboard page briefly shows the PREVIOUS page's content, or its
own previous state, before updating to the correct content. Intermittent.
Reported against the merchant dashboard.

**Not yet reproduced under instrumentation**, so what follows is where to look,
not a diagnosis. Two candidate causes have already been ruled out by reading:

- *Query key collision* — ruled out. Every dashboard `useQuery` key is distinct
  per resource (`qk.myAccount`, `qk.settlements`, `["payroll-runs"]`,
  `["employee-groups"]`, …). Two pages do not share a key.
- *The auth gate flashing* — ruled out. `CircleDashboard` returns `null` until
  `accountReady`, and `null` again while the session is resolving, so it renders
  a blank frame rather than stale content.

What remains, in order of likelihood:

1. **react-query serving cached data while it refetches.** `useMyAccount` and
   friends carry a five-minute `staleTime`, which is deliberate — it is what
   stopped the merchant's own business name flickering to "Loading…" on every
   navigation. The cost is that a page renders the last known value first and
   corrects it when the refetch lands. For a value that changed in between, that
   correction IS the flash. The fix is not to drop `staleTime`; it is to decide
   per query whether stale-then-correct or blank-then-correct is the honest
   presentation, and to use `placeholderData`/skeletons where it is not.
2. **Local `useState` surviving a navigation.** The App Router keeps a shared
   layout mounted across route changes. A page holding its own step/stage state
   (`/dashboard/payroll` holds `stage`, `run`, `legs`) will show the old stage
   for a frame if it is remounted with state restored rather than fresh.
3. **A redirect decided in `useEffect`.** Anything that renders first and
   bounces second shows one frame of the wrong page by construction.

**Do not fix this by guessing.** It is intermittent, it is in production, and
the two obvious explanations are already eliminated — which means a change made
on a hunch is as likely to move the flash as remove it. Reproduce it with the
React DevTools profiler recording a navigation first, and identify which
component re-renders with which stale value.

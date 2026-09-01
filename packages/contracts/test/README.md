# Why these tests do not fork

`pnpm contracts:test` runs `forge test` against a fresh local EVM. It used to
pass `--fork-url https://rpc.testnet.arc.network`, and that flag was removed
deliberately.

**The fork verified nothing.** Every test here uses `MockERC20`, and
`ConduitRouter.t.sol` says why in its own header: Arc Testnet's USDC is a native
precompile that Foundry cannot simulate in fork mode. So the suite was written
from the start to avoid depending on forked state. The one place a real address
appears — `DeclarationRegistry.t.sol`'s `USDC` constant — uses it as a value
that is hashed, never as a contract that is called.

**It cost a great deal.** 65 tests take 126ms locally and 123 seconds forked,
because every account touched becomes an RPC round trip. Worse, Arc's public
endpoint enforces a sustained request quota, so the suite's result depended on
how much of that quota was left. The invariant test in `RouterInvariant.t.sol`
could not run at all: Foundry looks up every address the fuzzer touches, and the
setup exhausted the quota before the first sequence, failing with a 429 that
reads exactly like a broken invariant.

A test suite whose verdict depends on a third party's rate limiter is a suite
that will eventually fail for a reason nobody can act on, and — worse — will be
believed when it passes for the wrong reason.

`pnpm --filter @conduit/contracts test:fork` still exists for anything that
genuinely needs forked state, and honours `ARC_TESTNET_RPC` so it can be pointed
at an endpoint that will tolerate it. Nothing currently needs it.

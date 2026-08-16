# Deploying Conduit

Two things ship: **the app** (one Next.js app — landing, payer checkout,
merchant dashboard, docs) and **the API** (Go + Postgres). That's it; the
former marketing and docs sites are folded into the app.

> Status: this is a **testnet** deployment. Arc Testnet, Circle sandbox keys.
> Nothing here moves real money.

---

## 1. The API (Go + Postgres)

Runs anywhere that takes a container — Fly, Railway, Render, Cloud Run.
`packages/api/Dockerfile` builds `cmd/api`, the production entrypoint.
(`cmd/devserver` embeds its own Postgres and is local-development only —
never deploy it.)

Migrations run automatically at startup via golang-migrate.

### Required environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. A managed Postgres — not the embedded one. |
| `STABLEFX_API_KEY` | Circle StableFX key. Read from the environment first; the `.env` fallback does not exist in a container. |

### Recommended

| Variable | Purpose |
|---|---|
| `CONDUIT_ALLOWED_ORIGINS` | Comma-separated CORS allowlist, e.g. `https://conduit.vercel.app`. **Set this.** Unset means wildcard, which is fine for local/testnet but means any site can call the API from a visitor's browser. |
| `CONDUIT_APP_BASE_URL` | Public app origin. Used to build `hosted_url` on payment links — get this wrong and every generated link/QR points somewhere else. |
| `ARC_RPC` | Arc RPC URL. Defaults to the public endpoint, which rate-limits. |

### Optional (each feature is opt-in; the API runs without them)

| Variable | Enables |
|---|---|
| `CIRCLE_API_KEY` | Merchant login (Circle Wallets). Without it, only `sk_`/`pk_` API-key auth works — the dashboard cannot be signed into. Server-side only; it never reaches the browser. |
| `CONDUIT_SESSION_SECRET` | Signs dashboard session tokens. **Set this.** Unset, the API generates a random secret per boot, so every deploy signs every merchant out and sessions can never work across more than one instance. Any 32-byte hex value. |
| `CONDUIT_TRUSTED_PROXY` | Set to any non-empty value when the API sits behind a proxy or load balancer (Render, Fly, Cloud Run all do). Rate limiting then identifies clients by `X-Forwarded-For` instead of the proxy's own address. Leave unset if the server is directly exposed — the header is caller-supplied, and trusting it without a proxy in front lets anyone bypass the limit. |
| `ARC_RELAYER_KEY` | Cross-chain (Solana → Arc) funding via Circle Gateway. Without it the bridge routes simply aren't registered. |
| `SOLANA_RPC` | Solana endpoint for the above. Defaults to public devnet. |

### About `ARC_RELAYER_KEY`

It **signs only** — there is no `SendTransaction` anywhere in the API, so it
needs **no gas and no testnet funds**. Circle's maker executes the on-chain
leg. Two things still make it a real secret:

- bridged USDC is directed to its address during cross-chain settlement, so
  it transiently holds funds;
- anyone holding it can sign StableFX messages as you.

Put it in the platform's secret store. Never in an env file on disk, never
in the repo.

---

## 2. The app (Next.js)

One deploy. On Vercel, set the project root to `packages/app`; the build is
the standard `next build`.

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_CONDUIT_API_URL` | Public URL of the API above. **Must be set at build time** — Next inlines `NEXT_PUBLIC_*` into the browser bundle, so changing it later requires a rebuild, not just a restart. |
| `NEXT_PUBLIC_CIRCLE_APP_ID` + `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google sign-in. Both required together; without them the Google button is hidden and only wallet connection works. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | From cloud.walletconnect.com. **Without it mobile wallets cannot connect at all** — only browser-extension wallets and Google sign-in work. |
| `NEXT_PUBLIC_CONDUIT_ROUTER`, `NEXT_PUBLIC_DECLARATION_REGISTRY`, `NEXT_PUBLIC_STABLEFX_ADAPTER`, `NEXT_PUBLIC_ATOMIC_SETTLER`, `NEXT_PUBLIC_CURRENCY_REGISTRY`, `NEXT_PUBLIC_SETTLEMENT_PREFERENCE_REGISTRY` | Deployed contract addresses. The SDK refuses to guess these — pages error visibly rather than silently using a wrong address. |
| `NEXT_PUBLIC_ARC_RPC`, `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_EXPLORER` | Chain config. |
| `NEXT_PUBLIC_APP_URL` | The app's own public origin. |

There is no `NEXT_PUBLIC_DOCS_URL` any more — docs are `/docs` in this app.

---

## 3. Circle Wallets + Google (do this or every login breaks)

Merchant login is Circle user-controlled wallets with Google sign-in. This
replaced Privy; if you are looking for the Privy section, it was removed in
Phase 7 of that migration along with `PRIVY_APP_ID` and
`PRIVY_VERIFICATION_KEY`.

Three things must agree, and a mismatch in any of them fails at Google rather
than anywhere that names Conduit:

1. **Google Cloud console** — the OAuth client needs the deployed origin as an
   authorised **JavaScript origin**, and `<origin>/auth/circle/callback` as an
   authorised **redirect URI**. Circle's SDK navigates the whole tab to Google,
   so a missing redirect URI surfaces as `redirect_uri_mismatch`.
2. **Circle console** — the app id (`NEXT_PUBLIC_CIRCLE_APP_ID`) and the Google
   client id registered against it.
3. **API** — `CIRCLE_API_KEY`, server-side only. It never reaches the browser:
   device and user tokens are minted through `/v1/auth/circle/*`.

Every port or domain change needs step 1 repeated.

---

## 4. Order of operations

1. Provision Postgres, note `DATABASE_URL`.
2. Deploy the API. Confirm `GET /healthz` returns 200 and
   `GET /v1/currencies` returns the currency table.
3. Deploy the app with `NEXT_PUBLIC_CONDUIT_API_URL` pointing at it.
4. Add the app's origin to the Google OAuth client (plus the
   `/auth/circle/callback` redirect URI), and to the API's
   `CONDUIT_ALLOWED_ORIGINS`. Redeploy the API.
5. Walk it end to end: sign in as a merchant → create a payment link → open
   the link in a private window → pay it.

## Known limits at this stage

- **Arc's public RPC rate-limits.** `GET /v1/balances` reads server-side via
  Multicall3 and caches for 10s, so N visitors cost one upstream call. Direct
  chain reads still happen for history and settlement; those remain subject
  to the public endpoint's limits. A dedicated RPC key is the next step.
- **CORS defaults to wildcard** unless `CONDUIT_ALLOWED_ORIGINS` is set.
- **Contracts are testnet deployments** and are immutable in v1.

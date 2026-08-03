package bridge

// Domain and contract config for Circle Gateway (Unified Balance Kit).
// Values are transcribed from docs/ubk-capability.md's confirmed,
// live-verified facts (pulled from the published npm package's own compiled
// source, cross-checked against the raw CCTP addresses independently
// confirmed in docs/cctp-capability.md) -- do not hardcode a domain id or
// contract address anywhere else in this package or its callers; import
// these constants instead.
const (
	// GatewayAPITestnetBaseURL is Circle Gateway's REST API for testnet.
	// Confirmed live: GET /v1/info, POST /v1/balances, POST /v1/deposits,
	// POST /v1/transfer, GET /v1/transfer/{id}, POST /v1/estimate.
	GatewayAPITestnetBaseURL = "https://gateway-api-testnet.circle.com"

	// ArcDomain is Arc testnet's Gateway domain id -- identical to its raw
	// CCTP domain, since Gateway is CCTP-domain-native (Gateway is built on
	// CCTP V2 rails, not a separate protocol).
	ArcDomain uint32 = 26
	// ArcUSDC is the native USDC token address on Arc testnet.
	ArcUSDC = "0x3600000000000000000000000000000000000000"
	// ArcGatewayWallet is the GatewayWallet contract every EVM testnet
	// shares (confirmed identical across Arc Testnet, Base Sepolia, and
	// every other EVM testnet chain definition inspected in the SDK).
	ArcGatewayWallet = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"
	// ArcGatewayMinter is the GatewayMinter contract, same EVM-testnet-wide
	// address as ArcGatewayWallet's sharing pattern.
	ArcGatewayMinter = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B"
	// ArcGatewayForwarderSupported: Arc is a confirmed Gateway forwarder
	// destination (gateway.forwarderSupported.destination: true in the SDK's
	// chain definition) -- Circle's own relayer submits the destination mint,
	// Conduit never builds or signs an Arc-side mint transaction.
	ArcGatewayForwarderSupported = true

	// SolanaDomain is Solana's Gateway domain id (mainnet and devnet share
	// it, same as its raw CCTP domain).
	SolanaDomain uint32 = 5
	// SolanaUSDCDevnet is the USDC devnet mint address on Solana.
	SolanaUSDCDevnet = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
	// SolanaGatewayWalletProgram is the Gateway Wallet program on Solana
	// devnet, confirmed live via `anchor idl fetch` against devnet (see
	// docs/ubk-capability.md) -- ground truth pulled directly off-chain.
	SolanaGatewayWalletProgram = "GATEwdfmYNELfp5wDmmR6noSr2vHnAfBPMm2PvCzX5vu"
	// SolanaGatewayMinterProgram is the Gateway Minter program on Solana devnet.
	SolanaGatewayMinterProgram = "GATEmKK2ECL1brEngQZWCgMWPbvrEYqsV6u29dAaHavr"

	// BaseDomain and PolygonDomain are the Gateway/CCTP domain ids for the
	// EVM source chains a payer can now bridge from via the client-side UBK
	// SDK (Base Sepolia, Polygon Amoy). Recorded here so the client-spend
	// report handler can stamp bridge_transfers.source_domain without the
	// browser being trusted to supply a raw domain number.
	BaseDomain    uint32 = 6
	PolygonDomain uint32 = 7

	// SuiTestnetDomain is Sui testnet's Gateway domain -- confirmed
	// supported (the spec explicitly asked not to assume this either way;
	// Sui IS Gateway-enabled on testnet, unlike Sui mainnet at time of
	// writing). Not wired into a concrete provider implementation yet --
	// recorded so a future Sui FundingProvider doesn't have to re-derive it.
	SuiTestnetDomain uint32 = 10

	// burnIntentMagic and transferSpecMagic are the magic tags in Gateway's
	// binary burn-intent encoding, confirmed byte-exact from the shipped SDK
	// (see docs/ubk-capability.md).
	burnIntentMagic   uint32 = 0x070afbc2
	transferSpecMagic uint32 = 0xca85def7
)

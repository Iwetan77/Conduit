package bridge

// Domain and contract config for Circle Gateway (Unified Balance Kit).
// Values are transcribed from docs/ubk-capability.md's confirmed,
// live-verified facts (pulled from the published npm package's own compiled
// source, cross-checked against the raw CCTP addresses independently
// confirmed in docs/cctp-integration.md) -- do not hardcode a domain id or
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

	// The remaining EVM source chains Circle Gateway supports. Every domain id
	// in this block (including the three above) was read straight out of the
	// shipped UBK SDK's own chain definitions via resolveChainIdentifier(...)
	// .gateway.domain, NOT from memory or documentation -- these numbers route
	// real money, and a wrong one burns USDC against the wrong chain. The four
	// that predate this block (Arc 26, Solana 5, Base 6, Polygon 7) came back
	// identical, which is what validates the extraction.
	EthereumDomain   uint32 = 0
	AvalancheDomain  uint32 = 1
	OptimismDomain   uint32 = 2
	ArbitrumDomain   uint32 = 3
	UnichainDomain   uint32 = 10
	SonicDomain      uint32 = 13
	WorldChainDomain uint32 = 14
	SeiDomain        uint32 = 16
	HyperEVMDomain   uint32 = 19

	// NOTE: a SuiTestnetDomain = 10 constant used to live here, described as
	// "confirmed supported". Both halves were wrong: Sui is absent from
	// Gateway's supported-chain enum entirely, and domain 10 is Unichain. It
	// was never referenced, but leaving a wrong domain id lying around next to
	// correct ones is how it eventually gets used. Removed.

	// burnIntentMagic and transferSpecMagic are the magic tags in Gateway's
	// binary burn-intent encoding, confirmed byte-exact from the shipped SDK
	// (see docs/ubk-capability.md).
	burnIntentMagic   uint32 = 0x070afbc2
	transferSpecMagic uint32 = 0xca85def7
)

package bridge

// Domain and contract config for CCTP V2. Values are transcribed from
// docs/cctp-capability.md's confirmed, live-verified facts -- do not
// hardcode a domain id or contract address anywhere else in this package or
// its callers; import these constants instead.
const (
	// ArcDomain is Arc testnet's CCTP V2 domain id.
	ArcDomain uint32 = 26
	// ArcTokenMessengerV2 is the CCTP TokenMessengerV2 contract on Arc testnet.
	ArcTokenMessengerV2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"
	// ArcMessageTransmitterV2 is the CCTP MessageTransmitterV2 contract on Arc testnet.
	ArcMessageTransmitterV2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"
	// ArcUSDC is the native USDC token address on Arc testnet.
	ArcUSDC = "0x3600000000000000000000000000000000000000"

	// SolanaDomain is Solana's CCTP V2 domain id (mainnet and devnet share it).
	SolanaDomain uint32 = 5
	// SolanaTokenMessengerMinterV2 is the CCTP program on Solana devnet.
	SolanaTokenMessengerMinterV2 = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"
	// SolanaMessageTransmitterV2 is the CCTP program on Solana devnet.
	SolanaMessageTransmitterV2 = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC"
	// SolanaUSDCDevnet is the USDC devnet mint address on Solana.
	SolanaUSDCDevnet = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

	// IrisSandboxBaseURL is Circle's attestation API for testnet/devnet CCTP
	// messages. Confirmed live in Phase 0 -- polling
	// {IrisSandboxBaseURL}/v2/messages/{sourceDomain}?transactionHash={sig}
	// until messages[0].status == "complete" returns .message/.attestation.
	IrisSandboxBaseURL = "https://iris-api-sandbox.circle.com"

	// FastFinalityThreshold is the minFinalityThreshold value that selects
	// CCTP V2 Fast Transfer (as opposed to 2000, standard/finalized transfer).
	FastFinalityThreshold uint32 = 1000
)

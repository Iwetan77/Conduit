package bridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	solanago "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// maxFeeCap is the maxFee this implementation authorizes per burn intent.
// Gateway rejected 0 on a real testnet call ("Insufficient max fee:
// expected at least 0.15") -- 300000 (0.3 USDC) gives margin above that
// observed floor. Production should call POST /v1/estimate for a real
// per-transfer figure instead of a hardcoded cap.
var maxFeeCap = big.NewInt(300_000)

// GatewayProvider is the Solana -> Arc Circle Gateway implementation.
// Chain-agnostic at the FundingProvider interface level (Address is a plain
// string); Solana-specific account/instruction/signing details live only in
// this file, never leak into provider.go's interface or into callers.
type GatewayProvider struct {
	solanaRPC  *rpc.Client
	httpClient *http.Client
	apiBaseURL string
	// arcRecipient is Conduit's own Arc address that receives every funded
	// spend -- the same relayer address internal/handlers/bridge.go already
	// uses for the StableFX settlement handoff.
	arcRecipient common.Address
}

func NewGatewayProvider(solanaRPCURL string, arcRecipient common.Address) *GatewayProvider {
	return &GatewayProvider{
		solanaRPC:    rpc.New(solanaRPCURL),
		httpClient:   &http.Client{Timeout: 15 * time.Second},
		apiBaseURL:   GatewayAPITestnetBaseURL,
		arcRecipient: arcRecipient,
	}
}

func (p *GatewayProvider) Name() string { return "circle-gateway" }

type gatewayBalanceEntry struct {
	Domain    uint32 `json:"domain"`
	Depositor string `json:"depositor"`
	Balance   string `json:"balance"` // decimal string, e.g. "10.500000"
}
type gatewayBalancesResponse struct {
	Token    string                `json:"token"`
	Balances []gatewayBalanceEntry `json:"balances"`
	Success  *bool                 `json:"success,omitempty"`
	Message  string                `json:"message,omitempty"`
}

// UnifiedBalance reads the payer's confirmed Gateway balance across every
// domain, via POST /v1/balances -- confirmed live endpoint, see
// docs/ubk-capability.md.
func (p *GatewayProvider) UnifiedBalance(ctx context.Context, payer Address) (UnifiedBalance, error) {
	reqBody := map[string]any{
		"token":   "USDC",
		"sources": []map[string]string{{"depositor": string(payer)}},
	}
	var resp gatewayBalancesResponse
	if err := p.post(ctx, "/v1/balances", reqBody, &resp); err != nil {
		return UnifiedBalance{}, fmt.Errorf("bridge: Gateway balances: %w", err)
	}
	if resp.Success != nil && !*resp.Success {
		return UnifiedBalance{}, fmt.Errorf("bridge: Gateway balances API error: %s", resp.Message)
	}

	ub := UnifiedBalance{TotalAvailable: big.NewInt(0), ByDomain: map[uint32]*big.Int{}}
	for _, entry := range resp.Balances {
		minorUnits, err := decimalUSDCToMinorUnits(entry.Balance)
		if err != nil {
			return UnifiedBalance{}, fmt.Errorf("bridge: parse balance %q: %w", entry.Balance, err)
		}
		ub.ByDomain[entry.Domain] = minorUnits
		ub.TotalAvailable.Add(ub.TotalAvailable, minorUnits)
	}
	return ub, nil
}

// PrepareFund checks the payer's already-deposited balance on Solana
// (domain 5); if it covers `amount`, only a burn-intent signature is needed
// (gasless, off-chain). If not, a real deposit transaction must land first
// -- see docs/ubk-capability.md's deposit-then-spend section for why both
// exist. This implementation always requires the deposit path for now
// (depositing is a real on-chain instruction this phase builds; skipping it
// when balance is already sufficient is a valid future optimization, not
// implemented here to keep the first real end-to-end path simple).
func (p *GatewayProvider) PrepareFund(ctx context.Context, payer Address, amount *big.Int, destArcAddress Address) (FundRequest, error) {
	balance, err := p.UnifiedBalance(ctx, payer)
	if err != nil {
		return FundRequest{}, err
	}
	solanaBalance := balance.ByDomain[SolanaDomain]
	if solanaBalance == nil {
		solanaBalance = big.NewInt(0)
	}
	// Gateway requires the deposited balance to cover value + fee, not just
	// value -- confirmed on a real testnet call ("Insufficient balance ...
	// available 0.500000, required 0.65" for a 0.5 value + 0.15 min fee).
	// maxFeeCap below must match encodeBurnIntentForSolana's maxFee.
	requiredBalance := new(big.Int).Add(amount, maxFeeCap)
	needsDeposit := solanaBalance.Cmp(requiredBalance) < 0

	req := FundRequest{NeedsDeposit: needsDeposit}

	if needsDeposit {
		depositAmount := new(big.Int).Sub(requiredBalance, solanaBalance)
		txBase64, err := p.buildSolanaDepositTx(ctx, payer, depositAmount)
		if err != nil {
			return FundRequest{}, fmt.Errorf("bridge: build Solana deposit tx: %w", err)
		}
		req.DepositTxBase64 = txBase64
	}

	// maxBlockHeight must be comfortably in the future -- Gateway rejected a
	// zero value on a real testnet call ("too low: expected at least
	// 481607645" against a then-current slot of ~480095763, a gap of
	// ~1.51M slots -- almost exactly 7 days at Solana's ~400ms slot time).
	// Query the real current slot and add a 9-day margin rather than
	// hardcoding a slot number that goes stale.
	currentSlot, err := p.solanaRPC.GetSlot(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return FundRequest{}, fmt.Errorf("bridge: get current Solana slot: %w", err)
	}
	maxBlockHeight := new(big.Int).SetUint64(currentSlot + 2_000_000)

	burnIntentMsg, err := encodeBurnIntentForSolana(payer, amount, common.HexToAddress(string(destArcAddress)), maxBlockHeight)
	if err != nil {
		return FundRequest{}, fmt.Errorf("bridge: encode burn intent: %w", err)
	}
	req.BurnIntentMessage = burnIntentMsg

	return req, nil
}

// buildSolanaDepositTx builds the unsigned `deposit` instruction into
// GatewayWallet's PDA structure, using the exact account list confirmed live
// via `anchor idl fetch` against Solana devnet (docs/ubk-capability.md) --
// not guessed from the JS SDK's minified internals.
func (p *GatewayProvider) buildSolanaDepositTx(ctx context.Context, payer Address, amount *big.Int) (string, error) {
	payerPubkey, err := solanago.PublicKeyFromBase58(string(payer))
	if err != nil {
		return "", fmt.Errorf("invalid payer address: %w", err)
	}
	gatewayWalletProgram := solanago.MustPublicKeyFromBase58(SolanaGatewayWalletProgram)
	usdcMint := solanago.MustPublicKeyFromBase58(SolanaUSDCDevnet)

	gatewayWalletPDA, _, err := solanago.FindProgramAddress([][]byte{[]byte("gateway_wallet")}, gatewayWalletProgram)
	if err != nil {
		return "", fmt.Errorf("derive gateway_wallet PDA: %w", err)
	}
	custodyTokenAccount, _, err := solanago.FindProgramAddress(
		[][]byte{[]byte("gateway_wallet_custody"), usdcMint[:]}, gatewayWalletProgram)
	if err != nil {
		return "", fmt.Errorf("derive custody token account PDA: %w", err)
	}
	depositPDA, _, err := solanago.FindProgramAddress(
		[][]byte{[]byte("gateway_deposit"), usdcMint[:], payerPubkey[:]}, gatewayWalletProgram)
	if err != nil {
		return "", fmt.Errorf("derive deposit PDA: %w", err)
	}
	denylistPDA, _, err := solanago.FindProgramAddress(
		[][]byte{[]byte("denylist"), payerPubkey[:]}, gatewayWalletProgram)
	if err != nil {
		return "", fmt.Errorf("derive denylist PDA: %w", err)
	}
	eventAuthorityPDA, _, err := solanago.FindProgramAddress(
		[][]byte{[]byte("__event_authority")}, gatewayWalletProgram)
	if err != nil {
		return "", fmt.Errorf("derive event authority PDA: %w", err)
	}
	ownerUSDCAccount, _, err := solanago.FindProgramAddress(
		[][]byte{payerPubkey[:], solanago.TokenProgramID[:], usdcMint[:]},
		solanago.MustPublicKeyFromBase58("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
	)
	if err != nil {
		return "", fmt.Errorf("derive owner USDC ATA: %w", err)
	}

	// discriminator confirmed via `anchor idl fetch` against devnet (2-byte,
	// not Anchor's usual 8-byte sighash) -- see docs/ubk-capability.md.
	depositDiscriminator := []byte{22, 0}
	data := make([]byte, 0, len(depositDiscriminator)+8)
	data = append(data, depositDiscriminator...)
	amountBuf := make([]byte, 8)
	binary.LittleEndian.PutUint64(amountBuf, amount.Uint64())
	data = append(data, amountBuf...)

	accounts := solanago.AccountMetaSlice{
		solanago.NewAccountMeta(payerPubkey, true, true),  // payer
		solanago.NewAccountMeta(payerPubkey, false, true), // owner (same key here)
		solanago.NewAccountMeta(gatewayWalletPDA, false, false),
		solanago.NewAccountMeta(ownerUSDCAccount, true, false),
		solanago.NewAccountMeta(custodyTokenAccount, true, false),
		solanago.NewAccountMeta(depositPDA, true, false),
		solanago.NewAccountMeta(denylistPDA, false, false),
		solanago.NewAccountMeta(solanago.TokenProgramID, false, false),
		solanago.NewAccountMeta(solanago.SystemProgramID, false, false),
		solanago.NewAccountMeta(eventAuthorityPDA, false, false),
		solanago.NewAccountMeta(gatewayWalletProgram, false, false),
	}

	ix := solanago.NewInstruction(gatewayWalletProgram, accounts, data)

	latestBlockhash, err := p.solanaRPC.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return "", fmt.Errorf("get latest blockhash: %w", err)
	}
	tx, err := solanago.NewTransaction([]solanago.Instruction{ix}, latestBlockhash.Value.Blockhash,
		solanago.TransactionPayer(payerPubkey))
	if err != nil {
		return "", fmt.Errorf("build transaction: %w", err)
	}
	return tx.ToBase64()
}

// encodeBurnIntentForSolana produces the exact byte layout Circle's own SDK
// signs for a Solana-sourced burn intent -- extracted byte-exact from the
// published package, see docs/ubk-capability.md. This is a message
// signature, not a transaction: no gas, no on-chain footprint for this step.
func encodeBurnIntentForSolana(payer Address, amount *big.Int, destRecipient common.Address, maxBlockHeight *big.Int) ([]byte, error) {
	payerPubkey, err := solanago.PublicKeyFromBase58(string(payer))
	if err != nil {
		return nil, fmt.Errorf("invalid payer address: %w", err)
	}
	gatewayWalletProgram := solanago.MustPublicKeyFromBase58(SolanaGatewayWalletProgram)
	usdcMint := solanago.MustPublicKeyFromBase58(SolanaUSDCDevnet)
	arcGatewayMinter := common.HexToAddress(ArcGatewayMinter)
	arcUSDC := common.HexToAddress(ArcUSDC)

	var buf bytes.Buffer

	// [16 bytes] domain prefix: 0xff then 15 zero bytes
	buf.WriteByte(0xff)
	buf.Write(make([]byte, 15))

	writeUint32 := func(v uint32) { binary.Write(&buf, binary.BigEndian, v) }
	writeUint256 := func(v *big.Int) {
		b := make([]byte, 32)
		v.FillBytes(b)
		buf.Write(b)
	}
	writeBytes32Solana := func(pk solanago.PublicKey) { buf.Write(pk[:]) }
	writeBytes32EVM := func(addr common.Address) {
		buf.Write(make([]byte, 12))
		buf.Write(addr[:])
	}

	writeUint32(burnIntentMagic)
	writeUint256(maxBlockHeight)
	// maxFee: Gateway rejected 0 with "Insufficient max fee: expected at
	// least 0.15" on a real testnet call -- 0 is not a valid "use the
	// default" sentinel here, an explicit minimum applies. maxFeeCap (0.3
	// USDC) gives margin above the observed 0.15 floor; production should
	// call POST /v1/estimate first rather than hardcoding a margin.
	writeUint256(maxFeeCap)

	var specBuf bytes.Buffer
	binary.Write(&specBuf, binary.BigEndian, transferSpecMagic)
	binary.Write(&specBuf, binary.BigEndian, uint32(1)) // version
	binary.Write(&specBuf, binary.BigEndian, SolanaDomain)
	binary.Write(&specBuf, binary.BigEndian, ArcDomain)

	specWriteSolana := func(pk solanago.PublicKey) { specBuf.Write(pk[:]) }
	specWriteEVM := func(addr common.Address) {
		specBuf.Write(make([]byte, 12))
		specBuf.Write(addr[:])
	}
	specWriteUint256 := func(v *big.Int) {
		b := make([]byte, 32)
		v.FillBytes(b)
		specBuf.Write(b)
	}

	specWriteSolana(gatewayWalletProgram) // sourceContract
	specWriteEVM(arcGatewayMinter)        // destinationContract
	specWriteSolana(usdcMint)             // sourceToken
	specWriteEVM(arcUSDC)                 // destinationToken
	specWriteSolana(payerPubkey)          // sourceDepositor
	specWriteEVM(destRecipient)           // destinationRecipient
	specWriteSolana(payerPubkey)          // sourceSigner (== depositor)
	specBuf.Write(make([]byte, 32))       // destinationCaller: zero = any relayer may submit
	specWriteUint256(amount)              // value
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate salt: %w", err)
	}
	specBuf.Write(nonce)                                // salt
	binary.Write(&specBuf, binary.BigEndian, uint32(0)) // hookDataLength: 0, plain payment

	writeUint32(uint32(specBuf.Len()))
	buf.Write(specBuf.Bytes())

	_ = writeBytes32Solana
	_ = writeBytes32EVM

	return buf.Bytes(), nil
}

// decodedBurnIntent mirrors the SDK's own serializeBurnIntent/
// serializeTransferSpec output shape -- confirmed byte-exact from
// buildTransferRequestBody in the shipped package (not guessed): a single
// intent becomes {burnIntent: {maxBlockHeight, maxFee, spec}, signature}.
type transferSpecJSON struct {
	Version              uint32 `json:"version"`
	SourceDomain         uint32 `json:"sourceDomain"`
	DestinationDomain    uint32 `json:"destinationDomain"`
	SourceContract       string `json:"sourceContract"`
	DestinationContract  string `json:"destinationContract"`
	SourceToken          string `json:"sourceToken"`
	DestinationToken     string `json:"destinationToken"`
	SourceDepositor      string `json:"sourceDepositor"`
	DestinationRecipient string `json:"destinationRecipient"`
	SourceSigner         string `json:"sourceSigner"`
	DestinationCaller    string `json:"destinationCaller"`
	Value                string `json:"value"`
	Salt                 string `json:"salt"`
}
type burnIntentJSON struct {
	MaxBlockHeight string           `json:"maxBlockHeight"`
	MaxFee         string           `json:"maxFee"`
	Spec           transferSpecJSON `json:"spec"`
}
type gatewayTransferRequest struct {
	BurnIntent burnIntentJSON `json:"burnIntent"`
	Signature  string         `json:"signature"`
}

// decodeBurnIntentForAPI parses encodeBurnIntentForSolana's raw signing
// bytes back into the structured JSON Gateway's /v1/transfer actually wants
// -- the raw bytes are what gets signed (Solana has no EIP-712 equivalent),
// but the wire body is the same structured fields serializeBurnIntent/
// serializeTransferSpec produce in the SDK, confirmed from
// buildTransferRequestBody in the shipped package.
func decodeBurnIntentForAPI(raw []byte) (burnIntentJSON, error) {
	if len(raw) < 16+4+32+32+4 {
		return burnIntentJSON{}, fmt.Errorf("burn intent too short")
	}
	pos := 16 // skip domain prefix
	pos += 4  // skip BURN_INTENT_MAGIC
	maxBlockHeight := new(big.Int).SetBytes(raw[pos : pos+32])
	pos += 32
	maxFee := new(big.Int).SetBytes(raw[pos : pos+32])
	pos += 32
	specLen := binary.BigEndian.Uint32(raw[pos : pos+4])
	pos += 4
	spec := raw[pos : pos+int(specLen)]

	sp := 4 // skip TRANSFER_SPEC_MAGIC
	version := binary.BigEndian.Uint32(spec[sp : sp+4])
	sp += 4
	sourceDomain := binary.BigEndian.Uint32(spec[sp : sp+4])
	sp += 4
	destDomain := binary.BigEndian.Uint32(spec[sp : sp+4])
	sp += 4
	readBytes32 := func() string {
		b := spec[sp : sp+32]
		sp += 32
		return "0x" + fmt.Sprintf("%x", b)
	}
	sourceContract := readBytes32()
	destContract := readBytes32()
	sourceToken := readBytes32()
	destToken := readBytes32()
	sourceDepositor := readBytes32()
	destRecipient := readBytes32()
	sourceSigner := readBytes32()
	destCaller := readBytes32()
	value := new(big.Int).SetBytes(spec[sp : sp+32])
	sp += 32
	salt := readBytes32()

	return burnIntentJSON{
		MaxBlockHeight: maxBlockHeight.String(),
		MaxFee:         maxFee.String(),
		Spec: transferSpecJSON{
			Version:              version,
			SourceDomain:         sourceDomain,
			DestinationDomain:    destDomain,
			SourceContract:       sourceContract,
			DestinationContract:  destContract,
			SourceToken:          sourceToken,
			DestinationToken:     destToken,
			SourceDepositor:      sourceDepositor,
			DestinationRecipient: destRecipient,
			SourceSigner:         sourceSigner,
			DestinationCaller:    destCaller,
			Value:                value.String(),
			Salt:                 salt,
		},
	}, nil
}

type gatewayTransferResponse struct {
	Attestation string `json:"attestation"`
	Signature   string `json:"signature"`
	TransferID  string `json:"transferId"`
	Success     *bool  `json:"success,omitempty"`
	Message     string `json:"message,omitempty"`
}

// Fund submits the payer's signed burn intent via POST /v1/transfer.
// Idempotent on the resulting transferId -- Circle's API rejects a replayed
// intent by its own salt/nonce, the same idempotency shape CCTP's
// nonce-consumption gave the raw implementation this replaces.
func (p *GatewayProvider) Fund(ctx context.Context, req FundRequest) (string, error) {
	if len(req.BurnIntentSignature) == 0 {
		return "", fmt.Errorf("bridge: Fund called without a payer signature on the burn intent")
	}
	intent, err := decodeBurnIntentForAPI(req.BurnIntentMessage)
	if err != nil {
		return "", fmt.Errorf("bridge: decode burn intent for API: %w", err)
	}
	reqBody := []gatewayTransferRequest{{
		BurnIntent: intent,
		Signature:  fmt.Sprintf("0x%x", req.BurnIntentSignature),
	}}
	var resp gatewayTransferResponse
	// enableForwarder=true: Arc is a confirmed Gateway forwarder destination
	// (gateway.forwarderSupported.destination in the SDK's chain
	// definition) -- this makes Circle's own relayer submit the
	// destination-side mint automatically. Confirmed from the SDK's own
	// spend() implementation (buildTransferRequestBody's caller appends
	// this exact query param when useForwarder is set).
	if err := p.post(ctx, "/v1/transfer?enableForwarder=true", reqBody, &resp); err != nil {
		return "", fmt.Errorf("bridge: Gateway transfer: %w", err)
	}
	if resp.Success != nil && !*resp.Success {
		return "", fmt.Errorf("bridge: Gateway transfer API error: %s", resp.Message)
	}
	if resp.TransferID == "" {
		return "", fmt.Errorf("bridge: Gateway transfer response missing transferId")
	}
	return resp.TransferID, nil
}

type gatewayTransferDetails struct {
	DestinationDomain *uint32 `json:"destinationDomain"`
	Status            string  `json:"status"`
	TransactionHash   string  `json:"transactionHash"`
	Success           *bool   `json:"success,omitempty"`
	Message           string  `json:"message,omitempty"`
}

// Status polls GET /v1/transfer/{id}. Arc is a confirmed Gateway forwarder
// destination (ArcGatewayForwarderSupported), so this purely observes
// Circle's own relayer completing the mint -- Conduit never submits it.
func (p *GatewayProvider) Status(ctx context.Context, transferID string) (FundingStatus, error) {
	var resp gatewayTransferDetails
	if err := p.get(ctx, "/v1/transfer/"+transferID, &resp); err != nil {
		return FundingStatus{}, fmt.Errorf("bridge: Gateway transfer status: %w", err)
	}
	if resp.Success != nil && !*resp.Success {
		return FundingStatus{}, fmt.Errorf("bridge: Gateway transfer status API error: %s", resp.Message)
	}

	var state State
	switch resp.Status {
	case "pending":
		state = StateAttestationPending
	case "confirmed":
		state = StateAttested
	case "finalized":
		state = StateMinted
	case "failed", "expired":
		state = StateFailed
	default:
		state = StateAttestationPending
	}

	return FundingStatus{
		State:         state,
		MintTxHash:    resp.TransactionHash,
		FailureReason: resp.Message,
	}, nil
}

func (p *GatewayProvider) post(ctx context.Context, path string, body, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.apiBaseURL+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return p.do(req, out)
}

func (p *GatewayProvider) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.apiBaseURL+path, nil)
	if err != nil {
		return err
	}
	return p.do(req, out)
}

func (p *GatewayProvider) do(req *http.Request, out any) error {
	resp, err := p.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("unmarshal response (status %d): %w, body=%s", resp.StatusCode, err, string(body))
	}
	return nil
}

// decimalUSDCToMinorUnits parses a decimal string like "10.500000" into
// integer minor units (6dp) -- USDC amounts are always integer minor units
// in this codebase, never floats.
func decimalUSDCToMinorUnits(s string) (*big.Int, error) {
	parts := strings.SplitN(s, ".", 2)
	whole := parts[0]
	frac := ""
	if len(parts) == 2 {
		frac = parts[1]
	}
	for len(frac) < 6 {
		frac += "0"
	}
	frac = frac[:6]
	combined := whole + frac
	n, ok := new(big.Int).SetString(combined, 10)
	if !ok {
		return nil, fmt.Errorf("invalid decimal amount %q", s)
	}
	return n, nil
}

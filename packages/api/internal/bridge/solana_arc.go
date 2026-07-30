package bridge

import (
	"context"
	"crypto/ecdsa"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	solanago "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
)

// depositForBurnDiscriminator is the Anchor instruction discriminator for
// TokenMessengerMinterV2's depositForBurn, confirmed against a real devnet
// transaction in Phase 0 (docs/cctp-capability.md).
var depositForBurnDiscriminator = []byte{215, 60, 61, 46, 114, 55, 128, 176}

// associatedTokenProgramID is the SPL Associated Token Account program --
// fixed across all Solana clusters, not CCTP-specific.
var associatedTokenProgramID = solanago.MustPublicKeyFromBase58("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")

// receiveMessageABI is the minimal ABI for MessageTransmitterV2.receiveMessage,
// matching packages/contracts/src/interfaces/ICCTPTokenMessenger.sol's
// ICCTPMessageTransmitter interface.
const receiveMessageABIJSON = `[{
	"type": "function",
	"name": "receiveMessage",
	"stateMutability": "nonpayable",
	"inputs": [
		{"name": "message", "type": "bytes"},
		{"name": "attestation", "type": "bytes"}
	],
	"outputs": [{"name": "success", "type": "bool"}]
}]`

// SolanaArcProvider is the Solana (devnet, domain 5) -> Arc testnet (domain
// 26) CCTP V2 Fast Transfer implementation. Every address/domain it uses
// comes from config.go, sourced from the live-verified facts in
// docs/cctp-capability.md.
type SolanaArcProvider struct {
	solanaRPC  *rpc.Client
	solanaWSURL string
	arcClient  *ethclient.Client
	arcChainID *big.Int
	arcSigner  *ecdsa.PrivateKey
	httpClient *http.Client
	mintABI    abi.ABI
}

func NewSolanaArcProvider(solanaRPCURL, solanaWSURL, arcRPCURL string, arcChainID int64, arcSignerHexKey string) (*SolanaArcProvider, error) {
	arcClient, err := ethclient.Dial(arcRPCURL)
	if err != nil {
		return nil, fmt.Errorf("bridge: dial Arc RPC: %w", err)
	}
	key, err := crypto.HexToECDSA(strings.TrimPrefix(arcSignerHexKey, "0x"))
	if err != nil {
		return nil, fmt.Errorf("bridge: parse Arc signer key: %w", err)
	}
	parsedABI, err := abi.JSON(strings.NewReader(receiveMessageABIJSON))
	if err != nil {
		return nil, fmt.Errorf("bridge: parse receiveMessage ABI: %w", err)
	}
	return &SolanaArcProvider{
		solanaRPC:   rpc.New(solanaRPCURL),
		solanaWSURL: solanaWSURL,
		arcClient:   arcClient,
		arcChainID:  big.NewInt(arcChainID),
		arcSigner:   key,
		httpClient:  &http.Client{Timeout: 15 * time.Second},
		mintABI:     parsedABI,
	}, nil
}

func (p *SolanaArcProvider) Name() string          { return "solana-arc" }
func (p *SolanaArcProvider) SourceDomain() uint32   { return SolanaDomain }

// InitiateBurn builds the depositForBurn instruction and returns an unsigned
// (payer signature missing) transaction for the payer's own wallet to
// countersign and submit on Solana. The ephemeral CCTP message-log account
// this instruction requires is generated and pre-signed here -- the payer
// has no reason to control that key, it's discarded after this call.
func (p *SolanaArcProvider) InitiateBurn(ctx context.Context, payer solanago.PublicKey, amount *big.Int, destRecipient common.Address) (BurnRequest, error) {
	tokenMessengerMinter := solanago.MustPublicKeyFromBase58(SolanaTokenMessengerMinterV2)
	messageTransmitter := solanago.MustPublicKeyFromBase58(SolanaMessageTransmitterV2)
	usdcMint := solanago.MustPublicKeyFromBase58(SolanaUSDCDevnet)

	senderUsdcAccount, _, err := solanago.FindProgramAddress(
		[][]byte{payer[:], solanago.TokenProgramID[:], usdcMint[:]},
		associatedTokenProgramID,
	)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: derive sender USDC ATA: %w", err)
	}

	senderAuthorityPda, _, err := solanago.FindProgramAddress([][]byte{[]byte("sender_authority")}, tokenMessengerMinter)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: derive sender authority PDA: %w", err)
	}
	denylistPda, _, err := solanago.FindProgramAddress([][]byte{[]byte("denylist_account"), payer[:]}, tokenMessengerMinter)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: derive denylist PDA: %w", err)
	}
	messageTransmitterPda, _, err := solanago.FindProgramAddress([][]byte{[]byte("message_transmitter")}, messageTransmitter)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: derive message transmitter PDA: %w", err)
	}
	tokenMessengerPda, _, err := solanago.FindProgramAddress([][]byte{[]byte("token_messenger")}, tokenMessengerMinter)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: derive token messenger PDA: %w", err)
	}
	remoteTokenMessengerPda, _, err := solanago.FindProgramAddress(
		[][]byte{[]byte("remote_token_messenger"), []byte(fmt.Sprintf("%d", ArcDomain))},
		tokenMessengerMinter,
	)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: derive remote token messenger PDA: %w", err)
	}
	tokenMinterPda, _, err := solanago.FindProgramAddress([][]byte{[]byte("token_minter")}, tokenMessengerMinter)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: derive token minter PDA: %w", err)
	}
	localTokenPda, _, err := solanago.FindProgramAddress([][]byte{[]byte("local_token"), usdcMint[:]}, tokenMessengerMinter)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: derive local token PDA: %w", err)
	}
	eventAuthorityPda, _, err := solanago.FindProgramAddress([][]byte{[]byte("__event_authority")}, tokenMessengerMinter)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: derive event authority PDA: %w", err)
	}
	transmitterEventAuthorityPda, _, err := solanago.FindProgramAddress([][]byte{[]byte("__event_authority")}, messageTransmitter)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: derive message transmitter event authority PDA: %w", err)
	}

	messageSentEventAccount, err := solanago.NewRandomPrivateKey()
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: generate message-sent event keypair: %w", err)
	}

	destBytes32 := make([]byte, 32)
	copy(destBytes32[12:], destRecipient[:])

	maxFee := uint64(500) // testnet default; see CCTPAdapter.sol's precedent for this project

	data := make([]byte, 0, 8+8+4+32+32+8+4)
	data = append(data, depositForBurnDiscriminator...)
	data = binary.LittleEndian.AppendUint64(data, amount.Uint64())
	data = binary.LittleEndian.AppendUint32(data, ArcDomain)
	data = append(data, destBytes32...)
	data = append(data, make([]byte, 32)...) // destinationCaller = zero = any relayer may submit the mint
	data = binary.LittleEndian.AppendUint64(data, maxFee)
	data = binary.LittleEndian.AppendUint32(data, FastFinalityThreshold)

	accounts := solanago.AccountMetaSlice{
		solanago.NewAccountMeta(payer, true, true),
		solanago.NewAccountMeta(payer, true, true),
		solanago.NewAccountMeta(senderAuthorityPda, false, false),
		solanago.NewAccountMeta(senderUsdcAccount, true, false),
		solanago.NewAccountMeta(denylistPda, false, false),
		solanago.NewAccountMeta(messageTransmitterPda, true, false),
		solanago.NewAccountMeta(tokenMessengerPda, false, false),
		solanago.NewAccountMeta(remoteTokenMessengerPda, false, false),
		solanago.NewAccountMeta(tokenMinterPda, false, false),
		solanago.NewAccountMeta(localTokenPda, true, false),
		solanago.NewAccountMeta(usdcMint, true, false),
		solanago.NewAccountMeta(messageSentEventAccount.PublicKey(), true, true),
		solanago.NewAccountMeta(messageTransmitter, false, false),
		solanago.NewAccountMeta(tokenMessengerMinter, false, false),
		solanago.NewAccountMeta(solanago.TokenProgramID, false, false),
		solanago.NewAccountMeta(solanago.SystemProgramID, false, false),
		solanago.NewAccountMeta(eventAuthorityPda, false, false),
		solanago.NewAccountMeta(tokenMessengerMinter, false, false),
		solanago.NewAccountMeta(transmitterEventAuthorityPda, false, false),
		solanago.NewAccountMeta(messageTransmitter, false, false),
	}

	ix := solanago.NewInstruction(tokenMessengerMinter, accounts, data)

	// Finalized, not confirmed: SendAndConfirmTransaction's default preflight
	// simulation runs at finalized commitment, which lags confirmed by a few
	// slots -- a confirmed-commitment blockhash can come back
	// "BlockhashNotFound" during that simulation even though it's genuinely
	// recent (hit this for real while proving Phase 2).
	latestBlockhash, err := p.solanaRPC.GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: get latest blockhash: %w", err)
	}

	tx, err := solanago.NewTransaction(
		[]solanago.Instruction{ix},
		latestBlockhash.Value.Blockhash,
		solanago.TransactionPayer(payer),
	)
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: build transaction: %w", err)
	}

	// Pre-sign the ephemeral message-log account's slot. The payer's own
	// signature slot is left empty -- they add it client-side.
	if _, err := tx.PartialSign(func(key solanago.PublicKey) *solanago.PrivateKey {
		if key.Equals(messageSentEventAccount.PublicKey()) {
			return &messageSentEventAccount
		}
		return nil
	}); err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: partial-sign transaction: %w", err)
	}

	txBase64, err := tx.ToBase64()
	if err != nil {
		return BurnRequest{}, fmt.Errorf("bridge: serialize transaction: %w", err)
	}

	return BurnRequest{
		UnsignedTxBase64: txBase64,
		RecentBlockhash:  latestBlockhash.Value.Blockhash.String(),
	}, nil
}

type irisMessage struct {
	Message     string `json:"message"`
	Attestation string `json:"attestation"`
	Status      string `json:"status"`
}
type irisResponse struct {
	Messages []irisMessage `json:"messages"`
}

// PollAttestation polls Iris every 5s with a 60s hard timeout -- observed
// real latency in Phase 0 was ~14s; 60s gives ample margin above the
// documented 8-30s Fast Transfer window before giving up and letting the
// caller mark the transfer failed rather than hang indefinitely.
func (p *SolanaArcProvider) PollAttestation(ctx context.Context, sourceTxHash string) (Attestation, error) {
	deadline := time.Now().Add(60 * time.Second)
	url := fmt.Sprintf("%s/v2/messages/%d?transactionHash=%s", IrisSandboxBaseURL, SolanaDomain, sourceTxHash)

	for {
		if time.Now().After(deadline) {
			return Attestation{}, fmt.Errorf("bridge: attestation timeout after 60s for tx %s", sourceTxHash)
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return Attestation{}, fmt.Errorf("bridge: build Iris request: %w", err)
		}
		resp, err := p.httpClient.Do(req)
		if err != nil {
			if waitOrDone(ctx) {
				return Attestation{}, ctx.Err()
			}
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound {
			if waitOrDone(ctx) {
				return Attestation{}, ctx.Err()
			}
			continue
		}
		if resp.StatusCode != http.StatusOK {
			return Attestation{}, fmt.Errorf("bridge: Iris returned %d: %s", resp.StatusCode, string(body))
		}

		var parsed irisResponse
		if err := json.Unmarshal(body, &parsed); err != nil {
			return Attestation{}, fmt.Errorf("bridge: parse Iris response: %w", err)
		}
		if len(parsed.Messages) == 0 || parsed.Messages[0].Status != "complete" {
			if waitOrDone(ctx) {
				return Attestation{}, ctx.Err()
			}
			continue
		}

		msg := parsed.Messages[0]
		messageBytes, err := hex.DecodeString(strings.TrimPrefix(msg.Message, "0x"))
		if err != nil {
			return Attestation{}, fmt.Errorf("bridge: decode message hex: %w", err)
		}
		attBytes, err := hex.DecodeString(strings.TrimPrefix(msg.Attestation, "0x"))
		if err != nil {
			return Attestation{}, fmt.Errorf("bridge: decode attestation hex: %w", err)
		}
		return Attestation{
			SourceTxHash:     sourceTxHash,
			Message:          messageBytes,
			AttestationBytes: attBytes,
			Status:           msg.Status,
		}, nil
	}
}

func waitOrDone(ctx context.Context) bool {
	select {
	case <-ctx.Done():
		return true
	case <-time.After(5 * time.Second):
		return false
	}
}

// Mint submits receiveMessage on Arc. See provider.go's interface doc for
// the idempotency contract -- CCTP's own nonce-consumption on
// MessageTransmitterV2 is what actually prevents a double-mint if this gets
// called twice for the same attestation; this method makes no attempt at
// its own dedup beyond that.
func (p *SolanaArcProvider) Mint(ctx context.Context, att Attestation) (mintTxHash string, minted *big.Int, err error) {
	calldata, err := p.mintABI.Pack("receiveMessage", att.Message, att.AttestationBytes)
	if err != nil {
		return "", nil, fmt.Errorf("bridge: pack receiveMessage calldata: %w", err)
	}

	fromAddr := crypto.PubkeyToAddress(p.arcSigner.PublicKey)
	nonce, err := p.arcClient.PendingNonceAt(ctx, fromAddr)
	if err != nil {
		return "", nil, fmt.Errorf("bridge: fetch Arc nonce: %w", err)
	}
	gasPrice, err := p.arcClient.SuggestGasPrice(ctx)
	if err != nil {
		return "", nil, fmt.Errorf("bridge: fetch Arc gas price: %w", err)
	}

	to := common.HexToAddress(ArcMessageTransmitterV2)
	gasLimit, err := p.arcClient.EstimateGas(ctx, ethereum.CallMsg{From: fromAddr, To: &to, Data: calldata})
	if err != nil {
		return "", nil, fmt.Errorf("bridge: estimate Arc gas: %w", err)
	}
	// Real receiveMessage calls observed ~176k gas in Phase 0; pad generously
	// since underestimating aborts a mint that can't be "cancelled" and would
	// need a fresh submission anyway.
	gasLimit = gasLimit * 3 / 2

	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		To:       &to,
		Value:    big.NewInt(0),
		Gas:      gasLimit,
		GasPrice: gasPrice,
		Data:     calldata,
	})

	signedTx, err := types.SignTx(tx, types.NewEIP155Signer(p.arcChainID), p.arcSigner)
	if err != nil {
		return "", nil, fmt.Errorf("bridge: sign Arc mint tx: %w", err)
	}
	if err := p.arcClient.SendTransaction(ctx, signedTx); err != nil {
		return "", nil, fmt.Errorf("bridge: submit Arc mint tx: %w", err)
	}

	receipt, err := bind.WaitMined(ctx, p.arcClient, signedTx)
	if err != nil {
		return "", nil, fmt.Errorf("bridge: wait for Arc mint receipt: %w", err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return "", nil, fmt.Errorf("bridge: Arc mint tx %s reverted", signedTx.Hash().Hex())
	}

	minted, err = mintedAmountFromReceipt(receipt, common.HexToAddress(ArcUSDC))
	if err != nil {
		return "", nil, err
	}

	return signedTx.Hash().Hex(), minted, nil
}

// transferEventTopic is keccak256("Transfer(address,address,uint256)") --
// confirmed against a real Arc testnet mint receipt in Phase 0.
var transferEventTopic = common.HexToHash("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
var zeroTopic = common.Hash{}

// mintedAmountFromReceipt reads the USDC Transfer(0x0 -> recipient, amount)
// log the mint produced. The minted amount is burn_amount minus whatever fee
// CCTP actually charged (observed non-zero on a real transfer, see
// docs/cctp-capability.md) -- never assume it equals the burned amount.
func mintedAmountFromReceipt(receipt *types.Receipt, usdc common.Address) (*big.Int, error) {
	for _, log := range receipt.Logs {
		if log.Address != usdc {
			continue
		}
		if len(log.Topics) != 3 || log.Topics[0] != transferEventTopic || log.Topics[1] != zeroTopic {
			continue
		}
		return new(big.Int).SetBytes(log.Data), nil
	}
	return nil, fmt.Errorf("bridge: no USDC mint Transfer log found in receipt %s", receipt.TxHash.Hex())
}

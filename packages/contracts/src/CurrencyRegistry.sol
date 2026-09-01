// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title CurrencyRegistry
/// @notice Owner-managed registry mapping a 3-byte ISO-style currency code to its
///         on-chain token, decimals, and enabled status. Replaces the hardcoded
///         `Currency = "USDC" | "EURC"` assumption everywhere else in the stack.
/// @dev Registration reads the token's own `decimals()` and reverts if the caller's
///      claimed value disagrees — decimals can never be silently wrong here.
contract CurrencyRegistry is Ownable2Step {
    struct CurrencyInfo {
        address token;
        uint8 decimals;
        bool enabled;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(bytes3 => CurrencyInfo) private _currencies;
    bytes3[] private _codes;

    /// @dev Reverse index, so `isEnabledToken` is a single mapping read.
    ///
    ///      It used to loop `_codes` unbounded. That is tolerable in a view
    ///      nothing calls on-chain and a trap the moment something does — which
    ///      is exactly what ConduitRouter now does on every payment. An
    ///      unbounded loop in the settlement path means the owner can make
    ///      payments cost more gas simply by registering more currencies, and
    ///      eventually make them impossible.
    mapping(address => bytes3) private _tokenToCode;

    // ── Events ────────────────────────────────────────────────────────────────

    event CurrencyRegistered(bytes3 indexed code, address indexed token, uint8 decimals);
    event CurrencyEnabledSet(bytes3 indexed code, bool enabled);

    // ── Errors ────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error DecimalsMismatch(uint8 claimed, uint8 actual);
    error AlreadyRegistered(bytes3 code);
    error NotRegistered(bytes3 code);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// @notice Register a currency code against a token. Reverts if `decimals`
    ///         doesn't match what the token itself reports.
    function registerCurrency(bytes3 code, address token, uint8 decimals) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (_currencies[code].token != address(0)) revert AlreadyRegistered(code);

        uint8 actual = IERC20Metadata(token).decimals();
        if (actual != decimals) revert DecimalsMismatch(decimals, actual);

        _currencies[code] = CurrencyInfo({token: token, decimals: decimals, enabled: true});
        _codes.push(code);
        _tokenToCode[token] = code;

        emit CurrencyRegistered(code, token, decimals);
    }

    /// @notice Point an already-registered code at a different token.
    /// @dev For migrations — a token redeployment, or a testnet address moving.
    ///      Keeps `registerCurrency`'s `decimals()` cross-check, because a
    ///      migration is exactly when a wrong decimals value would go unnoticed
    ///      and misprice every payment in that currency by a factor of a
    ///      hundred.
    ///
    ///      Maintains `_tokenToCode` on BOTH sides: the old token is cleared
    ///      before the new one is set. Without the clear, the old address would
    ///      keep resolving through the reverse index and stay spendable through
    ///      the router forever — a currency migration that never actually
    ///      migrated anything.
    function setToken(bytes3 code, address token, uint8 decimals) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        CurrencyInfo storage info = _currencies[code];
        if (info.token == address(0)) revert NotRegistered(code);

        uint8 actual = IERC20Metadata(token).decimals();
        if (actual != decimals) revert DecimalsMismatch(decimals, actual);

        delete _tokenToCode[info.token];
        info.token = token;
        info.decimals = decimals;
        _tokenToCode[token] = code;

        emit CurrencyRegistered(code, token, decimals);
    }

    function setEnabled(bytes3 code, bool enabled) external onlyOwner {
        if (_currencies[code].token == address(0)) revert NotRegistered(code);
        _currencies[code].enabled = enabled;
        emit CurrencyEnabledSet(code, enabled);
    }

    // ── View ──────────────────────────────────────────────────────────────────

    function getCurrency(bytes3 code) external view returns (CurrencyInfo memory) {
        return _currencies[code];
    }

    function isEnabled(bytes3 code) external view returns (bool) {
        return _currencies[code].enabled;
    }

    /// @notice Reverse lookup: is `token` a registered, enabled currency's token?
    /// @dev O(1). ConduitRouter calls this inside `execute`, so its cost is paid
    ///      by every payer on every payment and must not grow with the number of
    ///      registered currencies.
    function isEnabledToken(address token) external view returns (bool) {
        bytes3 code = _tokenToCode[token];
        if (code == bytes3(0)) return false;
        return _currencies[code].enabled;
    }

    function allCodes() external view returns (bytes3[] memory) {
        return _codes;
    }
}

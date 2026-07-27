// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title CurrencyRegistry
/// @notice Owner-managed registry mapping a 3-byte ISO-style currency code to its
///         on-chain token, decimals, and enabled status. Replaces the hardcoded
///         `Currency = "USDC" | "EURC"` assumption everywhere else in the stack.
/// @dev Registration reads the token's own `decimals()` and reverts if the caller's
///      claimed value disagrees — decimals can never be silently wrong here.
contract CurrencyRegistry is Ownable {
    struct CurrencyInfo {
        address token;
        uint8 decimals;
        bool enabled;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(bytes3 => CurrencyInfo) private _currencies;
    bytes3[] private _codes;

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
    function isEnabledToken(address token) external view returns (bool) {
        uint256 len = _codes.length;
        for (uint256 i = 0; i < len; i++) {
            CurrencyInfo storage info = _currencies[_codes[i]];
            if (info.token == token) return info.enabled;
        }
        return false;
    }

    function allCodes() external view returns (bytes3[] memory) {
        return _codes;
    }
}

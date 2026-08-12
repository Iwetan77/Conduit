// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title SettlementPreferenceRegistry
/// @notice A standing address preference: "always settle payments to me in this
///         token." No owner, no admin — a preference belongs to the address that
///         set it, and only that address can change or clear it.
contract SettlementPreferenceRegistry {
    struct Preference {
        address token;
        bool active;
    }

    mapping(address => Preference) public preferenceOf;

    event PreferenceSet(address indexed account, address indexed token);
    event PreferenceCleared(address indexed account);

    error ZeroToken();

    /// @notice Set the token every direct payment to msg.sender must settle in.
    /// @dev The zero-address guard matters more here than it looks: without it
    ///      an account could store {token: address(0), active: true}, which is
    ///      an ACTIVE preference for a token that doesn't exist. Every payment
    ///      to that address would then be checked against an impossible
    ///      requirement and rejected, with no way to tell from the outside that
    ///      the cause was a fat-fingered zero. Use clearPreference() to opt out.
    function setPreference(address token) external {
        if (token == address(0)) revert ZeroToken();
        preferenceOf[msg.sender] = Preference({token: token, active: true});
        emit PreferenceSet(msg.sender, token);
    }

    function clearPreference() external {
        delete preferenceOf[msg.sender];
        emit PreferenceCleared(msg.sender);
    }
}

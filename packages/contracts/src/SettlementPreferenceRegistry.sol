// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

    function setPreference(address token) external {
        preferenceOf[msg.sender] = Preference({token: token, active: true});
        emit PreferenceSet(msg.sender, token);
    }

    function clearPreference() external {
        delete preferenceOf[msg.sender];
        emit PreferenceCleared(msg.sender);
    }
}

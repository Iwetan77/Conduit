// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A token that takes a cut of every transfer.
///
/// Real ones exist, and a payroll contract that pulls a total and then pays out
/// individual amounts will run out partway down the list if it meets one. The
/// point of this mock is to prove the contract refuses rather than paying the
/// first few people and reverting on somebody near the end.
contract FeeOnTransferERC20 is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("Fee", "FEE") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(0xFEE), fee);
    }
}

/// @dev A token that refuses to pay one particular address.
///
/// This is what a blocklist looks like from the contract's side, and it is the
/// realistic version of "a recipient that reverts": an ordinary ERC-20 transfer
/// calls no hook on the recipient, so a recipient cannot reject a payment. The
/// TOKEN can, and USDC does.
contract BlocklistERC20 is ERC20 {
    address public blocked;

    constructor(address blocked_) ERC20("Block", "BLK") {
        blocked = blocked_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to != blocked, "recipient blocked");
        super._update(from, to, value);
    }
}

/// @dev A token whose transfer calls back into the caller before finishing.
///
/// ERC-777 and its relatives do this. Without a guard it is the shape that lets
/// a recipient re-enter mid-payroll.
contract ReentrantERC20 is ERC20 {
    address public target;
    bytes public payload;
    bool private entered;

    constructor() ERC20("Reenter", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0) && !entered && from != address(0)) {
            entered = true;
            (bool ok, ) = target.call(payload);
            ok; // the re-entry is EXPECTED to fail; the guard is what this proves
            entered = false;
        }
    }
}

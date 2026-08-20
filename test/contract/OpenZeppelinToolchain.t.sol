// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract OwnableHarness is Ownable {
    constructor() Ownable(msg.sender) {}
}

contract OpenZeppelinToolchainTest {
    function testOwnableInitializesTheDeployingAddress() public {
        OwnableHarness harness = new OwnableHarness();
        require(harness.owner() == address(this), "unexpected owner");
    }
}

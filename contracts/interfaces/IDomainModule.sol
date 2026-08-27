// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IDomainModule {
    function moduleType() external view returns (bytes32);
    function compatibilityVersion() external view returns (uint64);
}

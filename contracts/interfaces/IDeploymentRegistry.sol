// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IDeploymentRegistry {
    function activeModules(bytes32 moduleType) external view returns (address);
    function bindAggregateOrigin(bytes32 aggregateId) external;
}

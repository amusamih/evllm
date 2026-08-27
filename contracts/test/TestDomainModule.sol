// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IDomainModule} from "../interfaces/IDomainModule.sol";

interface IDeploymentRegistryOrigin {
    function bindAggregateOrigin(bytes32 aggregateId) external;
}

contract TestDomainModule is IDomainModule {
    bytes32 private immutable kind;
    uint64 private immutable version;

    constructor(bytes32 moduleType_, uint64 compatibilityVersion_) {
        kind = moduleType_;
        version = compatibilityVersion_;
    }

    function moduleType() external view returns (bytes32) {
        return kind;
    }

    function compatibilityVersion() external view returns (uint64) {
        return version;
    }

    function bindOrigin(address registry, bytes32 aggregateId) external {
        IDeploymentRegistryOrigin(registry).bindAggregateOrigin(aggregateId);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IDomainModule} from "./interfaces/IDomainModule.sol";

contract DeploymentRegistry is Ownable {
    struct Proposal {
        address module;
        uint64 compatibilityVersion;
        uint64 activateAfter;
    }

    address public immutable authorityProfileRegistry;
    address public immutable protectedBundleRegistry;
    address public immutable batteryOwnershipRegistry;
    uint64 public immutable reviewDelay;

    mapping(bytes32 moduleType => address) public activeModules;
    mapping(bytes32 moduleType => Proposal) public proposals;
    mapping(bytes32 aggregateId => address) public originModule;

    error InvalidModule();
    error ReviewDelayNotElapsed();
    error OriginAlreadyBound();
    error NotAggregateOrigin();

    event ModuleProposed(bytes32 indexed moduleType, address indexed module, uint64 activateAfter);
    event ModuleActivated(bytes32 indexed moduleType, address indexed module);
    event AggregateOriginBound(bytes32 indexed aggregateId, address indexed module);

    constructor(
        address governance,
        address authorityProfileRegistryAddress,
        address protectedBundleRegistryAddress,
        address batteryOwnershipRegistryAddress,
        uint64 reviewDelaySeconds
    ) Ownable(governance) {
        if (
            authorityProfileRegistryAddress == address(0) || protectedBundleRegistryAddress == address(0)
                || batteryOwnershipRegistryAddress == address(0)
        ) revert InvalidModule();
        authorityProfileRegistry = authorityProfileRegistryAddress;
        protectedBundleRegistry = protectedBundleRegistryAddress;
        batteryOwnershipRegistry = batteryOwnershipRegistryAddress;
        reviewDelay = reviewDelaySeconds;
    }

    function proposeModule(bytes32 expectedType, address module) external onlyOwner {
        if (module.code.length == 0 || IDomainModule(module).moduleType() != expectedType) revert InvalidModule();
        uint64 compatibility = IDomainModule(module).compatibilityVersion();
        if (compatibility == 0) revert InvalidModule();
        uint64 activateAfter = uint64(block.timestamp) + reviewDelay;
        proposals[expectedType] = Proposal(module, compatibility, activateAfter);
        emit ModuleProposed(expectedType, module, activateAfter);
    }

    function activateModule(bytes32 moduleType_) external onlyOwner {
        Proposal memory proposal = proposals[moduleType_];
        if (proposal.module == address(0)) revert InvalidModule();
        if (block.timestamp < proposal.activateAfter) revert ReviewDelayNotElapsed();
        activeModules[moduleType_] = proposal.module;
        delete proposals[moduleType_];
        emit ModuleActivated(moduleType_, proposal.module);
    }

    function bindAggregateOrigin(bytes32 aggregateId) external {
        if (aggregateId == bytes32(0)) revert InvalidModule();
        if (originModule[aggregateId] != address(0)) revert OriginAlreadyBound();
        bool active = false;
        // The replaceable module set is deliberately small; binding is constant-time.
        bytes32[4] memory types = [bytes32("evidence"), bytes32("assessment"), bytes32("marketplace"), bytes32("audit")];
        for (uint256 index = 0; index < types.length; index++) {
            if (activeModules[types[index]] == msg.sender) active = true;
        }
        if (!active) revert NotAggregateOrigin();
        originModule[aggregateId] = msg.sender;
        emit AggregateOriginBound(aggregateId, msg.sender);
    }
}

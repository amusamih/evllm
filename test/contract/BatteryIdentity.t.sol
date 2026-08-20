// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {BatteryOwnershipRegistry} from "../../contracts/BatteryOwnershipRegistry.sol";

contract BatteryIdentityTest is Test {
    BatteryOwnershipRegistry internal registry;
    address internal registrar = makeAddr("registrar");
    address internal ownerAccount = makeAddr("owner");
    address internal marketplace = makeAddr("marketplace");
    bytes32 internal ownerOrganization = keccak256("org:owner");
    bytes32 internal buyerOrganization = keccak256("org:buyer");

    function setUp() public {
        registry = new BatteryOwnershipRegistry(address(this));
        registry.setRegistrar(registrar, true);
        registry.setMarketplace(marketplace, true);
    }

    function test_initialAcceptanceHierarchyAndAppendOnlyOwnershipHistory() public {
        bytes32 proposalId = keccak256("proposal:1");
        bytes32 batteryId = keccak256("battery:1");
        bytes32 moduleId = keccak256("module:1");
        bytes32 cellId = keccak256("cell:1");

        vm.prank(registrar);
        registry.proposeInitialOwnership(
            proposalId, batteryId, ownerOrganization, ownerAccount, uint64(block.timestamp + 1 days)
        );
        vm.prank(ownerAccount);
        registry.acceptInitialOwnership(proposalId);

        vm.startPrank(registrar);
        registry.registerComponent(
            moduleId, batteryId, BatteryOwnershipRegistry.SubjectGranularity.Module
        );
        registry.registerComponent(cellId, moduleId, BatteryOwnershipRegistry.SubjectGranularity.Cell);
        vm.stopPrank();

        (bytes32 cellParent, bytes32 root, BatteryOwnershipRegistry.SubjectGranularity granularity,) =
            registry.subjects(cellId);
        assertEq(cellParent, moduleId);
        assertEq(root, batteryId);
        assertEq(uint256(granularity), uint256(BatteryOwnershipRegistry.SubjectGranularity.Cell));

        vm.startPrank(marketplace);
        registry.lockForMarketplace(batteryId);
        registry.transferRecordedOwnership(batteryId, buyerOrganization);
        vm.stopPrank();

        assertEq(registry.ownershipTransitionCount(batteryId), 2);
        (bytes32 previous, bytes32 next, address authorizedMarketplace,) =
            registry.ownershipTransitions(batteryId, 2);
        assertEq(previous, ownerOrganization);
        assertEq(next, buyerOrganization);
        assertEq(authorizedMarketplace, marketplace);
    }

    function test_negativeProposalHierarchyDuplicateAndExpiryPaths() public {
        bytes32 proposalId = keccak256("proposal:negative");
        bytes32 batteryId = keccak256("battery:negative");
        vm.prank(registrar);
        registry.proposeInitialOwnership(
            proposalId, batteryId, ownerOrganization, ownerAccount, uint64(block.timestamp + 10)
        );

        vm.prank(makeAddr("not-owner"));
        vm.expectRevert(BatteryOwnershipRegistry.InvalidProposalState.selector);
        registry.acceptInitialOwnership(proposalId);

        vm.warp(block.timestamp + 10);
        vm.prank(ownerAccount);
        vm.expectRevert(BatteryOwnershipRegistry.ProposalExpired.selector);
        registry.acceptInitialOwnership(proposalId);
        registry.expireInitialOwnership(proposalId);

        bytes32 pack = keccak256("pack:direct");
        vm.prank(registrar);
        registry.registerBattery(pack, ownerOrganization);
        vm.prank(registrar);
        vm.expectRevert(BatteryOwnershipRegistry.InvalidHierarchy.selector);
        registry.registerComponent(
            keccak256("cell:without-module"), pack, BatteryOwnershipRegistry.SubjectGranularity.Cell
        );
        vm.prank(registrar);
        vm.expectRevert(BatteryOwnershipRegistry.AlreadyRegistered.selector);
        registry.registerBattery(pack, ownerOrganization);
    }

    function test_proposalRejectionDuplicateAndComponentAuthorization() public {
        bytes32 proposalId = keccak256("proposal:reject");
        bytes32 batteryId = keccak256("battery:reject");
        vm.prank(registrar);
        registry.proposeInitialOwnership(
            proposalId, batteryId, ownerOrganization, ownerAccount, uint64(block.timestamp + 100)
        );
        vm.prank(registrar);
        vm.expectRevert(BatteryOwnershipRegistry.AlreadyRegistered.selector);
        registry.proposeInitialOwnership(
            proposalId, keccak256("another-battery"), ownerOrganization, ownerAccount, uint64(block.timestamp + 100)
        );
        vm.prank(ownerAccount);
        registry.rejectInitialOwnership(proposalId);
        vm.prank(ownerAccount);
        vm.expectRevert(BatteryOwnershipRegistry.InvalidProposalState.selector);
        registry.rejectInitialOwnership(proposalId);

        vm.prank(registrar);
        vm.expectRevert(BatteryOwnershipRegistry.ProposalExpired.selector);
        registry.proposeInitialOwnership(
            keccak256("expired-at-create"),
            batteryId,
            ownerOrganization,
            ownerAccount,
            uint64(block.timestamp)
        );
        vm.expectRevert(BatteryOwnershipRegistry.NotRegistrar.selector);
        registry.registerComponent(
            keccak256("unauthorized-module"),
            batteryId,
            BatteryOwnershipRegistry.SubjectGranularity.Module
        );
    }
}

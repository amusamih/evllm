// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AuthorityProfileRegistry} from "../../contracts/AuthorityProfileRegistry.sol";
import {BatteryOwnershipRegistry} from "../../contracts/BatteryOwnershipRegistry.sol";
import {DeploymentRegistry} from "../../contracts/DeploymentRegistry.sol";
import {ProtectedBundleRegistry} from "../../contracts/ProtectedBundleRegistry.sol";
import {TestDomainModule} from "../../contracts/test/TestDomainModule.sol";

contract RegistriesTest is Test {
    AuthorityProfileRegistry internal authority;
    BatteryOwnershipRegistry internal ownership;
    ProtectedBundleRegistry internal bundles;
    DeploymentRegistry internal deployments;

    address internal outsider = address(0xBEEF);
    address internal replicaSigner = address(0xA11CE);
    bytes32 internal organizationId = keccak256("organization-a");
    bytes32 internal replicaOrganizationId = keccak256("organization-replica");
    bytes32 internal replicaCredentialId = keccak256("credential-replica");

    function setUp() public {
        authority = new AuthorityProfileRegistry(address(this));
        ownership = new BatteryOwnershipRegistry(address(this));
        bundles = new ProtectedBundleRegistry(address(authority));
        deployments = new DeploymentRegistry(address(this), address(authority), address(bundles), address(ownership), 1 days);
        authority.setOrganizationStatus(organizationId, AuthorityProfileRegistry.OrganizationStatus.Active);
        authority.setOrganizationStatus(replicaOrganizationId, AuthorityProfileRegistry.OrganizationStatus.Active);
        authority.setCredential(replicaCredentialId, replicaOrganizationId, replicaSigner, true, true);
    }

    function test_unitStableRegistryBindings() public view {
        assertEq(deployments.authorityProfileRegistry(), address(authority));
        assertEq(deployments.protectedBundleRegistry(), address(bundles));
        assertEq(deployments.batteryOwnershipRegistry(), address(ownership));
        assertEq(deployments.reviewDelay(), 1 days);
    }

    function test_negativeUnauthorizedGovernanceIsRejected() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        authority.setRepositoryApproval(keccak256("repository-a"), true);
    }

    function test_authorityProfileAndTerminalOrganizationBranches() public {
        bytes32 profileId = keccak256("profile-a");
        bytes32 digest = keccak256("profile-digest");
        authority.setProfile(profileId, 1, digest, true);
        assertTrue(authority.isProfileActive(profileId, 1, digest));
        assertFalse(authority.isProfileActive(profileId, 1, keccak256("wrong")));
        assertFalse(authority.isProfileActive(profileId, 2, digest));

        vm.expectRevert(AuthorityProfileRegistry.InvalidIdentifier.selector);
        authority.setProfile(bytes32(0), 1, digest, true);
        vm.expectRevert(AuthorityProfileRegistry.InvalidVersion.selector);
        authority.setProfile(profileId, 0, digest, true);
        vm.expectRevert(AuthorityProfileRegistry.InvalidIdentifier.selector);
        authority.setRepositoryApproval(bytes32(0), true);
        vm.expectRevert(AuthorityProfileRegistry.InvalidIdentifier.selector);
        authority.setOrganizationStatus(bytes32(0), AuthorityProfileRegistry.OrganizationStatus.Active);

        authority.setOrganizationStatus(organizationId, AuthorityProfileRegistry.OrganizationStatus.Revoked);
        assertFalse(authority.isOrganizationActive(organizationId));
        vm.expectRevert(AuthorityProfileRegistry.TerminalOrganization.selector);
        authority.setOrganizationStatus(organizationId, AuthorityProfileRegistry.OrganizationStatus.Active);
    }

    function test_eventAndStateAgreementForBatteryOwnership() public {
        bytes32 batteryId = keccak256("battery-a");
        bytes32 nextOwner = keccak256("organization-b");
        ownership.setRegistrar(address(this), true);
        ownership.setMarketplace(address(this), true);

        vm.expectEmit(true, true, false, true);
        emit BatteryOwnershipRegistry.BatteryRegistered(batteryId, organizationId);
        ownership.registerBattery(batteryId, organizationId);
        ownership.lockForMarketplace(batteryId);
        ownership.transferRecordedOwnership(batteryId, nextOwner);

        (bytes32 recordedOwner, address marketplaceLock, bool registered) = ownership.batteries(batteryId);
        assertTrue(registered);
        assertEq(recordedOwner, nextOwner);
        assertEq(marketplaceLock, address(0));
    }

    function test_batteryFailureBranchesAndMarketplaceExclusion() public {
        bytes32 batteryId = keccak256("battery-negative");
        bytes32 ownerId = keccak256("owner-negative");

        vm.expectRevert(BatteryOwnershipRegistry.NotRegistrar.selector);
        ownership.registerBattery(batteryId, ownerId);
        ownership.setRegistrar(address(this), true);
        vm.expectRevert(BatteryOwnershipRegistry.InvalidIdentifier.selector);
        ownership.registerBattery(bytes32(0), ownerId);
        ownership.registerBattery(batteryId, ownerId);
        vm.expectRevert(BatteryOwnershipRegistry.AlreadyRegistered.selector);
        ownership.registerBattery(batteryId, ownerId);

        vm.expectRevert(BatteryOwnershipRegistry.NotAuthorizedMarketplace.selector);
        ownership.lockForMarketplace(batteryId);
        ownership.setMarketplace(address(this), true);
        vm.expectRevert(BatteryOwnershipRegistry.UnknownBattery.selector);
        ownership.lockForMarketplace(keccak256("unknown"));
        ownership.lockForMarketplace(batteryId);

        address secondMarketplace = address(0xCAFE);
        ownership.setMarketplace(secondMarketplace, true);
        vm.prank(secondMarketplace);
        vm.expectRevert(BatteryOwnershipRegistry.LockedByAnotherMarketplace.selector);
        ownership.lockForMarketplace(batteryId);

        vm.expectRevert(BatteryOwnershipRegistry.InvalidIdentifier.selector);
        ownership.transferRecordedOwnership(batteryId, bytes32(0));
        vm.prank(secondMarketplace);
        vm.expectRevert(BatteryOwnershipRegistry.NotAuthorizedMarketplace.selector);
        ownership.transferRecordedOwnership(batteryId, keccak256("other-owner"));
        vm.expectRevert(BatteryOwnershipRegistry.UnknownBattery.selector);
        ownership.transferRecordedOwnership(keccak256("unknown-transfer"), ownerId);
    }

    function test_stateTransitionSupplementaryBundlePromotesOnlyOnce() public {
        bytes32 bundleKey = keccak256("bundle-a");
        bundles.commitProtectedBundle(
            bundleKey,
            keccak256("domain-a"),
            organizationId,
            bytes32("evidence"),
            keccak256("domain-payload"),
            keccak256("content-envelope"),
            512,
            keccak256("replica-policy"),
            ProtectedBundleRegistry.CriticalityClass.Supplementary
        );

        _submitReceipt(bundleKey, keccak256("content-envelope"), 512, keccak256("receipt-a"));
        bundles.promoteToDecisionCritical(bundleKey);
        (,,,,,,,, ProtectedBundleRegistry.CriticalityClass criticalityClass, bool confirmed) =
            bundles.commitments(bundleKey);
        assertTrue(confirmed);
        assertEq(uint256(criticalityClass), uint256(ProtectedBundleRegistry.CriticalityClass.DecisionCritical));

        vm.expectRevert(ProtectedBundleRegistry.AlreadyDecisionCritical.selector);
        bundles.promoteToDecisionCritical(bundleKey);
    }

    function test_reentrancyStyleDuplicateOriginCannotOverwrite() public {
        bytes32 moduleType = bytes32("evidence");
        TestDomainModule module = new TestDomainModule(moduleType, 1);
        deployments.proposeModule(moduleType, address(module));
        vm.warp(block.timestamp + 1 days);
        deployments.activateModule(moduleType);
        bytes32 aggregateId = keccak256("aggregate-a");
        module.bindOrigin(address(deployments), aggregateId);

        vm.expectRevert(DeploymentRegistry.OriginAlreadyBound.selector);
        module.bindOrigin(address(deployments), aggregateId);
        assertEq(deployments.originModule(aggregateId), address(module));
    }

    function test_deploymentReviewAndInvalidModuleBranches() public {
        bytes32 moduleType = bytes32("assessment");
        vm.expectRevert(DeploymentRegistry.InvalidModule.selector);
        deployments.proposeModule(moduleType, address(0));

        TestDomainModule wrongType = new TestDomainModule(bytes32("evidence"), 1);
        vm.expectRevert(DeploymentRegistry.InvalidModule.selector);
        deployments.proposeModule(moduleType, address(wrongType));
        TestDomainModule zeroCompatibility = new TestDomainModule(moduleType, 0);
        vm.expectRevert(DeploymentRegistry.InvalidModule.selector);
        deployments.proposeModule(moduleType, address(zeroCompatibility));

        vm.expectRevert(DeploymentRegistry.InvalidModule.selector);
        deployments.activateModule(moduleType);
        TestDomainModule module = new TestDomainModule(moduleType, 1);
        deployments.proposeModule(moduleType, address(module));
        vm.expectRevert(DeploymentRegistry.ReviewDelayNotElapsed.selector);
        deployments.activateModule(moduleType);

        vm.expectRevert(DeploymentRegistry.InvalidModule.selector);
        deployments.bindAggregateOrigin(bytes32(0));
        vm.expectRevert(DeploymentRegistry.NotAggregateOrigin.selector);
        deployments.bindAggregateOrigin(keccak256("not-origin"));
    }

    function test_deploymentRejectsZeroSharedBoundary() public {
        vm.expectRevert(DeploymentRegistry.InvalidModule.selector);
        new DeploymentRegistry(address(this), address(0), address(bundles), address(ownership), 1 days);
    }

    function test_bundleInvalidInactiveDuplicateAndControllerBranches() public {
        vm.expectRevert(ProtectedBundleRegistry.InvalidCommitment.selector);
        new ProtectedBundleRegistry(address(0));

        bytes32 inactiveOrganization = keccak256("inactive-organization");
        vm.expectRevert(ProtectedBundleRegistry.InactiveControllerOrganization.selector);
        _commitBundle(keccak256("inactive-bundle"), keccak256("inactive-domain"), inactiveOrganization);

        bytes32 bundleKey = keccak256("duplicate-bundle");
        bytes32 domainKey = keccak256("duplicate-domain");
        _commitBundle(bundleKey, domainKey, organizationId);
        vm.expectRevert(ProtectedBundleRegistry.AlreadyBound.selector);
        _commitBundle(bundleKey, keccak256("other-domain"), organizationId);
        vm.expectRevert(ProtectedBundleRegistry.AlreadyBound.selector);
        _commitBundle(keccak256("other-bundle"), domainKey, organizationId);

        vm.expectRevert(ProtectedBundleRegistry.UnknownBundle.selector);
        bundles.promoteToDecisionCritical(keccak256("unknown-bundle"));
        vm.prank(outsider);
        vm.expectRevert(ProtectedBundleRegistry.NotController.selector);
        bundles.promoteToDecisionCritical(bundleKey);

        vm.expectRevert(ProtectedBundleRegistry.ReplicaReceiptRequired.selector);
        bundles.promoteToDecisionCritical(bundleKey);

        vm.expectRevert(ProtectedBundleRegistry.ReplicaReceiptRequired.selector);
        bundles.commitProtectedBundle(
            keccak256("forbidden-critical"),
            keccak256("forbidden-critical-domain"),
            organizationId,
            bytes32("evidence"),
            keccak256("domain-payload"),
            keccak256("content-envelope"),
            512,
            keccak256("replica-policy"),
            ProtectedBundleRegistry.CriticalityClass.DecisionCritical
        );

        vm.prank(replicaSigner);
        vm.expectRevert(ProtectedBundleRegistry.InvalidReplicaReceipt.selector);
        bundles.submitReplicaReceipt(
            bundleKey,
            keccak256("replica-repository"),
            replicaOrganizationId,
            replicaCredentialId,
            keccak256("wrong-envelope"),
            512,
            keccak256("receipt-invalid")
        );
        _submitReceipt(bundleKey, keccak256("content-envelope"), 512, keccak256("receipt-valid"));
        vm.prank(replicaSigner);
        vm.expectRevert(ProtectedBundleRegistry.ReceiptReplay.selector);
        bundles.submitReplicaReceipt(
            bundleKey,
            keccak256("replica-repository"),
            replicaOrganizationId,
            replicaCredentialId,
            keccak256("content-envelope"),
            512,
            keccak256("receipt-valid")
        );

        vm.expectRevert(ProtectedBundleRegistry.InvalidCommitment.selector);
        bundles.commitProtectedBundle(
            bytes32(0),
            keccak256("valid-domain"),
            organizationId,
            bytes32("evidence"),
            keccak256("domain-payload"),
            keccak256("content-envelope"),
            512,
            keccak256("replica-policy"),
            ProtectedBundleRegistry.CriticalityClass.Supplementary
        );

        vm.prank(outsider);
        vm.expectRevert(ProtectedBundleRegistry.BootstrapUnavailable.selector);
        bundles.closeBootstrap();
        bundles.closeBootstrap();
        vm.expectRevert(ProtectedBundleRegistry.BootstrapUnavailable.selector);
        _commitBundle(keccak256("closed-bootstrap"), keccak256("closed-domain"), organizationId);
    }

    function testFuzz_repositoryApprovalRoundTrip(bytes32 repositoryId, bool approved) public {
        vm.assume(repositoryId != bytes32(0));
        authority.setRepositoryApproval(repositoryId, approved);
        assertEq(authority.approvedRepositories(repositoryId), approved);
    }

    function _commitBundle(bytes32 bundleKey, bytes32 domainKey, bytes32 controllerOrganizationId) internal {
        bundles.commitProtectedBundle(
            bundleKey,
            domainKey,
            controllerOrganizationId,
            bytes32("evidence"),
            keccak256("domain-payload"),
            keccak256("content-envelope"),
            512,
            keccak256("replica-policy"),
            ProtectedBundleRegistry.CriticalityClass.Supplementary
        );
    }

    function _submitReceipt(bytes32 bundleKey, bytes32 envelopeDigest, uint64 length, bytes32 nonce) internal {
        vm.prank(replicaSigner);
        bundles.submitReplicaReceipt(
            bundleKey,
            keccak256("replica-repository"),
            replicaOrganizationId,
            replicaCredentialId,
            envelopeDigest,
            length,
            nonce
        );
    }
}

contract AuthorityRegistryHandler {
    AuthorityProfileRegistry internal immutable authority;
    bytes32 public lastRepositoryId;
    bool public lastApproved;

    constructor(AuthorityProfileRegistry registry) {
        authority = registry;
    }

    function setRepositoryApproval(bytes32 repositoryId, bool approved) external {
        if (repositoryId == bytes32(0)) return;
        lastRepositoryId = repositoryId;
        lastApproved = approved;
        authority.setRepositoryApproval(repositoryId, approved);
    }
}

contract AuthorityRegistryInvariantTest is StdInvariant, Test {
    AuthorityProfileRegistry internal authority;
    AuthorityRegistryHandler internal handler;

    function setUp() public {
        authority = new AuthorityProfileRegistry(address(this));
        handler = new AuthorityRegistryHandler(authority);
        authority.transferOwnership(address(handler));
        targetContract(address(handler));
    }

    function invariant_handlerExpectationMatchesRegistryState() public view {
        bytes32 repositoryId = handler.lastRepositoryId();
        if (repositoryId != bytes32(0)) {
            assertEq(authority.approvedRepositories(repositoryId), handler.lastApproved());
        }
    }

    function invariant_ownerRemainsTheHandler() public view {
        assertEq(authority.owner(), address(handler));
    }
}

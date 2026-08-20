// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {AuditAnchor} from "../../contracts/AuditAnchor.sol";
import {AuthorityProfileRegistry} from "../../contracts/AuthorityProfileRegistry.sol";

contract AuditAnchorTest is Test {
    AuthorityProfileRegistry internal authority;
    AuditAnchor internal anchor;
    address internal submitter = makeAddr("audit-anchor");
    bytes32 internal organizationId = keccak256("audit-org");
    bytes32 internal credentialId = keccak256("audit-credential");

    function setUp() public {
        authority = new AuthorityProfileRegistry(address(this));
        anchor = new AuditAnchor(address(authority));
        authority.setOrganizationStatus(organizationId, AuthorityProfileRegistry.OrganizationStatus.Active);
        authority.setCredential(credentialId, organizationId, submitter, true, false);
        authority.setCapabilityGrant(
            credentialId, bytes32("audit.anchor"), bytes32(0), 0, type(uint64).max, true
        );
    }

    function test_anchorsStrictlyInOrderAndRetainsBoundary() public {
        bytes32 first = keccak256("batch-1");
        bytes32 firstCommitment = keccak256("commitment-1");
        vm.prank(submitter);
        anchor.anchorBatch(first, 1, 1, 3, 3, keccak256("event-3"), firstCommitment, bytes32(0), organizationId, credentialId);
        assertEq(anchor.lastCommitment(), firstCommitment);
        assertEq(anchor.anchoredBatchCount(), 1);

        bytes32 second = keccak256("batch-2");
        vm.prank(submitter);
        anchor.anchorBatch(second, 1, 4, 5, 2, keccak256("event-5"), keccak256("commitment-2"), firstCommitment, organizationId, credentialId);
        assertEq(anchor.lastBatchId(), second);
        assertEq(anchor.anchoredBatchCount(), 2);
    }

    function test_rejectsUnauthorizedDuplicateGapAndWrongPredecessor() public {
        vm.expectRevert(AuditAnchor.Unauthorized.selector);
        anchor.anchorBatch(keccak256("batch"), 1, 1, 1, 1, keccak256("event"), keccak256("commitment"), bytes32(0), organizationId, credentialId);

        vm.prank(submitter);
        vm.expectRevert(AuditAnchor.InvalidBoundary.selector);
        anchor.anchorBatch(keccak256("gap"), 1, 1, 3, 2, keccak256("event"), keccak256("commitment"), bytes32(0), organizationId, credentialId);

        vm.prank(submitter);
        vm.expectRevert(AuditAnchor.InvalidPredecessor.selector);
        anchor.anchorBatch(keccak256("wrong"), 1, 1, 1, 1, keccak256("event"), keccak256("commitment"), keccak256("wrong-prior"), organizationId, credentialId);
    }
}

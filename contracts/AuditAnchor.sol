// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IAuthorityProfileRegistry} from "./interfaces/IAuthorityProfileRegistry.sol";

contract AuditAnchor {
    struct Anchor {
        uint64 version;
        uint64 firstSequence;
        uint64 lastSequence;
        uint64 eventCount;
        bytes32 finalEventHash;
        bytes32 commitment;
        bytes32 previousCommitment;
        address submitter;
    }

    bytes32 public constant ANCHOR_CAPABILITY = bytes32("audit.anchor");
    IAuthorityProfileRegistry public immutable authorityProfileRegistry;
    bytes32 public lastBatchId;
    bytes32 public lastCommitment;
    uint64 public anchoredBatchCount;
    mapping(bytes32 batchId => Anchor) public anchors;

    error AlreadyAnchored();
    error InvalidBoundary();
    error InvalidPredecessor();
    error Unauthorized();

    event AuditBatchAnchored(
        bytes32 indexed batchId,
        uint64 indexed version,
        bytes32 indexed commitment,
        bytes32 previousCommitment,
        uint64 firstSequence,
        uint64 lastSequence,
        uint64 eventCount
    );

    constructor(address authorityProfileRegistryAddress) {
        if (authorityProfileRegistryAddress == address(0)) revert InvalidBoundary();
        authorityProfileRegistry = IAuthorityProfileRegistry(authorityProfileRegistryAddress);
    }

    function moduleType() external pure returns (bytes32) {
        return bytes32("audit");
    }

    function compatibilityVersion() external pure returns (uint64) {
        return 1;
    }

    function anchorBatch(
        bytes32 batchId,
        uint64 version,
        uint64 firstSequence,
        uint64 lastSequence,
        uint64 eventCount,
        bytes32 finalEventHash,
        bytes32 commitment,
        bytes32 previousCommitment,
        bytes32 organizationId,
        bytes32 credentialId
    ) external {
        if (batchId == bytes32(0) || anchors[batchId].version != 0) revert AlreadyAnchored();
        if (
            version == 0 || firstSequence == 0 || lastSequence < firstSequence || eventCount == 0
                || eventCount != lastSequence - firstSequence + 1 || finalEventHash == bytes32(0)
                || commitment == bytes32(0)
        ) revert InvalidBoundary();
        if (previousCommitment != lastCommitment) revert InvalidPredecessor();
        if (
            !authorityProfileRegistry.isCredentialActive(credentialId, organizationId, msg.sender)
                || !authorityProfileRegistry.hasCapability(
                    credentialId, ANCHOR_CAPABILITY, batchId, uint64(block.timestamp)
                )
        ) revert Unauthorized();
        anchors[batchId] = Anchor(
            version,
            firstSequence,
            lastSequence,
            eventCount,
            finalEventHash,
            commitment,
            previousCommitment,
            msg.sender
        );
        lastBatchId = batchId;
        lastCommitment = commitment;
        anchoredBatchCount += 1;
        emit AuditBatchAnchored(
            batchId,
            version,
            commitment,
            previousCommitment,
            firstSequence,
            lastSequence,
            eventCount
        );
    }
}

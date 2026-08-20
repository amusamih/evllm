// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IAuthorityProfileRegistry} from "./interfaces/IAuthorityProfileRegistry.sol";
import {IDomainModule} from "./interfaces/IDomainModule.sol";
import {IProtectedBundleRegistry} from "./interfaces/IProtectedBundleRegistry.sol";

contract EvidenceRegistry is IDomainModule {
    enum EvidenceStatus { Unset, Active, Superseded, Revoked }
    enum AssertionType { Corroboration, Certification }
    enum AssertionStatus { Unset, Active, Withdrawn, Superseded }
    enum DisputeStatus { None, Open, Withdrawn, ClosedBySupersession, ClosedByAssertionWithdrawal, ReferredExternal }

    struct EvidenceVersion {
        bytes32 bundleKey;
        bytes32 domainKey;
        bytes32 payloadCommitment;
        bytes32 issuerOrganizationId;
        bytes32 issuerCredentialId;
        address issuer;
        EvidenceStatus status;
    }

    struct VerificationAssertion {
        bytes32 claimKey;
        uint64 claimVersion;
        bytes32 bundleKey;
        bytes32 verifierOrganizationId;
        bytes32 verifierCredentialId;
        address verifier;
        AssertionType assertionType;
        AssertionStatus status;
    }

    struct Dispute {
        bytes32 claimKey;
        uint64 claimVersion;
        bytes32 bundleKey;
        bytes32 openerOrganizationId;
        bytes32 openerCredentialId;
        address opener;
        DisputeStatus status;
    }

    bytes32 public constant EVIDENCE_BUNDLE_TYPE = keccak256("bundle-type:evidence");
    bytes32 public constant VERIFICATION_BUNDLE_TYPE = keccak256("bundle-type:verification");
    bytes32 public constant DISPUTE_BUNDLE_TYPE = keccak256("bundle-type:dispute");
    bytes32 public constant ISSUE_CAPABILITY = keccak256("evidence.issue");
    bytes32 public constant CORROBORATE_CAPABILITY = keccak256("verification.corroborate");
    bytes32 public constant CERTIFY_CAPABILITY = keccak256("verification.certify");
    bytes32 public constant DISPUTE_CAPABILITY = keccak256("dispute.open-evidence");

    IAuthorityProfileRegistry public immutable authorityProfileRegistry;
    IProtectedBundleRegistry public immutable protectedBundleRegistry;

    mapping(bytes32 claimKey => uint64) public currentVersion;
    mapping(bytes32 claimKey => mapping(uint64 version => EvidenceVersion)) public evidenceVersions;
    mapping(bytes32 assertionKey => VerificationAssertion) public assertions;
    mapping(bytes32 disputeKey => Dispute) public disputes;

    error AlreadyBound();
    error InvalidIdentifier();
    error InvalidPriorVersion();
    error InvalidState();
    error InvalidProtectedBundleLink();
    error Unauthorized();
    error SelfVerification();

    event EvidenceActivated(
        bytes32 indexed claimKey,
        uint64 indexed version,
        bytes32 indexed bundleKey,
        bytes32 issuerOrganizationId
    );
    event EvidenceSuperseded(bytes32 indexed claimKey, uint64 indexed priorVersion, uint64 indexed newVersion);
    event EvidenceRevoked(bytes32 indexed claimKey, uint64 indexed version);
    event VerificationAssertionCreated(
        bytes32 indexed assertionKey,
        bytes32 indexed claimKey,
        uint64 indexed claimVersion,
        AssertionType assertionType
    );
    event VerificationAssertionWithdrawn(bytes32 indexed assertionKey);
    event EvidenceDisputeOpened(bytes32 indexed disputeKey, bytes32 indexed claimKey, uint64 indexed claimVersion);
    event EvidenceDisputeStateChanged(bytes32 indexed disputeKey, DisputeStatus status);

    constructor(address authorityProfileRegistryAddress, address protectedBundleRegistryAddress) {
        if (authorityProfileRegistryAddress == address(0) || protectedBundleRegistryAddress == address(0)) {
            revert InvalidIdentifier();
        }
        authorityProfileRegistry = IAuthorityProfileRegistry(authorityProfileRegistryAddress);
        protectedBundleRegistry = IProtectedBundleRegistry(protectedBundleRegistryAddress);
    }

    function moduleType() external pure returns (bytes32) {
        return bytes32("evidence");
    }

    function compatibilityVersion() external pure returns (uint64) {
        return 1;
    }

    function activateEvidence(
        bytes32 claimKey,
        uint64 version,
        uint64 expectedPriorVersion,
        bytes32 bundleKey,
        bytes32 domainKey,
        bytes32 payloadCommitment,
        bytes32 issuerOrganizationId,
        bytes32 issuerCredentialId
    ) external {
        if (
            claimKey == bytes32(0) || version == 0 || bundleKey == bytes32(0) || domainKey == bytes32(0)
                || payloadCommitment == bytes32(0) || issuerOrganizationId == bytes32(0)
                || issuerCredentialId == bytes32(0)
        ) revert InvalidIdentifier();
        if (!authorityProfileRegistry.isCredentialActive(issuerCredentialId, issuerOrganizationId, msg.sender)) {
            revert Unauthorized();
        }
        if (
            !authorityProfileRegistry.hasCapability(
                issuerCredentialId, ISSUE_CAPABILITY, claimKey, uint64(block.timestamp)
            )
        ) revert Unauthorized();
        if (
            !protectedBundleRegistry.isConfirmedLink(
                bundleKey, domainKey, EVIDENCE_BUNDLE_TYPE, payloadCommitment, false
            )
        ) revert InvalidProtectedBundleLink();
        if (evidenceVersions[claimKey][version].status != EvidenceStatus.Unset) revert AlreadyBound();

        uint64 prior = currentVersion[claimKey];
        if (prior != expectedPriorVersion || version != prior + 1) revert InvalidPriorVersion();
        if (prior != 0) {
            EvidenceVersion storage priorRecord = evidenceVersions[claimKey][prior];
            if (priorRecord.status != EvidenceStatus.Active) revert InvalidState();
            priorRecord.status = EvidenceStatus.Superseded;
            emit EvidenceSuperseded(claimKey, prior, version);
        }

        evidenceVersions[claimKey][version] = EvidenceVersion({
            bundleKey: bundleKey,
            domainKey: domainKey,
            payloadCommitment: payloadCommitment,
            issuerOrganizationId: issuerOrganizationId,
            issuerCredentialId: issuerCredentialId,
            issuer: msg.sender,
            status: EvidenceStatus.Active
        });
        currentVersion[claimKey] = version;
        emit EvidenceActivated(claimKey, version, bundleKey, issuerOrganizationId);
    }

    function revokeEvidence(bytes32 claimKey, uint64 version) external {
        EvidenceVersion storage record = evidenceVersions[claimKey][version];
        if (record.status != EvidenceStatus.Active || currentVersion[claimKey] != version) revert InvalidState();
        if (record.issuer != msg.sender) revert Unauthorized();
        record.status = EvidenceStatus.Revoked;
        emit EvidenceRevoked(claimKey, version);
    }

    function createVerificationAssertion(
        bytes32 assertionKey,
        bytes32 claimKey,
        uint64 claimVersion,
        bytes32 bundleKey,
        bytes32 domainKey,
        bytes32 payloadCommitment,
        bytes32 verifierOrganizationId,
        bytes32 verifierCredentialId,
        AssertionType assertionType
    ) external {
        EvidenceVersion memory evidence = evidenceVersions[claimKey][claimVersion];
        if (assertionKey == bytes32(0) || evidence.status != EvidenceStatus.Active) revert InvalidState();
        if (assertions[assertionKey].status != AssertionStatus.Unset) revert AlreadyBound();
        if (evidence.issuerOrganizationId == verifierOrganizationId) revert SelfVerification();
        if (!authorityProfileRegistry.isCredentialActive(verifierCredentialId, verifierOrganizationId, msg.sender)) {
            revert Unauthorized();
        }
        bytes32 capability = assertionType == AssertionType.Corroboration
            ? CORROBORATE_CAPABILITY
            : CERTIFY_CAPABILITY;
        if (
            !authorityProfileRegistry.hasCapability(
                verifierCredentialId, capability, claimKey, uint64(block.timestamp)
            )
        ) revert Unauthorized();
        if (
            !protectedBundleRegistry.isConfirmedLink(
                bundleKey, domainKey, VERIFICATION_BUNDLE_TYPE, payloadCommitment, true
            )
        ) revert InvalidProtectedBundleLink();

        assertions[assertionKey] = VerificationAssertion({
            claimKey: claimKey,
            claimVersion: claimVersion,
            bundleKey: bundleKey,
            verifierOrganizationId: verifierOrganizationId,
            verifierCredentialId: verifierCredentialId,
            verifier: msg.sender,
            assertionType: assertionType,
            status: AssertionStatus.Active
        });
        emit VerificationAssertionCreated(assertionKey, claimKey, claimVersion, assertionType);
    }

    function withdrawVerificationAssertion(bytes32 assertionKey) external {
        VerificationAssertion storage assertion = assertions[assertionKey];
        if (assertion.status != AssertionStatus.Active) revert InvalidState();
        if (assertion.verifier != msg.sender) revert Unauthorized();
        assertion.status = AssertionStatus.Withdrawn;
        emit VerificationAssertionWithdrawn(assertionKey);
    }

    function openEvidenceDispute(
        bytes32 disputeKey,
        bytes32 claimKey,
        uint64 claimVersion,
        bytes32 bundleKey,
        bytes32 domainKey,
        bytes32 payloadCommitment,
        bytes32 openerOrganizationId,
        bytes32 openerCredentialId
    ) external {
        if (disputeKey == bytes32(0) || disputes[disputeKey].status != DisputeStatus.None) {
            revert AlreadyBound();
        }
        if (evidenceVersions[claimKey][claimVersion].status != EvidenceStatus.Active) revert InvalidState();
        if (!authorityProfileRegistry.isCredentialActive(openerCredentialId, openerOrganizationId, msg.sender)) {
            revert Unauthorized();
        }
        if (
            !authorityProfileRegistry.hasCapability(
                openerCredentialId, DISPUTE_CAPABILITY, claimKey, uint64(block.timestamp)
            )
        ) revert Unauthorized();
        if (
            !protectedBundleRegistry.isConfirmedLink(
                bundleKey, domainKey, DISPUTE_BUNDLE_TYPE, payloadCommitment, true
            )
        ) revert InvalidProtectedBundleLink();
        disputes[disputeKey] = Dispute(
            claimKey,
            claimVersion,
            bundleKey,
            openerOrganizationId,
            openerCredentialId,
            msg.sender,
            DisputeStatus.Open
        );
        emit EvidenceDisputeOpened(disputeKey, claimKey, claimVersion);
    }

    function changeEvidenceDisputeState(bytes32 disputeKey, DisputeStatus newStatus) external {
        Dispute storage dispute = disputes[disputeKey];
        if (dispute.status != DisputeStatus.Open) revert InvalidState();
        if (newStatus != DisputeStatus.Withdrawn && newStatus != DisputeStatus.ReferredExternal) {
            revert InvalidState();
        }
        if (dispute.opener != msg.sender) revert Unauthorized();
        dispute.status = newStatus;
        emit EvidenceDisputeStateChanged(disputeKey, newStatus);
    }

    function closeEvidenceDisputeForLifecycle(bytes32 disputeKey) external {
        Dispute storage dispute = disputes[disputeKey];
        if (dispute.status != DisputeStatus.Open) revert InvalidState();
        EvidenceVersion memory record = evidenceVersions[dispute.claimKey][dispute.claimVersion];
        if (record.issuer != msg.sender) revert Unauthorized();
        if (record.status == EvidenceStatus.Superseded) {
            dispute.status = DisputeStatus.ClosedBySupersession;
        } else if (record.status == EvidenceStatus.Revoked) {
            dispute.status = DisputeStatus.ReferredExternal;
        } else {
            revert InvalidState();
        }
        emit EvidenceDisputeStateChanged(disputeKey, dispute.status);
    }
}

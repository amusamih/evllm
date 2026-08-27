// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IAuthorityProfileRegistry} from "./interfaces/IAuthorityProfileRegistry.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract ProtectedBundleRegistry is EIP712 {
    enum CriticalityClass { Supplementary, DecisionCritical }

    struct Commitment {
        bytes32 domainKey;
        bytes32 controllerOrganizationId;
        address controller;
        bytes32 bundleType;
        bytes32 domainPayloadCommitment;
        bytes32 contentEnvelopeDigest;
        uint64 storedEnvelopeLength;
        bytes32 replicaPolicyDigest;
        CriticalityClass criticalityClass;
        bool confirmed;
    }

    struct DomainAttestation {
        bytes32 bundleId;
        uint64 bundleVersion;
        bytes32 bundleType;
        bytes32 domainResourceId;
        uint64 domainResourceVersion;
        bytes32 authorBindingProfileId;
        uint64 authorBindingProfileVersion;
        bytes32 domainPayloadCommitment;
        bytes32 signerActorId;
        bytes32 signerOrgId;
        bytes32 signerCredentialId;
        uint256 nonce;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    bytes32 public constant DOMAIN_ATTESTATION_TYPEHASH = keccak256(
        "DomainManifestAttestation(bytes32 bundleId,uint64 bundleVersion,bytes32 bundleType,bytes32 domainResourceId,uint64 domainResourceVersion,bytes32 authorBindingProfileId,uint64 authorBindingProfileVersion,bytes32 domainPayloadCommitment,bytes32 signerActorId,bytes32 signerOrgId,bytes32 signerCredentialId,uint256 nonce,uint64 issuedAt,uint64 expiresAt)"
    );

    IAuthorityProfileRegistry public immutable authorityProfileRegistry;
    address public immutable bootstrapGovernance;
    bool public bootstrapClosed;
    mapping(bytes32 bundleKey => Commitment) public commitments;
    mapping(bytes32 domainKey => bytes32 bundleKey) public bundleForDomain;
    mapping(bytes32 receiptScope => bool) public consumedReceiptNonces;
    mapping(bytes32 bundleKey => bool) public verifiedReplicaReceipt;
    mapping(bytes32 attestationNonceScope => bool) public consumedAttestationNonces;

    error AlreadyBound();
    error InactiveControllerOrganization();
    error InvalidCommitment();
    error NotController();
    error UnknownBundle();
    error AlreadyDecisionCritical();
    error ReplicaReceiptRequired();
    error InvalidReplicaReceipt();
    error ReceiptReplay();
    error InvalidAttestation();
    error AttestationReplay();
    error BootstrapUnavailable();

    event ProtectedBundleCommitted(
        bytes32 indexed bundleKey,
        bytes32 indexed domainKey,
        bytes32 indexed bundleType,
        address controller,
        CriticalityClass criticalityClass
    );
    event ProtectedBundlePromoted(bytes32 indexed bundleKey);
    event ReplicaReceiptVerified(
        bytes32 indexed bundleKey,
        bytes32 indexed replicaRepositoryId,
        bytes32 indexed replicaCustodianOrganizationId,
        bytes32 signerCredentialId,
        bytes32 nonce
    );
    event DomainAttestationConsumed(
        bytes32 indexed bundleKey,
        bytes32 indexed signerCredentialId,
        uint256 indexed nonce,
        bytes32 typedDataDigest
    );

    constructor(address authorityProfileRegistryAddress) EIP712("EVLLM Domain Manifest", "1") {
        if (authorityProfileRegistryAddress == address(0)) revert InvalidCommitment();
        authorityProfileRegistry = IAuthorityProfileRegistry(authorityProfileRegistryAddress);
        bootstrapGovernance = msg.sender;
    }

    function closeBootstrap() external {
        if (msg.sender != bootstrapGovernance || bootstrapClosed) revert BootstrapUnavailable();
        bootstrapClosed = true;
    }

    function commitProtectedBundle(
        bytes32 bundleKey,
        bytes32 domainKey,
        bytes32 controllerOrganizationId,
        bytes32 bundleType,
        bytes32 domainPayloadCommitment,
        bytes32 contentEnvelopeDigest,
        uint64 storedEnvelopeLength,
        bytes32 replicaPolicyDigest,
        CriticalityClass initialCriticalityClass
    ) external {
        if (msg.sender != bootstrapGovernance || bootstrapClosed) revert BootstrapUnavailable();
        _commitProtectedBundle(
            bundleKey,
            domainKey,
            controllerOrganizationId,
            bundleType,
            domainPayloadCommitment,
            contentEnvelopeDigest,
            storedEnvelopeLength,
            replicaPolicyDigest,
            initialCriticalityClass
        );
    }

    function commitAttestedProtectedBundle(
        DomainAttestation calldata attestation,
        bytes calldata signature,
        bytes32 controllerOrganizationId,
        bytes32 controllerCredentialId,
        bytes32 contentEnvelopeDigest,
        uint64 storedEnvelopeLength,
        bytes32 replicaPolicyDigest
    ) external {
        if (
            attestation.bundleVersion == 0 || attestation.domainResourceVersion == 0
                || attestation.issuedAt >= attestation.expiresAt || block.timestamp < attestation.issuedAt
                || block.timestamp > attestation.expiresAt
        ) revert InvalidAttestation();
        bytes32 typedDataDigest = _hashTypedDataV4(_attestationStructHash(attestation));
        address signer = ECDSA.recover(typedDataDigest, signature);
        if (
            !authorityProfileRegistry.isCredentialActive(
                attestation.signerCredentialId, attestation.signerOrgId, signer
            )
        ) revert InvalidAttestation();
        if (
            !authorityProfileRegistry.isCredentialActive(
                controllerCredentialId, controllerOrganizationId, msg.sender
            )
        ) revert InvalidAttestation();
        bytes32 nonceScope = keccak256(abi.encode(attestation.signerCredentialId, attestation.nonce));
        if (consumedAttestationNonces[nonceScope]) revert AttestationReplay();
        consumedAttestationNonces[nonceScope] = true;
        _commitProtectedBundle(
            attestation.bundleId,
            attestation.domainResourceId,
            controllerOrganizationId,
            attestation.bundleType,
            attestation.domainPayloadCommitment,
            contentEnvelopeDigest,
            storedEnvelopeLength,
            replicaPolicyDigest,
            CriticalityClass.Supplementary
        );
        emit DomainAttestationConsumed(
            attestation.bundleId,
            attestation.signerCredentialId,
            attestation.nonce,
            typedDataDigest
        );
    }

    function _attestationStructHash(DomainAttestation calldata attestation)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(DOMAIN_ATTESTATION_TYPEHASH, attestation));
    }

    function _commitProtectedBundle(
        bytes32 bundleKey,
        bytes32 domainKey,
        bytes32 controllerOrganizationId,
        bytes32 bundleType,
        bytes32 domainPayloadCommitment,
        bytes32 contentEnvelopeDigest,
        uint64 storedEnvelopeLength,
        bytes32 replicaPolicyDigest,
        CriticalityClass initialCriticalityClass
    ) private {
        if (
            bundleKey == bytes32(0) || domainKey == bytes32(0) || controllerOrganizationId == bytes32(0)
                || bundleType == bytes32(0) || domainPayloadCommitment == bytes32(0)
                || contentEnvelopeDigest == bytes32(0) || storedEnvelopeLength == 0
                || replicaPolicyDigest == bytes32(0)
        ) revert InvalidCommitment();
        if (!authorityProfileRegistry.isOrganizationActive(controllerOrganizationId)) {
            revert InactiveControllerOrganization();
        }
        if (initialCriticalityClass == CriticalityClass.DecisionCritical) revert ReplicaReceiptRequired();
        if (commitments[bundleKey].confirmed || bundleForDomain[domainKey] != bytes32(0)) revert AlreadyBound();

        commitments[bundleKey] = Commitment({
            domainKey: domainKey,
            controllerOrganizationId: controllerOrganizationId,
            controller: msg.sender,
            bundleType: bundleType,
            domainPayloadCommitment: domainPayloadCommitment,
            contentEnvelopeDigest: contentEnvelopeDigest,
            storedEnvelopeLength: storedEnvelopeLength,
            replicaPolicyDigest: replicaPolicyDigest,
            criticalityClass: initialCriticalityClass,
            confirmed: true
        });
        bundleForDomain[domainKey] = bundleKey;
        emit ProtectedBundleCommitted(bundleKey, domainKey, bundleType, msg.sender, initialCriticalityClass);
    }

    function promoteToDecisionCritical(bytes32 bundleKey) external {
        Commitment storage commitment = commitments[bundleKey];
        if (!commitment.confirmed) revert UnknownBundle();
        if (commitment.controller != msg.sender) revert NotController();
        if (commitment.criticalityClass == CriticalityClass.DecisionCritical) revert AlreadyDecisionCritical();
        if (!verifiedReplicaReceipt[bundleKey]) revert ReplicaReceiptRequired();
        commitment.criticalityClass = CriticalityClass.DecisionCritical;
        emit ProtectedBundlePromoted(bundleKey);
    }

    function submitReplicaReceipt(
        bytes32 bundleKey,
        bytes32 replicaRepositoryId,
        bytes32 replicaCustodianOrganizationId,
        bytes32 signerCredentialId,
        bytes32 observedContentEnvelopeDigest,
        uint64 observedStoredEnvelopeLength,
        bytes32 nonce
    ) external {
        Commitment memory commitment = commitments[bundleKey];
        if (!commitment.confirmed) revert UnknownBundle();
        if (replicaRepositoryId == bytes32(0) || nonce == bytes32(0)) revert InvalidReplicaReceipt();
        if (
            observedContentEnvelopeDigest != commitment.contentEnvelopeDigest
                || observedStoredEnvelopeLength != commitment.storedEnvelopeLength
                || !authorityProfileRegistry.isReplicaAttestationCredential(
                    signerCredentialId, replicaCustodianOrganizationId, msg.sender
                )
        ) revert InvalidReplicaReceipt();
        bytes32 scope = keccak256(abi.encode(signerCredentialId, nonce));
        if (consumedReceiptNonces[scope]) revert ReceiptReplay();
        consumedReceiptNonces[scope] = true;
        verifiedReplicaReceipt[bundleKey] = true;
        emit ReplicaReceiptVerified(
            bundleKey,
            replicaRepositoryId,
            replicaCustodianOrganizationId,
            signerCredentialId,
            nonce
        );
    }

    function isConfirmedLink(
        bytes32 bundleKey,
        bytes32 domainKey,
        bytes32 bundleType,
        bytes32 domainPayloadCommitment,
        bool requireDecisionCritical
    ) external view returns (bool) {
        Commitment memory commitment = commitments[bundleKey];
        return commitment.confirmed && commitment.domainKey == domainKey
            && commitment.bundleType == bundleType
            && commitment.domainPayloadCommitment == domainPayloadCommitment
            && (!requireDecisionCritical || commitment.criticalityClass == CriticalityClass.DecisionCritical);
    }

    function controllerOf(bytes32 bundleKey) external view returns (address) {
        return commitments[bundleKey].controller;
    }
}

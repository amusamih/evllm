// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAuthorityProfileRegistry} from "./interfaces/IAuthorityProfileRegistry.sol";

contract AuthorityProfileRegistry is Ownable, IAuthorityProfileRegistry {
    enum OrganizationStatus { Unregistered, Active, Suspended, Revoked }

    struct Profile {
        bytes32 digest;
        bool active;
    }

    struct Credential {
        bytes32 organizationId;
        address account;
        bool active;
        bool replicaAttestation;
    }

    struct CapabilityGrant {
        bytes32 resourceScope;
        uint64 effectiveAt;
        uint64 expiresAt;
        bool active;
    }

    mapping(bytes32 organizationId => OrganizationStatus) public organizationStatus;
    mapping(bytes32 profileId => mapping(uint64 version => Profile)) public profiles;
    mapping(bytes32 repositoryId => bool) public approvedRepositories;
    mapping(bytes32 credentialId => Credential) public credentials;
    mapping(bytes32 credentialId => mapping(bytes32 capabilityId => CapabilityGrant)) public capabilityGrants;

    error InvalidIdentifier();
    error InvalidVersion();
    error TerminalOrganization();
    error AlreadyBound();
    error InvalidTimeRange();

    event OrganizationStatusChanged(bytes32 indexed organizationId, OrganizationStatus status);
    event ProfileSet(bytes32 indexed profileId, uint64 indexed version, bytes32 digest, bool active);
    event RepositoryApprovalChanged(bytes32 indexed repositoryId, bool approved);
    event CredentialSet(
        bytes32 indexed credentialId,
        bytes32 indexed organizationId,
        address indexed account,
        bool active,
        bool replicaAttestation
    );
    event CapabilityGrantSet(
        bytes32 indexed credentialId,
        bytes32 indexed capabilityId,
        bytes32 indexed resourceScope,
        uint64 effectiveAt,
        uint64 expiresAt,
        bool active
    );

    constructor(address governance) Ownable(governance) {}

    function setOrganizationStatus(bytes32 organizationId, OrganizationStatus status) external onlyOwner {
        if (organizationId == bytes32(0) || status == OrganizationStatus.Unregistered) revert InvalidIdentifier();
        if (organizationStatus[organizationId] == OrganizationStatus.Revoked) revert TerminalOrganization();
        organizationStatus[organizationId] = status;
        emit OrganizationStatusChanged(organizationId, status);
    }

    function setProfile(bytes32 profileId, uint64 version, bytes32 digest, bool active) external onlyOwner {
        if (profileId == bytes32(0) || digest == bytes32(0)) revert InvalidIdentifier();
        if (version == 0) revert InvalidVersion();
        Profile storage existing = profiles[profileId][version];
        if (existing.digest != bytes32(0) && existing.digest != digest) revert AlreadyBound();
        profiles[profileId][version] = Profile({digest: digest, active: active});
        emit ProfileSet(profileId, version, digest, active);
    }

    function setRepositoryApproval(bytes32 repositoryId, bool approved) external onlyOwner {
        if (repositoryId == bytes32(0)) revert InvalidIdentifier();
        approvedRepositories[repositoryId] = approved;
        emit RepositoryApprovalChanged(repositoryId, approved);
    }

    function isOrganizationActive(bytes32 organizationId) external view returns (bool) {
        return organizationStatus[organizationId] == OrganizationStatus.Active;
    }

    function isProfileActive(bytes32 profileId, uint64 version, bytes32 digest) external view returns (bool) {
        Profile memory profile = profiles[profileId][version];
        return profile.active && profile.digest == digest;
    }

    function setCredential(
        bytes32 credentialId,
        bytes32 organizationId,
        address account,
        bool active,
        bool replicaAttestation
    ) external onlyOwner {
        if (credentialId == bytes32(0) || organizationId == bytes32(0) || account == address(0)) {
            revert InvalidIdentifier();
        }
        Credential storage existing = credentials[credentialId];
        if (
            existing.account != address(0)
                && (existing.organizationId != organizationId || existing.account != account)
        ) revert AlreadyBound();
        credentials[credentialId] = Credential(organizationId, account, active, replicaAttestation);
        emit CredentialSet(credentialId, organizationId, account, active, replicaAttestation);
    }

    function setCapabilityGrant(
        bytes32 credentialId,
        bytes32 capabilityId,
        bytes32 resourceScope,
        uint64 effectiveAt,
        uint64 expiresAt,
        bool active
    ) external onlyOwner {
        if (credentialId == bytes32(0) || capabilityId == bytes32(0)) revert InvalidIdentifier();
        if (credentials[credentialId].account == address(0)) revert InvalidIdentifier();
        if (expiresAt != 0 && expiresAt <= effectiveAt) revert InvalidTimeRange();
        capabilityGrants[credentialId][capabilityId] =
            CapabilityGrant(resourceScope, effectiveAt, expiresAt, active);
        emit CapabilityGrantSet(credentialId, capabilityId, resourceScope, effectiveAt, expiresAt, active);
    }

    function isCredentialActive(bytes32 credentialId, bytes32 organizationId, address account)
        public
        view
        returns (bool)
    {
        Credential memory credential = credentials[credentialId];
        return credential.active && credential.organizationId == organizationId && credential.account == account
            && organizationStatus[organizationId] == OrganizationStatus.Active;
    }

    function hasCapability(
        bytes32 credentialId,
        bytes32 capabilityId,
        bytes32 resourceScope,
        uint64 atTime
    ) external view returns (bool) {
        CapabilityGrant memory grant = capabilityGrants[credentialId][capabilityId];
        bool scopeMatches = grant.resourceScope == bytes32(0) || grant.resourceScope == resourceScope;
        bool timeMatches = atTime >= grant.effectiveAt && (grant.expiresAt == 0 || atTime < grant.expiresAt);
        return grant.active && scopeMatches && timeMatches;
    }

    function isReplicaAttestationCredential(bytes32 credentialId, bytes32 organizationId, address account)
        external
        view
        returns (bool)
    {
        return credentials[credentialId].replicaAttestation
            && isCredentialActive(credentialId, organizationId, account);
    }
}

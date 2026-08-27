// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IAuthorityProfileRegistry {
    function isOrganizationActive(bytes32 organizationId) external view returns (bool);
    function isProfileActive(bytes32 profileId, uint64 version, bytes32 digest) external view returns (bool);
    function isCredentialActive(bytes32 credentialId, bytes32 organizationId, address account)
        external
        view
        returns (bool);
    function hasCapability(
        bytes32 credentialId,
        bytes32 capabilityId,
        bytes32 resourceScope,
        uint64 atTime
    ) external view returns (bool);
    function isReplicaAttestationCredential(bytes32 credentialId, bytes32 organizationId, address account)
        external
        view
        returns (bool);
}

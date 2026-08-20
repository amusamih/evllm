// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IProtectedBundleRegistry {
    function isConfirmedLink(
        bytes32 bundleKey,
        bytes32 domainKey,
        bytes32 bundleType,
        bytes32 domainPayloadCommitment,
        bool requireDecisionCritical
    ) external view returns (bool);

    function controllerOf(bytes32 bundleKey) external view returns (address);
}

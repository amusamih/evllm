// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

interface IBatteryOwnershipRegistry {
    function batteries(bytes32 batteryId)
        external
        view
        returns (bytes32 recordedOwnerOrganizationId, address marketplaceLock, bool registered);

    function lockForMarketplace(bytes32 batteryId) external;
    function unlockForMarketplace(bytes32 batteryId) external;
    function transferRecordedOwnership(bytes32 batteryId, bytes32 newOwnerOrganizationId) external;
}

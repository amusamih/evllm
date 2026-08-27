// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract BatteryOwnershipRegistry is Ownable {
    enum SubjectGranularity { Pack, Module, Cell }
    enum ProposalStatus { Unset, Pending, Accepted, Rejected, Expired }

    struct BatterySubject {
        bytes32 parentId;
        bytes32 rootBatteryId;
        SubjectGranularity granularity;
        bool registered;
    }

    struct Battery {
        bytes32 recordedOwnerOrganizationId;
        address marketplaceLock;
        bool registered;
    }

    struct InitialOwnershipProposal {
        bytes32 batteryId;
        bytes32 ownerOrganizationId;
        address ownerAccount;
        uint64 expiresAt;
        ProposalStatus status;
    }

    struct OwnershipTransition {
        bytes32 previousOwnerOrganizationId;
        bytes32 newOwnerOrganizationId;
        address authorizedMarketplace;
        uint64 recordedAt;
    }

    mapping(address registrar => bool) public registrars;
    mapping(address marketplace => bool) public marketplaces;
    mapping(bytes32 batteryId => Battery) public batteries;
    mapping(bytes32 subjectId => BatterySubject) public subjects;
    mapping(bytes32 proposalId => InitialOwnershipProposal) public initialOwnershipProposals;
    mapping(bytes32 batteryId => uint64) public ownershipTransitionCount;
    mapping(bytes32 batteryId => mapping(uint64 sequence => OwnershipTransition)) public ownershipTransitions;

    error AlreadyRegistered();
    error InvalidIdentifier();
    error LockedByAnotherMarketplace();
    error NotAuthorizedMarketplace();
    error NotRegistrar();
    error UnknownBattery();
    error InvalidHierarchy();
    error InvalidProposalState();
    error ProposalExpired();

    event BatteryRegistered(bytes32 indexed batteryId, bytes32 indexed ownerOrganizationId);
    event MarketplaceLockChanged(bytes32 indexed batteryId, address indexed marketplace);
    event RecordedOwnershipTransferred(
        bytes32 indexed batteryId,
        bytes32 indexed previousOwnerOrganizationId,
        bytes32 indexed newOwnerOrganizationId
    );
    event BatteryComponentRegistered(
        bytes32 indexed subjectId,
        bytes32 indexed parentId,
        bytes32 indexed rootBatteryId,
        SubjectGranularity granularity
    );
    event InitialOwnershipProposed(
        bytes32 indexed proposalId,
        bytes32 indexed batteryId,
        bytes32 indexed ownerOrganizationId,
        address ownerAccount,
        uint64 expiresAt
    );
    event InitialOwnershipProposalClosed(bytes32 indexed proposalId, ProposalStatus status);

    constructor(address governance) Ownable(governance) {}

    function setRegistrar(address registrar, bool allowed) external onlyOwner {
        registrars[registrar] = allowed;
    }

    function setMarketplace(address marketplace, bool allowed) external onlyOwner {
        marketplaces[marketplace] = allowed;
    }

    function registerBattery(bytes32 batteryId, bytes32 initialOwnerOrganizationId) external {
        if (!registrars[msg.sender]) revert NotRegistrar();
        if (batteryId == bytes32(0) || initialOwnerOrganizationId == bytes32(0)) revert InvalidIdentifier();
        if (batteries[batteryId].registered) revert AlreadyRegistered();
        batteries[batteryId] = Battery(initialOwnerOrganizationId, address(0), true);
        subjects[batteryId] = BatterySubject(bytes32(0), batteryId, SubjectGranularity.Pack, true);
        _recordOwnershipTransition(batteryId, bytes32(0), initialOwnerOrganizationId, address(0));
        emit BatteryRegistered(batteryId, initialOwnerOrganizationId);
    }

    function proposeInitialOwnership(
        bytes32 proposalId,
        bytes32 batteryId,
        bytes32 ownerOrganizationId,
        address ownerAccount,
        uint64 expiresAt
    ) external {
        if (!registrars[msg.sender]) revert NotRegistrar();
        if (
            proposalId == bytes32(0) || batteryId == bytes32(0) || ownerOrganizationId == bytes32(0)
                || ownerAccount == address(0)
        ) revert InvalidIdentifier();
        if (batteries[batteryId].registered || initialOwnershipProposals[proposalId].status != ProposalStatus.Unset) {
            revert AlreadyRegistered();
        }
        if (expiresAt <= block.timestamp) revert ProposalExpired();
        initialOwnershipProposals[proposalId] = InitialOwnershipProposal(
            batteryId, ownerOrganizationId, ownerAccount, expiresAt, ProposalStatus.Pending
        );
        emit InitialOwnershipProposed(proposalId, batteryId, ownerOrganizationId, ownerAccount, expiresAt);
    }

    function acceptInitialOwnership(bytes32 proposalId) external {
        InitialOwnershipProposal storage proposal = initialOwnershipProposals[proposalId];
        if (proposal.status != ProposalStatus.Pending || proposal.ownerAccount != msg.sender) {
            revert InvalidProposalState();
        }
        if (block.timestamp >= proposal.expiresAt) revert ProposalExpired();
        if (batteries[proposal.batteryId].registered) revert AlreadyRegistered();
        proposal.status = ProposalStatus.Accepted;
        batteries[proposal.batteryId] = Battery(proposal.ownerOrganizationId, address(0), true);
        subjects[proposal.batteryId] =
            BatterySubject(bytes32(0), proposal.batteryId, SubjectGranularity.Pack, true);
        _recordOwnershipTransition(proposal.batteryId, bytes32(0), proposal.ownerOrganizationId, address(0));
        emit InitialOwnershipProposalClosed(proposalId, ProposalStatus.Accepted);
        emit BatteryRegistered(proposal.batteryId, proposal.ownerOrganizationId);
    }

    function rejectInitialOwnership(bytes32 proposalId) external {
        InitialOwnershipProposal storage proposal = initialOwnershipProposals[proposalId];
        if (proposal.status != ProposalStatus.Pending || proposal.ownerAccount != msg.sender) {
            revert InvalidProposalState();
        }
        proposal.status = ProposalStatus.Rejected;
        emit InitialOwnershipProposalClosed(proposalId, ProposalStatus.Rejected);
    }

    function expireInitialOwnership(bytes32 proposalId) external {
        InitialOwnershipProposal storage proposal = initialOwnershipProposals[proposalId];
        if (proposal.status != ProposalStatus.Pending) revert InvalidProposalState();
        if (block.timestamp < proposal.expiresAt) revert InvalidProposalState();
        proposal.status = ProposalStatus.Expired;
        emit InitialOwnershipProposalClosed(proposalId, ProposalStatus.Expired);
    }

    function registerComponent(bytes32 subjectId, bytes32 parentId, SubjectGranularity granularity) external {
        if (!registrars[msg.sender]) revert NotRegistrar();
        if (subjectId == bytes32(0) || parentId == bytes32(0)) revert InvalidIdentifier();
        if (subjects[subjectId].registered) revert AlreadyRegistered();
        BatterySubject memory parent = subjects[parentId];
        if (!parent.registered || uint8(granularity) != uint8(parent.granularity) + 1) {
            revert InvalidHierarchy();
        }
        subjects[subjectId] = BatterySubject(parentId, parent.rootBatteryId, granularity, true);
        emit BatteryComponentRegistered(subjectId, parentId, parent.rootBatteryId, granularity);
    }

    function lockForMarketplace(bytes32 batteryId) external {
        if (!marketplaces[msg.sender]) revert NotAuthorizedMarketplace();
        Battery storage battery = batteries[batteryId];
        if (!battery.registered) revert UnknownBattery();
        if (battery.marketplaceLock != address(0) && battery.marketplaceLock != msg.sender) {
            revert LockedByAnotherMarketplace();
        }
        battery.marketplaceLock = msg.sender;
        emit MarketplaceLockChanged(batteryId, msg.sender);
    }

    function transferRecordedOwnership(bytes32 batteryId, bytes32 newOwnerOrganizationId) external {
        Battery storage battery = batteries[batteryId];
        if (!battery.registered) revert UnknownBattery();
        if (!marketplaces[msg.sender] || battery.marketplaceLock != msg.sender) {
            revert NotAuthorizedMarketplace();
        }
        if (newOwnerOrganizationId == bytes32(0)) revert InvalidIdentifier();
        bytes32 previousOwner = battery.recordedOwnerOrganizationId;
        battery.recordedOwnerOrganizationId = newOwnerOrganizationId;
        battery.marketplaceLock = address(0);
        _recordOwnershipTransition(batteryId, previousOwner, newOwnerOrganizationId, msg.sender);
        emit RecordedOwnershipTransferred(batteryId, previousOwner, newOwnerOrganizationId);
        emit MarketplaceLockChanged(batteryId, address(0));
    }

    function unlockForMarketplace(bytes32 batteryId) external {
        Battery storage battery = batteries[batteryId];
        if (!battery.registered) revert UnknownBattery();
        if (!marketplaces[msg.sender] || battery.marketplaceLock != msg.sender) {
            revert NotAuthorizedMarketplace();
        }
        battery.marketplaceLock = address(0);
        emit MarketplaceLockChanged(batteryId, address(0));
    }

    function _recordOwnershipTransition(
        bytes32 batteryId,
        bytes32 previousOwner,
        bytes32 newOwner,
        address marketplace
    ) private {
        uint64 sequence = ownershipTransitionCount[batteryId] + 1;
        ownershipTransitionCount[batteryId] = sequence;
        ownershipTransitions[batteryId][sequence] =
            OwnershipTransition(previousOwner, newOwner, marketplace, uint64(block.timestamp));
    }
}

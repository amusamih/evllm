// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAuthorityProfileRegistry} from "./interfaces/IAuthorityProfileRegistry.sol";
import {IBatteryOwnershipRegistry} from "./interfaces/IBatteryOwnershipRegistry.sol";
import {IDeploymentRegistry} from "./interfaces/IDeploymentRegistry.sol";
import {IDomainModule} from "./interfaces/IDomainModule.sol";
import {IProtectedBundleRegistry} from "./interfaces/IProtectedBundleRegistry.sol";

contract Marketplace is IDomainModule, ReentrancyGuard {
    enum ListingState { Unset, Active, Matched, Withdrawn, Expired, ClosedSettled, ClosedCancelled }
    enum OfferState { Unset, Submitted, Accepted, Rejected, Withdrawn, Expired }
    enum AgreementState {
        Unset,
        AwaitingBuyerConfirmation,
        AwaitingFunding,
        Funded,
        InDelivery,
        Delivered,
        Accepted,
        Disputed,
        TimedOutReferred,
        Settled,
        Cancelled
    }
    enum Resolution { ReleaseAndTransfer, RefundAndCancel }

    struct ListingInput {
        bytes32 listingId;
        bytes32 batteryId;
        bytes32 sellerOrganizationId;
        bytes32 sellerCredentialId;
        bytes32 bundleKey;
        bytes32 payloadCommitment;
        uint256 testPrice;
        address payable sellerPayoutAddress;
        uint64 expiresAt;
    }

    struct Listing {
        bytes32 batteryId;
        bytes32 sellerOrganizationId;
        bytes32 sellerCredentialId;
        bytes32 bundleKey;
        bytes32 payloadCommitment;
        bytes32 acceptedOfferId;
        address seller;
        address payable sellerPayoutAddress;
        uint256 testPrice;
        uint64 expiresAt;
        ListingState state;
    }

    struct OfferInput {
        bytes32 offerId;
        bytes32 listingId;
        bytes32 buyerOrganizationId;
        bytes32 buyerCredentialId;
        uint256 amount;
        address payable buyerRefundAddress;
        bytes32 termsCommitment;
        uint64 expiresAt;
    }

    struct Offer {
        bytes32 listingId;
        bytes32 buyerOrganizationId;
        bytes32 buyerCredentialId;
        bytes32 termsCommitment;
        address buyer;
        address payable buyerRefundAddress;
        uint256 amount;
        uint64 expiresAt;
        OfferState state;
    }

    struct AgreementInput {
        bytes32 agreementId;
        bytes32 listingId;
        bytes32 offerId;
        bytes32 bundleKey;
        bytes32 payloadCommitment;
        bytes32 buyerAccessAuthorizationDigest;
        uint64 confirmationDeadline;
        uint64 deliveryDeadline;
    }

    struct Agreement {
        bytes32 listingId;
        bytes32 offerId;
        bytes32 batteryId;
        bytes32 sellerOrganizationId;
        bytes32 buyerOrganizationId;
        bytes32 bundleKey;
        bytes32 payloadCommitment;
        bytes32 buyerAccessAuthorizationDigest;
        bytes32 disputeId;
        address seller;
        address buyer;
        address payable sellerPayoutAddress;
        address payable buyerRefundAddress;
        uint256 amount;
        uint64 confirmationDeadline;
        uint64 deliveryDeadline;
        AgreementState state;
    }

    struct ProtectedAction {
        bytes32 actionId;
        bytes32 bundleKey;
        bytes32 payloadCommitment;
        bytes32 organizationId;
        bytes32 credentialId;
    }

    bytes32 public constant MARKETPLACE_TYPE = bytes32("marketplace");
    bytes32 public constant LISTING_BUNDLE_TYPE = keccak256("bundle-type:listing");
    bytes32 public constant AGREEMENT_BUNDLE_TYPE = keccak256("bundle-type:agreement");
    bytes32 public constant LOGISTICS_BUNDLE_TYPE = keccak256("bundle-type:logistics");
    bytes32 public constant DISPUTE_BUNDLE_TYPE = keccak256("bundle-type:dispute");
    bytes32 public constant LISTING_CAPABILITY = keccak256("marketplace.listing.create");
    bytes32 public constant OFFER_CAPABILITY = keccak256("marketplace.offer.submit");
    bytes32 public constant LOGISTICS_CAPABILITY = keccak256("logistics.record");
    bytes32 public constant DISPUTE_CAPABILITY = keccak256("dispute.open-transaction");
    bytes32 public constant RESOLVE_CAPABILITY = keccak256("dispute.resolve-transaction");

    IAuthorityProfileRegistry public immutable authorityProfileRegistry;
    IProtectedBundleRegistry public immutable protectedBundleRegistry;
    IBatteryOwnershipRegistry public immutable batteryOwnershipRegistry;
    IDeploymentRegistry public immutable deploymentRegistry;
    uint64 public immutable acceptanceWindow;

    mapping(bytes32 listingId => Listing) public listings;
    mapping(bytes32 offerId => Offer) public offers;
    mapping(bytes32 agreementId => Agreement) private _agreements;
    mapping(bytes32 actionId => bool) public protectedActions;
    mapping(address recipient => uint256) public withdrawableCredits;

    error AlreadyBound();
    error DeadlineNotReached();
    error Expired();
    error InactiveModule();
    error InvalidIdentifier();
    error InvalidPayment();
    error InvalidProtectedBundleLink();
    error InvalidState();
    error Unauthorized();

    event ListingCreated(bytes32 indexed listingId, bytes32 indexed batteryId, bytes32 sellerOrganizationId);
    event ListingStateChanged(bytes32 indexed listingId, ListingState state);
    event OfferSubmitted(bytes32 indexed offerId, bytes32 indexed listingId, bytes32 buyerOrganizationId);
    event OfferStateChanged(bytes32 indexed offerId, OfferState state);
    event AgreementCreated(bytes32 indexed agreementId, bytes32 indexed listingId, bytes32 indexed offerId);
    event AgreementStateChanged(bytes32 indexed agreementId, AgreementState state);
    event LogisticsRecorded(bytes32 indexed agreementId, bytes32 indexed actionId, bool delivered);
    event TransactionDisputeOpened(bytes32 indexed agreementId, bytes32 indexed disputeId);
    event CreditCreated(bytes32 indexed agreementId, address indexed recipient, uint256 amount);
    event CreditWithdrawn(address indexed recipient, uint256 amount);

    constructor(
        address authorityProfileRegistryAddress,
        address protectedBundleRegistryAddress,
        address batteryOwnershipRegistryAddress,
        address deploymentRegistryAddress,
        uint64 acceptanceWindowSeconds
    ) {
        if (
            authorityProfileRegistryAddress == address(0) || protectedBundleRegistryAddress == address(0)
                || batteryOwnershipRegistryAddress == address(0) || deploymentRegistryAddress == address(0)
                || acceptanceWindowSeconds == 0
        ) revert InvalidIdentifier();
        authorityProfileRegistry = IAuthorityProfileRegistry(authorityProfileRegistryAddress);
        protectedBundleRegistry = IProtectedBundleRegistry(protectedBundleRegistryAddress);
        batteryOwnershipRegistry = IBatteryOwnershipRegistry(batteryOwnershipRegistryAddress);
        deploymentRegistry = IDeploymentRegistry(deploymentRegistryAddress);
        acceptanceWindow = acceptanceWindowSeconds;
    }

    function moduleType() external pure returns (bytes32) {
        return MARKETPLACE_TYPE;
    }

    function compatibilityVersion() external pure returns (uint64) {
        return 1;
    }

    function createListing(ListingInput calldata input) external nonReentrant {
        _requireActiveModule();
        if (
            input.listingId == bytes32(0) || input.batteryId == bytes32(0)
                || input.sellerOrganizationId == bytes32(0) || input.sellerCredentialId == bytes32(0)
                || input.testPrice == 0 || input.sellerPayoutAddress == address(0)
        ) revert InvalidIdentifier();
        if (input.expiresAt <= block.timestamp) revert Expired();
        if (listings[input.listingId].state != ListingState.Unset) revert AlreadyBound();
        if (!_authorized(input.sellerCredentialId, input.sellerOrganizationId, LISTING_CAPABILITY, input.batteryId)) {
            revert Unauthorized();
        }
        (bytes32 ownerOrganizationId, address currentLock, bool registered) =
            batteryOwnershipRegistry.batteries(input.batteryId);
        if (!registered || ownerOrganizationId != input.sellerOrganizationId) revert Unauthorized();
        if (currentLock != address(0)) revert InvalidState();
        _requireBundle(
            input.bundleKey, input.listingId, LISTING_BUNDLE_TYPE, input.payloadCommitment, msg.sender
        );
        listings[input.listingId] = Listing({
            batteryId: input.batteryId,
            sellerOrganizationId: input.sellerOrganizationId,
            sellerCredentialId: input.sellerCredentialId,
            bundleKey: input.bundleKey,
            payloadCommitment: input.payloadCommitment,
            acceptedOfferId: bytes32(0),
            seller: msg.sender,
            sellerPayoutAddress: input.sellerPayoutAddress,
            testPrice: input.testPrice,
            expiresAt: input.expiresAt,
            state: ListingState.Active
        });
        batteryOwnershipRegistry.lockForMarketplace(input.batteryId);
        deploymentRegistry.bindAggregateOrigin(input.listingId);
        emit ListingCreated(input.listingId, input.batteryId, input.sellerOrganizationId);
    }

    function withdrawListing(bytes32 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        if (listing.state != ListingState.Active) revert InvalidState();
        if (listing.seller != msg.sender) revert Unauthorized();
        listing.state = ListingState.Withdrawn;
        batteryOwnershipRegistry.unlockForMarketplace(listing.batteryId);
        emit ListingStateChanged(listingId, ListingState.Withdrawn);
    }

    function expireListing(bytes32 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        if (listing.state != ListingState.Active) revert InvalidState();
        if (block.timestamp < listing.expiresAt) revert DeadlineNotReached();
        listing.state = ListingState.Expired;
        batteryOwnershipRegistry.unlockForMarketplace(listing.batteryId);
        emit ListingStateChanged(listingId, ListingState.Expired);
    }

    function submitOffer(OfferInput calldata input) external nonReentrant {
        _requireActiveModule();
        Listing memory listing = listings[input.listingId];
        if (listing.state != ListingState.Active || block.timestamp >= listing.expiresAt) revert InvalidState();
        if (
            input.offerId == bytes32(0) || input.buyerOrganizationId == bytes32(0)
                || input.buyerCredentialId == bytes32(0) || input.amount == 0
                || input.buyerRefundAddress == address(0) || input.termsCommitment == bytes32(0)
        ) revert InvalidIdentifier();
        if (input.expiresAt <= block.timestamp || input.expiresAt > listing.expiresAt) revert Expired();
        if (offers[input.offerId].state != OfferState.Unset) revert AlreadyBound();
        if (!_authorized(input.buyerCredentialId, input.buyerOrganizationId, OFFER_CAPABILITY, input.listingId)) {
            revert Unauthorized();
        }
        offers[input.offerId] = Offer({
            listingId: input.listingId,
            buyerOrganizationId: input.buyerOrganizationId,
            buyerCredentialId: input.buyerCredentialId,
            termsCommitment: input.termsCommitment,
            buyer: msg.sender,
            buyerRefundAddress: input.buyerRefundAddress,
            amount: input.amount,
            expiresAt: input.expiresAt,
            state: OfferState.Submitted
        });
        emit OfferSubmitted(input.offerId, input.listingId, input.buyerOrganizationId);
    }

    function withdrawOffer(bytes32 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        if (offer.state != OfferState.Submitted) revert InvalidState();
        if (offer.buyer != msg.sender) revert Unauthorized();
        offer.state = OfferState.Withdrawn;
        emit OfferStateChanged(offerId, OfferState.Withdrawn);
    }

    function rejectOffer(bytes32 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        Listing memory listing = listings[offer.listingId];
        if (offer.state != OfferState.Submitted || listing.state != ListingState.Active) revert InvalidState();
        if (listing.seller != msg.sender) revert Unauthorized();
        offer.state = OfferState.Rejected;
        emit OfferStateChanged(offerId, OfferState.Rejected);
    }

    function expireOffer(bytes32 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        if (offer.state != OfferState.Submitted) revert InvalidState();
        if (block.timestamp < offer.expiresAt) revert DeadlineNotReached();
        offer.state = OfferState.Expired;
        emit OfferStateChanged(offerId, OfferState.Expired);
    }

    function selectOfferAndCreateAgreement(AgreementInput calldata input) external nonReentrant {
        _requireActiveModule();
        Listing storage listing = listings[input.listingId];
        Offer storage offer = offers[input.offerId];
        if (
            listing.state != ListingState.Active || offer.state != OfferState.Submitted
                || offer.listingId != input.listingId || block.timestamp >= listing.expiresAt
                || block.timestamp >= offer.expiresAt
        ) revert InvalidState();
        if (listing.seller != msg.sender) revert Unauthorized();
        if (
            input.agreementId == bytes32(0) || input.buyerAccessAuthorizationDigest == bytes32(0)
                || input.confirmationDeadline <= block.timestamp
                || input.deliveryDeadline <= input.confirmationDeadline
        ) revert InvalidIdentifier();
        if (_agreements[input.agreementId].state != AgreementState.Unset) revert AlreadyBound();
        _requireBundle(
            input.bundleKey, input.agreementId, AGREEMENT_BUNDLE_TYPE, input.payloadCommitment, msg.sender
        );
        listing.state = ListingState.Matched;
        listing.acceptedOfferId = input.offerId;
        offer.state = OfferState.Accepted;
        _agreements[input.agreementId] = Agreement({
            listingId: input.listingId,
            offerId: input.offerId,
            batteryId: listing.batteryId,
            sellerOrganizationId: listing.sellerOrganizationId,
            buyerOrganizationId: offer.buyerOrganizationId,
            bundleKey: input.bundleKey,
            payloadCommitment: input.payloadCommitment,
            buyerAccessAuthorizationDigest: input.buyerAccessAuthorizationDigest,
            disputeId: bytes32(0),
            seller: listing.seller,
            buyer: offer.buyer,
            sellerPayoutAddress: listing.sellerPayoutAddress,
            buyerRefundAddress: offer.buyerRefundAddress,
            amount: offer.amount,
            confirmationDeadline: input.confirmationDeadline,
            deliveryDeadline: input.deliveryDeadline,
            state: AgreementState.AwaitingBuyerConfirmation
        });
        deploymentRegistry.bindAggregateOrigin(input.agreementId);
        emit AgreementCreated(input.agreementId, input.listingId, input.offerId);
    }

    function confirmAgreement(bytes32 agreementId, bytes32 accessAuthorizationDigest) external nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        if (agreement.state != AgreementState.AwaitingBuyerConfirmation) revert InvalidState();
        if (agreement.buyer != msg.sender) revert Unauthorized();
        if (
            block.timestamp >= agreement.confirmationDeadline
                || accessAuthorizationDigest != agreement.buyerAccessAuthorizationDigest
        ) revert Expired();
        agreement.state = AgreementState.AwaitingFunding;
        emit AgreementStateChanged(agreementId, AgreementState.AwaitingFunding);
    }

    function fundAgreement(bytes32 agreementId) external payable nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        if (agreement.state != AgreementState.AwaitingFunding) revert InvalidState();
        if (agreement.buyer != msg.sender) revert Unauthorized();
        if (block.timestamp >= agreement.confirmationDeadline) revert Expired();
        if (msg.value != agreement.amount) revert InvalidPayment();
        agreement.state = AgreementState.Funded;
        emit AgreementStateChanged(agreementId, AgreementState.Funded);
    }

    function cancelUnfundedAgreement(bytes32 agreementId) external nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        if (
            agreement.state != AgreementState.AwaitingBuyerConfirmation
                && agreement.state != AgreementState.AwaitingFunding
        ) revert InvalidState();
        if (block.timestamp < agreement.confirmationDeadline && _isActiveModule()) {
            revert DeadlineNotReached();
        }
        _cancelWithoutFunds(agreementId, agreement);
    }

    function recordDispatch(bytes32 agreementId, ProtectedAction calldata action) external nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        if (agreement.state != AgreementState.Funded || block.timestamp >= agreement.deliveryDeadline) {
            revert InvalidState();
        }
        _consumeProtectedAction(agreementId, action, LOGISTICS_BUNDLE_TYPE, LOGISTICS_CAPABILITY);
        agreement.state = AgreementState.InDelivery;
        emit LogisticsRecorded(agreementId, action.actionId, false);
        emit AgreementStateChanged(agreementId, AgreementState.InDelivery);
    }

    function recordDelivery(bytes32 agreementId, ProtectedAction calldata action) external nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        if (agreement.state != AgreementState.InDelivery || block.timestamp >= agreement.deliveryDeadline) {
            revert InvalidState();
        }
        _consumeProtectedAction(agreementId, action, LOGISTICS_BUNDLE_TYPE, LOGISTICS_CAPABILITY);
        agreement.state = AgreementState.Delivered;
        emit LogisticsRecorded(agreementId, action.actionId, true);
        emit AgreementStateChanged(agreementId, AgreementState.Delivered);
    }

    function acceptDelivery(bytes32 agreementId) external nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        if (agreement.state != AgreementState.Delivered) revert InvalidState();
        if (agreement.buyer != msg.sender) revert Unauthorized();
        if (block.timestamp >= agreement.deliveryDeadline + acceptanceWindow) revert Expired();
        agreement.state = AgreementState.Accepted;
        emit AgreementStateChanged(agreementId, AgreementState.Accepted);
    }

    function applyDispatchTimeout(bytes32 agreementId) external nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        if (agreement.state != AgreementState.Funded) revert InvalidState();
        if (block.timestamp < agreement.deliveryDeadline) revert DeadlineNotReached();
        _refundAndCancel(agreementId, agreement);
    }

    function applyDeliveryOrAcceptanceTimeout(bytes32 agreementId) external nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        bool deliveryLate = agreement.state == AgreementState.InDelivery && block.timestamp >= agreement.deliveryDeadline;
        bool acceptanceLate = agreement.state == AgreementState.Delivered
            && block.timestamp >= agreement.deliveryDeadline + acceptanceWindow;
        if (!deliveryLate && !acceptanceLate) revert DeadlineNotReached();
        agreement.state = AgreementState.TimedOutReferred;
        emit AgreementStateChanged(agreementId, AgreementState.TimedOutReferred);
    }

    function openTransactionDispute(bytes32 agreementId, ProtectedAction calldata action) external nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        if (
            agreement.state != AgreementState.Funded && agreement.state != AgreementState.InDelivery
                && agreement.state != AgreementState.Delivered
        ) revert InvalidState();
        if (msg.sender != agreement.buyer && msg.sender != agreement.seller) revert Unauthorized();
        if (action.organizationId != _partyOrganization(agreement, msg.sender)) revert Unauthorized();
        _consumeProtectedAction(agreementId, action, DISPUTE_BUNDLE_TYPE, DISPUTE_CAPABILITY);
        agreement.disputeId = action.actionId;
        agreement.state = AgreementState.Disputed;
        emit TransactionDisputeOpened(agreementId, action.actionId);
        emit AgreementStateChanged(agreementId, AgreementState.Disputed);
    }

    function resolveAgreement(
        bytes32 agreementId,
        bytes32 resolverOrganizationId,
        bytes32 resolverCredentialId,
        Resolution resolution
    ) external nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        if (
            agreement.state != AgreementState.Disputed
                && agreement.state != AgreementState.TimedOutReferred
        ) revert InvalidState();
        if (!_authorized(resolverCredentialId, resolverOrganizationId, RESOLVE_CAPABILITY, agreementId)) {
            revert Unauthorized();
        }
        if (msg.sender == agreement.buyer || msg.sender == agreement.seller) revert Unauthorized();
        if (resolution == Resolution.ReleaseAndTransfer) {
            _releaseAndTransfer(agreementId, agreement);
        } else {
            _refundAndCancel(agreementId, agreement);
        }
    }

    function settleAccepted(bytes32 agreementId) external nonReentrant {
        Agreement storage agreement = _agreements[agreementId];
        if (agreement.state != AgreementState.Accepted) revert InvalidState();
        _releaseAndTransfer(agreementId, agreement);
    }

    function withdrawCredits() external nonReentrant {
        uint256 amount = withdrawableCredits[msg.sender];
        if (amount == 0) revert InvalidPayment();
        withdrawableCredits[msg.sender] = 0;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        if (!sent) revert InvalidPayment();
        emit CreditWithdrawn(msg.sender, amount);
    }

    function agreementState(bytes32 agreementId) external view returns (AgreementState) {
        return _agreements[agreementId].state;
    }

    function listingState(bytes32 listingId) external view returns (ListingState) {
        return listings[listingId].state;
    }

    function listingExpiry(bytes32 listingId) external view returns (uint64) {
        return listings[listingId].expiresAt;
    }

    function offerState(bytes32 offerId) external view returns (OfferState) {
        return offers[offerId].state;
    }

    function effectiveOfferState(bytes32 offerId) external view returns (OfferState) {
        Offer storage offer = offers[offerId];
        if (offer.state != OfferState.Submitted) return offer.state;
        Listing storage listing = listings[offer.listingId];
        if (
            listing.state == ListingState.Matched || listing.state == ListingState.ClosedSettled
                || listing.state == ListingState.ClosedCancelled
        ) return listing.acceptedOfferId == offerId ? OfferState.Accepted : OfferState.Rejected;
        if (listing.state == ListingState.Withdrawn || listing.state == ListingState.Expired) {
            return OfferState.Rejected;
        }
        if (block.timestamp >= offer.expiresAt) return OfferState.Expired;
        return OfferState.Submitted;
    }

    function offerExpiry(bytes32 offerId) external view returns (uint64) {
        return offers[offerId].expiresAt;
    }

    function agreementParties(bytes32 agreementId)
        external
        view
        returns (
            bytes32 sellerOrganizationId,
            bytes32 buyerOrganizationId,
            address seller,
            address buyer,
            address sellerPayoutAddress,
            address buyerRefundAddress
        )
    {
        Agreement storage agreement = _agreements[agreementId];
        return (
            agreement.sellerOrganizationId,
            agreement.buyerOrganizationId,
            agreement.seller,
            agreement.buyer,
            agreement.sellerPayoutAddress,
            agreement.buyerRefundAddress
        );
    }

    function agreementTerms(bytes32 agreementId)
        external
        view
        returns (
            bytes32 listingId,
            bytes32 offerId,
            bytes32 batteryId,
            bytes32 bundleKey,
            bytes32 payloadCommitment,
            bytes32 accessAuthorizationDigest,
            uint256 amount,
            uint64 confirmationDeadline,
            uint64 deliveryDeadline
        )
    {
        Agreement storage agreement = _agreements[agreementId];
        return (
            agreement.listingId,
            agreement.offerId,
            agreement.batteryId,
            agreement.bundleKey,
            agreement.payloadCommitment,
            agreement.buyerAccessAuthorizationDigest,
            agreement.amount,
            agreement.confirmationDeadline,
            agreement.deliveryDeadline
        );
    }

    function _consumeProtectedAction(
        bytes32 agreementId,
        ProtectedAction calldata action,
        bytes32 bundleType,
        bytes32 capability
    ) private {
        if (action.actionId == bytes32(0) || protectedActions[action.actionId]) revert AlreadyBound();
        if (!_authorized(action.credentialId, action.organizationId, capability, agreementId)) {
            revert Unauthorized();
        }
        _requireBundle(action.bundleKey, action.actionId, bundleType, action.payloadCommitment, msg.sender);
        protectedActions[action.actionId] = true;
    }

    function _releaseAndTransfer(bytes32 agreementId, Agreement storage agreement) private {
        agreement.state = AgreementState.Settled;
        listings[agreement.listingId].state = ListingState.ClosedSettled;
        withdrawableCredits[agreement.sellerPayoutAddress] += agreement.amount;
        batteryOwnershipRegistry.transferRecordedOwnership(agreement.batteryId, agreement.buyerOrganizationId);
        emit CreditCreated(agreementId, agreement.sellerPayoutAddress, agreement.amount);
        emit AgreementStateChanged(agreementId, AgreementState.Settled);
    }

    function _refundAndCancel(bytes32 agreementId, Agreement storage agreement) private {
        agreement.state = AgreementState.Cancelled;
        listings[agreement.listingId].state = ListingState.ClosedCancelled;
        withdrawableCredits[agreement.buyerRefundAddress] += agreement.amount;
        batteryOwnershipRegistry.unlockForMarketplace(agreement.batteryId);
        emit CreditCreated(agreementId, agreement.buyerRefundAddress, agreement.amount);
        emit AgreementStateChanged(agreementId, AgreementState.Cancelled);
    }

    function _cancelWithoutFunds(bytes32 agreementId, Agreement storage agreement) private {
        agreement.state = AgreementState.Cancelled;
        listings[agreement.listingId].state = ListingState.ClosedCancelled;
        batteryOwnershipRegistry.unlockForMarketplace(agreement.batteryId);
        emit AgreementStateChanged(agreementId, AgreementState.Cancelled);
    }

    function _requireBundle(
        bytes32 bundleKey,
        bytes32 domainKey,
        bytes32 bundleType,
        bytes32 payloadCommitment,
        address expectedController
    ) private view {
        if (
            !protectedBundleRegistry.isConfirmedLink(
                bundleKey, domainKey, bundleType, payloadCommitment, true
            ) || protectedBundleRegistry.controllerOf(bundleKey) != expectedController
        ) revert InvalidProtectedBundleLink();
    }

    function _authorized(
        bytes32 credentialId,
        bytes32 organizationId,
        bytes32 capability,
        bytes32 scope
    ) private view returns (bool) {
        return authorityProfileRegistry.isCredentialActive(credentialId, organizationId, msg.sender)
            && authorityProfileRegistry.hasCapability(
                credentialId, capability, scope, uint64(block.timestamp)
            );
    }

    function _partyOrganization(Agreement storage agreement, address party) private view returns (bytes32) {
        return party == agreement.buyer ? agreement.buyerOrganizationId : agreement.sellerOrganizationId;
    }

    function _requireActiveModule() private view {
        if (!_isActiveModule()) revert InactiveModule();
    }

    function _isActiveModule() private view returns (bool) {
        return deploymentRegistry.activeModules(MARKETPLACE_TYPE) == address(this);
    }
}

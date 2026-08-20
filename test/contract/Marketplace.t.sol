// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {AuthorityProfileRegistry} from "../../contracts/AuthorityProfileRegistry.sol";
import {BatteryOwnershipRegistry} from "../../contracts/BatteryOwnershipRegistry.sol";
import {DeploymentRegistry} from "../../contracts/DeploymentRegistry.sol";
import {Marketplace} from "../../contracts/Marketplace.sol";
import {ProtectedBundleRegistry} from "../../contracts/ProtectedBundleRegistry.sol";
import {TestDomainModule} from "../../contracts/test/TestDomainModule.sol";

contract ReentrantCreditRecipient {
    Marketplace private marketplace;
    uint256 public receiveCount;

    function withdraw(Marketplace target) external {
        marketplace = target;
        target.withdrawCredits();
    }

    receive() external payable {
        receiveCount += 1;
        (bool ignored,) = address(marketplace).call(
            abi.encodeWithSelector(Marketplace.withdrawCredits.selector)
        );
        ignored;
    }
}

contract MarketplaceTest is Test {
    AuthorityProfileRegistry private authority;
    ProtectedBundleRegistry private bundles;
    BatteryOwnershipRegistry private ownership;
    DeploymentRegistry private deployments;
    Marketplace private marketplace;

    address private buyer = address(0xB0B);
    address private resolver = address(0xD15);
    address private replica = address(0x777);
    address payable private payout = payable(address(0x515));
    address payable private refund = payable(address(0x616));

    bytes32 private sellerOrg = keccak256("org:seller");
    bytes32 private buyerOrg = keccak256("org:buyer");
    bytes32 private resolverOrg = keccak256("org:resolver");
    bytes32 private replicaOrg = keccak256("org:replica");
    bytes32 private sellerCredential = keccak256("credential:seller");
    bytes32 private buyerCredential = keccak256("credential:buyer");
    bytes32 private resolverCredential = keccak256("credential:resolver");
    bytes32 private replicaCredential = keccak256("credential:replica");
    bytes32 private batteryId = keccak256("battery:marketplace-test");

    uint256 private sequence;

    function setUp() public {
        authority = new AuthorityProfileRegistry(address(this));
        bundles = new ProtectedBundleRegistry(address(authority));
        ownership = new BatteryOwnershipRegistry(address(this));
        deployments = new DeploymentRegistry(
            address(this), address(authority), address(bundles), address(ownership), 0
        );
        marketplace = new Marketplace(
            address(authority), address(bundles), address(ownership), address(deployments), 1 days
        );

        authority.setOrganizationStatus(sellerOrg, AuthorityProfileRegistry.OrganizationStatus.Active);
        authority.setOrganizationStatus(buyerOrg, AuthorityProfileRegistry.OrganizationStatus.Active);
        authority.setOrganizationStatus(resolverOrg, AuthorityProfileRegistry.OrganizationStatus.Active);
        authority.setOrganizationStatus(replicaOrg, AuthorityProfileRegistry.OrganizationStatus.Active);
        authority.setCredential(sellerCredential, sellerOrg, address(this), true, false);
        authority.setCredential(buyerCredential, buyerOrg, buyer, true, false);
        authority.setCredential(resolverCredential, resolverOrg, resolver, true, false);
        authority.setCredential(replicaCredential, replicaOrg, replica, true, true);

        ownership.setRegistrar(address(this), true);
        ownership.registerBattery(batteryId, sellerOrg);
        ownership.setMarketplace(address(marketplace), true);

        deployments.proposeModule(bytes32("marketplace"), address(marketplace));
        deployments.activateModule(bytes32("marketplace"));
        _grant(sellerCredential, marketplace.LISTING_CAPABILITY(), batteryId);
    }

    function test_completeAcceptedLifecycleCreditsFixedPayoutAndTransfersOwnership() public {
        (bytes32 listingId,, bytes32 agreementId) = _fundedAgreement(payout, refund, 1 ether);
        _recordDispatchAndDelivery(agreementId);

        vm.prank(buyer);
        marketplace.acceptDelivery(agreementId);
        marketplace.settleAccepted(agreementId);

        assertEq(uint8(marketplace.agreementState(agreementId)), uint8(Marketplace.AgreementState.Settled));
        (bytes32 owner,,) = ownership.batteries(batteryId);
        assertEq(owner, buyerOrg);
        assertEq(marketplace.withdrawableCredits(payout), 1 ether);
        assertEq(marketplace.withdrawableCredits(refund), 0);
        Marketplace.ListingState listingState = marketplace.listingState(listingId);
        assertEq(uint8(listingState), uint8(Marketplace.ListingState.ClosedSettled));

        uint256 before = payout.balance;
        vm.prank(payout);
        marketplace.withdrawCredits();
        assertEq(payout.balance - before, 1 ether);
    }

    function test_dispatchTimeoutRefundsOnlyImmutableBuyerAddress() public {
        (bytes32 listingId,, bytes32 agreementId) = _fundedAgreement(payout, refund, 2 ether);
        (,,,,,,,, uint64 deliveryDeadline) = marketplace.agreementTerms(agreementId);
        vm.warp(deliveryDeadline);
        marketplace.applyDispatchTimeout(agreementId);

        assertEq(marketplace.withdrawableCredits(refund), 2 ether);
        assertEq(marketplace.withdrawableCredits(buyer), 0);
        assertEq(uint8(marketplace.agreementState(agreementId)), uint8(Marketplace.AgreementState.Cancelled));
        (bytes32 owner, address lock,) = ownership.batteries(batteryId);
        assertEq(owner, sellerOrg);
        assertEq(lock, address(0));
        Marketplace.ListingState listingState = marketplace.listingState(listingId);
        assertEq(uint8(listingState), uint8(Marketplace.ListingState.ClosedCancelled));
    }

    function test_disputeResolutionIsBoundedAndResolverCannotBeParty() public {
        (,, bytes32 agreementId) = _fundedAgreement(payout, refund, 1 ether);
        bytes32 disputeId = _id("dispute");
        bytes32 payload = keccak256("dispute-payload");
        bytes32 bundle = _criticalBundle(disputeId, marketplace.DISPUTE_BUNDLE_TYPE(), payload);
        _grant(sellerCredential, marketplace.DISPUTE_CAPABILITY(), agreementId);
        Marketplace.ProtectedAction memory action = Marketplace.ProtectedAction({
            actionId: disputeId,
            bundleKey: bundle,
            payloadCommitment: payload,
            organizationId: sellerOrg,
            credentialId: sellerCredential
        });
        marketplace.openTransactionDispute(agreementId, action);

        vm.prank(buyer);
        vm.expectRevert(Marketplace.Unauthorized.selector);
        marketplace.resolveAgreement(
            agreementId, buyerOrg, buyerCredential, Marketplace.Resolution.RefundAndCancel
        );

        _grant(resolverCredential, marketplace.RESOLVE_CAPABILITY(), agreementId);
        vm.prank(resolver);
        marketplace.resolveAgreement(
            agreementId, resolverOrg, resolverCredential, Marketplace.Resolution.ReleaseAndTransfer
        );
        assertEq(marketplace.withdrawableCredits(payout), 1 ether);
        (bytes32 owner,,) = ownership.batteries(batteryId);
        assertEq(owner, buyerOrg);
    }

    function test_wrongBundleAccessDigestAuthorityAndPaymentFailClosed() public {
        bytes32 listingId = _id("listing");
        bytes32 payload = keccak256("listing-payload");
        bytes32 supplementaryBundle = _supplementaryBundle(
            listingId, marketplace.LISTING_BUNDLE_TYPE(), payload
        );
        Marketplace.ListingInput memory input = _listingInput(
            listingId, supplementaryBundle, payload, payout, 1 ether
        );
        vm.expectRevert(Marketplace.InvalidProtectedBundleLink.selector);
        marketplace.createListing(input);

        bytes32 wrongTypeListing = _id("wrong-type-listing");
        bytes32 wrongTypePayload = keccak256("wrong-type-payload");
        bytes32 wrongTypeBundle = _criticalBundle(
            wrongTypeListing, marketplace.AGREEMENT_BUNDLE_TYPE(), wrongTypePayload
        );
        vm.expectRevert(Marketplace.InvalidProtectedBundleLink.selector);
        marketplace.createListing(
            _listingInput(wrongTypeListing, wrongTypeBundle, wrongTypePayload, payout, 1 ether)
        );

        bytes32 bundle = _promote(supplementaryBundle);
        input.bundleKey = bundle;
        vm.prank(buyer);
        vm.expectRevert(Marketplace.Unauthorized.selector);
        marketplace.createListing(input);
        marketplace.createListing(input);

        bytes32 offerId = _submitOffer(listingId, refund, 1 ether);
        bytes32 agreementId = _createAgreement(listingId, offerId);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.Expired.selector);
        marketplace.confirmAgreement(agreementId, keccak256("wrong-access"));
        vm.prank(buyer);
        marketplace.confirmAgreement(agreementId, keccak256("buyer-access"));
        vm.deal(buyer, 2 ether);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.InvalidPayment.selector);
        marketplace.fundAgreement{value: 2 ether}(agreementId);
        vm.prank(buyer);
        marketplace.fundAgreement{value: 1 ether}(agreementId);
    }

    function test_withdrawExpiryOfferTerminalsAndCutoverDoNotStrandLocks() public {
        bytes32 first = _createListing(payout, 1 ether);
        marketplace.withdrawListing(first);
        (, address lockAfterWithdraw,) = ownership.batteries(batteryId);
        assertEq(lockAfterWithdraw, address(0));

        bytes32 second = _createListing(payout, 1 ether);
        bytes32 withdrawnOffer = _submitOffer(second, refund, 1 ether);
        vm.prank(buyer);
        marketplace.withdrawOffer(withdrawnOffer);
        bytes32 rejectedOffer = _submitOffer(second, refund, 1 ether);
        marketplace.rejectOffer(rejectedOffer);
        bytes32 expiredOffer = _submitOffer(second, refund, 1 ether);
        uint64 offerExpiry = marketplace.offerExpiry(expiredOffer);
        vm.warp(offerExpiry);
        marketplace.expireOffer(expiredOffer);

        bytes32 pendingOffer = _submitOffer(second, refund, 1 ether);

        TestDomainModule successor = new TestDomainModule(bytes32("marketplace"), 1);
        deployments.proposeModule(bytes32("marketplace"), address(successor));
        deployments.activateModule(bytes32("marketplace"));
        vm.expectRevert(Marketplace.InactiveModule.selector);
        marketplace.createListing(_listingInput(_id("blocked"), bytes32(uint256(1)), bytes32(uint256(2)), payout, 1));

        bytes32 blockedAgreement = _id("blocked-agreement");
        bytes32 blockedPayload = keccak256(abi.encode("agreement-payload", blockedAgreement));
        bytes32 blockedBundle = _criticalBundle(
            blockedAgreement, marketplace.AGREEMENT_BUNDLE_TYPE(), blockedPayload
        );
        vm.expectRevert(Marketplace.InactiveModule.selector);
        marketplace.selectOfferAndCreateAgreement(
            Marketplace.AgreementInput({
                agreementId: blockedAgreement,
                listingId: second,
                offerId: pendingOffer,
                bundleKey: blockedBundle,
                payloadCommitment: blockedPayload,
                buyerAccessAuthorizationDigest: keccak256("buyer-access"),
                confirmationDeadline: uint64(block.timestamp + 2 days),
                deliveryDeadline: uint64(block.timestamp + 4 days)
            })
        );
        vm.warp(marketplace.listingExpiry(second));
        marketplace.expireListing(second);
        (, address finalLock,) = ownership.batteries(batteryId);
        assertEq(finalLock, address(0));
    }

    function test_reentrantCreditRecipientCannotWithdrawTwice() public {
        ReentrantCreditRecipient recipient = new ReentrantCreditRecipient();
        (,, bytes32 agreementId) = _fundedAgreement(payable(address(recipient)), refund, 1 ether);
        _recordDispatchAndDelivery(agreementId);
        vm.prank(buyer);
        marketplace.acceptDelivery(agreementId);
        marketplace.settleAccepted(agreementId);

        recipient.withdraw(marketplace);
        assertEq(address(recipient).balance, 1 ether);
        assertEq(recipient.receiveCount(), 1);
        assertEq(marketplace.withdrawableCredits(address(recipient)), 0);
    }

    function test_acceptanceTimeoutNeverAutoReleasesAndResolverCanRefund() public {
        (,, bytes32 agreementId) = _fundedAgreement(payout, refund, 1 ether);
        _recordDispatchAndDelivery(agreementId);
        (,,,,,,,, uint64 deliveryDeadline) = marketplace.agreementTerms(agreementId);
        vm.warp(deliveryDeadline + 1 days);
        marketplace.applyDeliveryOrAcceptanceTimeout(agreementId);
        assertEq(
            uint8(marketplace.agreementState(agreementId)),
            uint8(Marketplace.AgreementState.TimedOutReferred)
        );
        assertEq(marketplace.withdrawableCredits(payout), 0);
        assertEq(marketplace.withdrawableCredits(refund), 0);

        _grant(resolverCredential, marketplace.RESOLVE_CAPABILITY(), agreementId);
        vm.prank(resolver);
        marketplace.resolveAgreement(
            agreementId, resolverOrg, resolverCredential, Marketplace.Resolution.RefundAndCancel
        );
        assertEq(marketplace.withdrawableCredits(refund), 1 ether);
    }

    function test_suspensionBlocksNewActivityButPreservesSafeUnwind() public {
        bytes32 listingId = _createListing(payout, 1 ether);
        _grant(buyerCredential, marketplace.OFFER_CAPABILITY(), listingId);
        authority.setOrganizationStatus(buyerOrg, AuthorityProfileRegistry.OrganizationStatus.Suspended);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.Unauthorized.selector);
        marketplace.submitOffer(
            Marketplace.OfferInput({
                offerId: _id("suspended-offer"),
                listingId: listingId,
                buyerOrganizationId: buyerOrg,
                buyerCredentialId: buyerCredential,
                amount: 1 ether,
                buyerRefundAddress: refund,
                termsCommitment: keccak256("suspended"),
                expiresAt: uint64(block.timestamp + 1 days)
            })
        );
        authority.setOrganizationStatus(buyerOrg, AuthorityProfileRegistry.OrganizationStatus.Active);
        authority.setOrganizationStatus(sellerOrg, AuthorityProfileRegistry.OrganizationStatus.Suspended);
        marketplace.withdrawListing(listingId);
        (, address lock,) = ownership.batteries(batteryId);
        assertEq(lock, address(0));
    }

    function test_manyOffersUseConstantSizeAcceptedDerivation() public {
        bytes32 listingId = _createListing(payout, 1 ether);
        bytes32 selected;
        bytes32 unselected;
        for (uint256 index = 0; index < 64; index++) {
            bytes32 offerId = _submitOffer(listingId, refund, 1 ether);
            if (index == 17) selected = offerId;
            if (index == 18) unselected = offerId;
        }
        _createAgreement(listingId, selected);
        assertEq(uint8(marketplace.offerState(unselected)), uint8(Marketplace.OfferState.Submitted));
        assertEq(
            uint8(marketplace.effectiveOfferState(unselected)), uint8(Marketplace.OfferState.Rejected)
        );
        assertEq(
            uint8(marketplace.effectiveOfferState(selected)), uint8(Marketplace.OfferState.Accepted)
        );
    }

    function testFuzz_exactEscrowValueConservation(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 1, 100 ether);
        (,, bytes32 agreementId) = _preparedAgreement(payout, refund, amount);
        vm.deal(buyer, amount + 1);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.InvalidPayment.selector);
        marketplace.fundAgreement{value: amount + 1}(agreementId);
        vm.prank(buyer);
        marketplace.fundAgreement{value: amount}(agreementId);
        assertEq(address(marketplace).balance, amount);
        (,,,,,, uint256 storedAmount,,) = marketplace.agreementTerms(agreementId);
        assertEq(storedAmount, amount);
    }

    function test_negativeDeadlineIdentityDuplicateAndStateBranches() public {
        Marketplace.ListingInput memory invalidListing = _listingInput(
            bytes32(0), bytes32(uint256(1)), bytes32(uint256(2)), payout, 1 ether
        );
        vm.expectRevert(Marketplace.InvalidIdentifier.selector);
        marketplace.createListing(invalidListing);

        bytes32 listingId = _id("negative-listing");
        bytes32 listingPayload = keccak256("negative-listing-payload");
        bytes32 listingBundle = _criticalBundle(
            listingId, marketplace.LISTING_BUNDLE_TYPE(), listingPayload
        );
        Marketplace.ListingInput memory listingInput = _listingInput(
            listingId, listingBundle, listingPayload, payout, 1 ether
        );
        listingInput.expiresAt = uint64(block.timestamp);
        vm.expectRevert(Marketplace.Expired.selector);
        marketplace.createListing(listingInput);
        listingInput.expiresAt = uint64(block.timestamp + 10 days);
        marketplace.createListing(listingInput);
        vm.expectRevert(Marketplace.AlreadyBound.selector);
        marketplace.createListing(listingInput);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.Unauthorized.selector);
        marketplace.withdrawListing(listingId);
        vm.expectRevert(Marketplace.DeadlineNotReached.selector);
        marketplace.expireListing(listingId);

        _grant(buyerCredential, marketplace.OFFER_CAPABILITY(), listingId);
        Marketplace.OfferInput memory offerInput = Marketplace.OfferInput({
            offerId: bytes32(0),
            listingId: listingId,
            buyerOrganizationId: buyerOrg,
            buyerCredentialId: buyerCredential,
            amount: 1 ether,
            buyerRefundAddress: refund,
            termsCommitment: keccak256("negative-offer"),
            expiresAt: uint64(block.timestamp + 1 days)
        });
        vm.prank(buyer);
        vm.expectRevert(Marketplace.InvalidIdentifier.selector);
        marketplace.submitOffer(offerInput);
        offerInput.offerId = _id("negative-offer");
        offerInput.expiresAt = uint64(block.timestamp + 11 days);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.Expired.selector);
        marketplace.submitOffer(offerInput);
        offerInput.expiresAt = uint64(block.timestamp + 1 days);
        vm.prank(buyer);
        marketplace.submitOffer(offerInput);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.AlreadyBound.selector);
        marketplace.submitOffer(offerInput);
        vm.expectRevert(Marketplace.Unauthorized.selector);
        marketplace.withdrawOffer(offerInput.offerId);
        vm.expectRevert(Marketplace.Unauthorized.selector);
        vm.prank(buyer);
        marketplace.rejectOffer(offerInput.offerId);
        vm.expectRevert(Marketplace.DeadlineNotReached.selector);
        marketplace.expireOffer(offerInput.offerId);

        bytes32 selected = _submitOffer(listingId, refund, 1 ether);
        bytes32 invalidAgreementId = bytes32(0);
        vm.expectRevert(Marketplace.InvalidIdentifier.selector);
        marketplace.selectOfferAndCreateAgreement(
            Marketplace.AgreementInput({
                agreementId: invalidAgreementId,
                listingId: listingId,
                offerId: selected,
                bundleKey: bytes32(uint256(1)),
                payloadCommitment: bytes32(uint256(2)),
                buyerAccessAuthorizationDigest: bytes32(0),
                confirmationDeadline: uint64(block.timestamp),
                deliveryDeadline: uint64(block.timestamp + 1 days)
            })
        );
        bytes32 agreementId = _createAgreement(listingId, selected);
        vm.expectRevert(Marketplace.Unauthorized.selector);
        marketplace.confirmAgreement(agreementId, keccak256("buyer-access"));
        vm.expectRevert(Marketplace.DeadlineNotReached.selector);
        marketplace.cancelUnfundedAgreement(agreementId);
        vm.prank(buyer);
        marketplace.confirmAgreement(agreementId, keccak256("buyer-access"));
        vm.expectRevert(Marketplace.InvalidState.selector);
        marketplace.recordDispatch(
            agreementId,
            Marketplace.ProtectedAction(bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0))
        );
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        marketplace.fundAgreement{value: 1 ether}(agreementId);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(Marketplace.InvalidState.selector);
        marketplace.fundAgreement{value: 1 ether}(agreementId);
        vm.expectRevert(Marketplace.InvalidState.selector);
        marketplace.recordDelivery(
            agreementId,
            Marketplace.ProtectedAction(bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0))
        );
        vm.expectRevert(Marketplace.InvalidState.selector);
        marketplace.acceptDelivery(agreementId);
        vm.expectRevert(Marketplace.InvalidPayment.selector);
        marketplace.withdrawCredits();
    }

    function _fundedAgreement(address payable sellerPayout, address payable buyerRefund, uint256 amount)
        private
        returns (bytes32 listingId, bytes32 offerId, bytes32 agreementId)
    {
        (listingId, offerId, agreementId) = _preparedAgreement(sellerPayout, buyerRefund, amount);
        vm.deal(buyer, amount);
        vm.prank(buyer);
        marketplace.fundAgreement{value: amount}(agreementId);
    }

    function _preparedAgreement(address payable sellerPayout, address payable buyerRefund, uint256 amount)
        private
        returns (bytes32 listingId, bytes32 offerId, bytes32 agreementId)
    {
        listingId = _createListing(sellerPayout, amount);
        offerId = _submitOffer(listingId, buyerRefund, amount);
        agreementId = _createAgreement(listingId, offerId);
        vm.prank(buyer);
        marketplace.confirmAgreement(agreementId, keccak256("buyer-access"));
    }

    function _createListing(address payable sellerPayout, uint256 amount) private returns (bytes32 listingId) {
        listingId = _id("listing");
        bytes32 payload = keccak256(abi.encode("listing-payload", listingId));
        bytes32 bundle = _criticalBundle(listingId, marketplace.LISTING_BUNDLE_TYPE(), payload);
        marketplace.createListing(_listingInput(listingId, bundle, payload, sellerPayout, amount));
    }

    function _listingInput(
        bytes32 listingId,
        bytes32 bundle,
        bytes32 payload,
        address payable sellerPayout,
        uint256 amount
    ) private view returns (Marketplace.ListingInput memory) {
        return Marketplace.ListingInput({
            listingId: listingId,
            batteryId: batteryId,
            sellerOrganizationId: sellerOrg,
            sellerCredentialId: sellerCredential,
            bundleKey: bundle,
            payloadCommitment: payload,
            testPrice: amount,
            sellerPayoutAddress: sellerPayout,
            expiresAt: uint64(block.timestamp + 10 days)
        });
    }

    function _submitOffer(bytes32 listingId, address payable buyerRefund, uint256 amount)
        private
        returns (bytes32 offerId)
    {
        offerId = _id("offer");
        _grant(buyerCredential, marketplace.OFFER_CAPABILITY(), listingId);
        Marketplace.OfferInput memory input = Marketplace.OfferInput({
            offerId: offerId,
            listingId: listingId,
            buyerOrganizationId: buyerOrg,
            buyerCredentialId: buyerCredential,
            amount: amount,
            buyerRefundAddress: buyerRefund,
            termsCommitment: keccak256(abi.encode("offer-terms", offerId)),
            expiresAt: uint64(block.timestamp + 5 days)
        });
        vm.prank(buyer);
        marketplace.submitOffer(input);
    }

    function _createAgreement(bytes32 listingId, bytes32 offerId) private returns (bytes32 agreementId) {
        agreementId = _id("agreement");
        bytes32 payload = keccak256(abi.encode("agreement-payload", agreementId));
        bytes32 bundle = _criticalBundle(agreementId, marketplace.AGREEMENT_BUNDLE_TYPE(), payload);
        marketplace.selectOfferAndCreateAgreement(
            Marketplace.AgreementInput({
                agreementId: agreementId,
                listingId: listingId,
                offerId: offerId,
                bundleKey: bundle,
                payloadCommitment: payload,
                buyerAccessAuthorizationDigest: keccak256("buyer-access"),
                confirmationDeadline: uint64(block.timestamp + 2 days),
                deliveryDeadline: uint64(block.timestamp + 4 days)
            })
        );
    }

    function _recordDispatchAndDelivery(bytes32 agreementId) private {
        _grant(sellerCredential, marketplace.LOGISTICS_CAPABILITY(), agreementId);
        for (uint256 index = 0; index < 2; index++) {
            bytes32 deliveryId = _id(index == 0 ? "dispatch" : "delivery");
            bytes32 payload = keccak256(abi.encode("logistics", deliveryId));
            bytes32 bundle = _criticalBundle(deliveryId, marketplace.LOGISTICS_BUNDLE_TYPE(), payload);
            Marketplace.ProtectedAction memory action = Marketplace.ProtectedAction({
                actionId: deliveryId,
                bundleKey: bundle,
                payloadCommitment: payload,
                organizationId: sellerOrg,
                credentialId: sellerCredential
            });
            if (index == 0) marketplace.recordDispatch(agreementId, action);
            else marketplace.recordDelivery(agreementId, action);
        }
    }

    function _criticalBundle(bytes32 domain, bytes32 bundleType, bytes32 payload)
        private
        returns (bytes32 bundle)
    {
        bundle = _supplementaryBundle(domain, bundleType, payload);
        _promote(bundle);
    }

    function _supplementaryBundle(bytes32 domain, bytes32 bundleType, bytes32 payload)
        private
        returns (bytes32 bundle)
    {
        bundle = _id("bundle");
        bundles.commitProtectedBundle(
            bundle,
            domain,
            sellerOrg,
            bundleType,
            payload,
            keccak256(abi.encode("envelope", bundle)),
            512,
            keccak256("replica-policy"),
            ProtectedBundleRegistry.CriticalityClass.Supplementary
        );
    }

    function _promote(bytes32 bundle) private returns (bytes32) {
        (,,,,, bytes32 envelopeDigest, uint64 length,,,) = bundles.commitments(bundle);
        vm.prank(replica);
        bundles.submitReplicaReceipt(
            bundle,
            keccak256("repository:replica"),
            replicaOrg,
            replicaCredential,
            envelopeDigest,
            length,
            _id("receipt")
        );
        bundles.promoteToDecisionCritical(bundle);
        return bundle;
    }

    function _grant(bytes32 credential, bytes32 capability, bytes32 scope) private {
        authority.setCapabilityGrant(credential, capability, scope, 0, 0, true);
    }

    function _id(string memory prefix) private returns (bytes32) {
        sequence += 1;
        return keccak256(abi.encode(prefix, sequence));
    }

}

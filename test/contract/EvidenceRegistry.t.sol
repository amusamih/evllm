// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";

import {AuthorityProfileRegistry} from "../../contracts/AuthorityProfileRegistry.sol";
import {EvidenceRegistry} from "../../contracts/EvidenceRegistry.sol";
import {ProtectedBundleRegistry} from "../../contracts/ProtectedBundleRegistry.sol";

contract EvidenceRegistryTest is Test {
    AuthorityProfileRegistry internal authority;
    ProtectedBundleRegistry internal bundles;
    EvidenceRegistry internal evidence;

    address internal issuer = makeAddr("issuer");
    address internal verifier = makeAddr("verifier");
    address internal opener = makeAddr("opener");
    address internal controller = makeAddr("controller");
    address internal replicaSigner = makeAddr("replica-signer");

    bytes32 internal issuerOrganization = keccak256("org:issuer");
    bytes32 internal verifierOrganization = keccak256("org:verifier");
    bytes32 internal openerOrganization = keccak256("org:opener");
    bytes32 internal issuerCredential = keccak256("credential:issuer");
    bytes32 internal verifierCredential = keccak256("credential:verifier");
    bytes32 internal openerCredential = keccak256("credential:opener");
    bytes32 internal replicaCredential = keccak256("credential:replica");
    bytes32 internal replicaOrganization = keccak256("org:replica");
    bytes32 internal claimKey = keccak256("claim:traction-capacity");

    function setUp() public {
        authority = new AuthorityProfileRegistry(address(this));
        bundles = new ProtectedBundleRegistry(address(authority));
        evidence = new EvidenceRegistry(address(authority), address(bundles));

        _activateCredential(issuerCredential, issuerOrganization, issuer);
        _activateCredential(verifierCredential, verifierOrganization, verifier);
        _activateCredential(openerCredential, openerOrganization, opener);
        authority.setOrganizationStatus(
            replicaOrganization, AuthorityProfileRegistry.OrganizationStatus.Active
        );
        authority.setCredential(replicaCredential, replicaOrganization, replicaSigner, true, true);
        authority.setCapabilityGrant(issuerCredential, evidence.ISSUE_CAPABILITY(), claimKey, 0, 0, true);
        authority.setCapabilityGrant(
            verifierCredential, evidence.CERTIFY_CAPABILITY(), claimKey, 0, 0, true
        );
        authority.setCapabilityGrant(openerCredential, evidence.DISPUTE_CAPABILITY(), claimKey, 0, 0, true);
    }

    function test_versionedEvidenceActivationSupersessionAndRevocation() public {
        (bytes32 bundleOne, bytes32 domainOne, bytes32 payloadOne) =
            _commit("evidence-bundle-1", "evidence-domain-1", evidence.EVIDENCE_BUNDLE_TYPE(), false);
        vm.prank(issuer);
        evidence.activateEvidence(
            claimKey,
            1,
            0,
            bundleOne,
            domainOne,
            payloadOne,
            issuerOrganization,
            issuerCredential
        );

        (bytes32 bundleTwo, bytes32 domainTwo, bytes32 payloadTwo) =
            _commit("evidence-bundle-2", "evidence-domain-2", evidence.EVIDENCE_BUNDLE_TYPE(), false);
        vm.prank(issuer);
        evidence.activateEvidence(
            claimKey,
            2,
            1,
            bundleTwo,
            domainTwo,
            payloadTwo,
            issuerOrganization,
            issuerCredential
        );

        assertEq(evidence.currentVersion(claimKey), 2);
        (,,,,,, EvidenceRegistry.EvidenceStatus priorStatus) = evidence.evidenceVersions(claimKey, 1);
        (,,,,,, EvidenceRegistry.EvidenceStatus currentStatus) = evidence.evidenceVersions(claimKey, 2);
        assertEq(uint256(priorStatus), uint256(EvidenceRegistry.EvidenceStatus.Superseded));
        assertEq(uint256(currentStatus), uint256(EvidenceRegistry.EvidenceStatus.Active));

        vm.prank(issuer);
        evidence.revokeEvidence(claimKey, 2);
        (,,,,,, currentStatus) = evidence.evidenceVersions(claimKey, 2);
        assertEq(uint256(currentStatus), uint256(EvidenceRegistry.EvidenceStatus.Revoked));
    }

    function test_certificationAndDisputeRequireCriticalTypedBundles() public {
        _activateFirstEvidence();

        (bytes32 verificationBundle, bytes32 verificationDomain, bytes32 verificationPayload) = _commit(
            "verification-bundle", "verification-domain", evidence.VERIFICATION_BUNDLE_TYPE(), true
        );
        bytes32 assertionKey = keccak256("assertion:1");
        vm.prank(verifier);
        evidence.createVerificationAssertion(
            assertionKey,
            claimKey,
            1,
            verificationBundle,
            verificationDomain,
            verificationPayload,
            verifierOrganization,
            verifierCredential,
            EvidenceRegistry.AssertionType.Certification
        );
        (,,,,,,, EvidenceRegistry.AssertionStatus assertionStatus) = evidence.assertions(assertionKey);
        assertEq(uint256(assertionStatus), uint256(EvidenceRegistry.AssertionStatus.Active));

        (bytes32 disputeBundle, bytes32 disputeDomain, bytes32 disputePayload) =
            _commit("dispute-bundle", "dispute-domain", evidence.DISPUTE_BUNDLE_TYPE(), true);
        bytes32 disputeKey = keccak256("dispute:1");
        vm.prank(opener);
        evidence.openEvidenceDispute(
            disputeKey,
            claimKey,
            1,
            disputeBundle,
            disputeDomain,
            disputePayload,
            openerOrganization,
            openerCredential
        );
        (,,,,,, EvidenceRegistry.DisputeStatus disputeStatus) = evidence.disputes(disputeKey);
        assertEq(uint256(disputeStatus), uint256(EvidenceRegistry.DisputeStatus.Open));
    }

    function test_negativeAuthorityPriorLinkAndSeparationRules() public {
        (bytes32 bundleKey, bytes32 domainKey, bytes32 payload) =
            _commit("evidence-negative", "evidence-negative-domain", evidence.EVIDENCE_BUNDLE_TYPE(), false);

        vm.prank(verifier);
        vm.expectRevert(EvidenceRegistry.Unauthorized.selector);
        evidence.activateEvidence(
            claimKey, 1, 0, bundleKey, domainKey, payload, issuerOrganization, issuerCredential
        );

        vm.prank(issuer);
        vm.expectRevert(EvidenceRegistry.InvalidPriorVersion.selector);
        evidence.activateEvidence(
            claimKey, 2, 0, bundleKey, domainKey, payload, issuerOrganization, issuerCredential
        );

        _activateFirstEvidence();
        authority.setCapabilityGrant(
            issuerCredential, evidence.CERTIFY_CAPABILITY(), claimKey, 0, 0, true
        );
        (bytes32 verificationBundle, bytes32 verificationDomain, bytes32 verificationPayload) = _commit(
            "self-verification", "self-verification-domain", evidence.VERIFICATION_BUNDLE_TYPE(), true
        );
        vm.prank(issuer);
        vm.expectRevert(EvidenceRegistry.SelfVerification.selector);
        evidence.createVerificationAssertion(
            keccak256("assertion:self"),
            claimKey,
            1,
            verificationBundle,
            verificationDomain,
            verificationPayload,
            issuerOrganization,
            issuerCredential,
            EvidenceRegistry.AssertionType.Certification
        );
    }

    function test_credentialBindingCapabilityExpiryAndTerminalOrganization() public {
        bytes32 expiringCapability = keccak256("capability:expiring");
        authority.setCapabilityGrant(issuerCredential, expiringCapability, claimKey, 10, 20, true);
        assertFalse(authority.hasCapability(issuerCredential, expiringCapability, claimKey, 9));
        assertTrue(authority.hasCapability(issuerCredential, expiringCapability, claimKey, 10));
        assertFalse(authority.hasCapability(issuerCredential, expiringCapability, claimKey, 20));

        authority.setOrganizationStatus(
            issuerOrganization, AuthorityProfileRegistry.OrganizationStatus.Revoked
        );
        assertFalse(authority.isCredentialActive(issuerCredential, issuerOrganization, issuer));
        vm.expectRevert(AuthorityProfileRegistry.TerminalOrganization.selector);
        authority.setOrganizationStatus(
            issuerOrganization, AuthorityProfileRegistry.OrganizationStatus.Active
        );
    }

    function test_authorityRejectsRebindingInvalidCredentialsAndCapabilityWindows() public {
        bytes32 profileId = keccak256("immutable-profile");
        bytes32 issueCapability = evidence.ISSUE_CAPABILITY();
        authority.setProfile(profileId, 1, keccak256("digest-a"), true);
        vm.expectRevert(AuthorityProfileRegistry.AlreadyBound.selector);
        authority.setProfile(profileId, 1, keccak256("digest-b"), true);

        vm.expectRevert(AuthorityProfileRegistry.InvalidIdentifier.selector);
        authority.setCredential(bytes32(0), issuerOrganization, issuer, true, false);
        vm.expectRevert(AuthorityProfileRegistry.AlreadyBound.selector);
        authority.setCredential(issuerCredential, verifierOrganization, verifier, true, false);
        vm.expectRevert(AuthorityProfileRegistry.InvalidIdentifier.selector);
        authority.setCapabilityGrant(bytes32(0), issueCapability, claimKey, 0, 0, true);
        vm.expectRevert(AuthorityProfileRegistry.InvalidIdentifier.selector);
        authority.setCapabilityGrant(
            keccak256("unknown-credential"), issueCapability, claimKey, 0, 0, true
        );
        vm.expectRevert(AuthorityProfileRegistry.InvalidTimeRange.selector);
        authority.setCapabilityGrant(issuerCredential, issueCapability, claimKey, 10, 10, true);
        assertFalse(
            authority.isReplicaAttestationCredential(
                issuerCredential, issuerOrganization, issuer
            )
        );
    }

    function test_onchainDomainAttestationVerificationAndReplayDenial() public {
        uint256 authorPrivateKey = 0xA11CE;
        address author = vm.addr(authorPrivateKey);
        bytes32 authorCredential = keccak256("credential:onchain-author");
        authority.setCredential(authorCredential, issuerOrganization, author, true, false);
        bytes32 controllerCredential = keccak256("credential:onchain-controller");
        authority.setCredential(
            controllerCredential, issuerOrganization, controller, true, false
        );
        ProtectedBundleRegistry.DomainAttestation memory attestation = ProtectedBundleRegistry.DomainAttestation({
            bundleId: keccak256("attested-bundle"),
            bundleVersion: 1,
            bundleType: evidence.EVIDENCE_BUNDLE_TYPE(),
            domainResourceId: keccak256("attested-evidence"),
            domainResourceVersion: 1,
            authorBindingProfileId: keccak256("author-binding-profile"),
            authorBindingProfileVersion: 1,
            domainPayloadCommitment: keccak256("attested-payload"),
            signerActorId: keccak256("actor:onchain-author"),
            signerOrgId: issuerOrganization,
            signerCredentialId: authorCredential,
            nonce: 77,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 5 minutes)
        });
        bytes32 domainTypehash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                domainTypehash,
                keccak256("EVLLM Domain Manifest"),
                keccak256("1"),
                block.chainid,
                address(bundles)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(bundles.DOMAIN_ATTESTATION_TYPEHASH(), attestation)
        );
        bytes32 typedDigest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(authorPrivateKey, typedDigest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(controller);
        bundles.commitAttestedProtectedBundle(
            attestation,
            signature,
            issuerOrganization,
            controllerCredential,
            keccak256("attested-envelope"),
            512,
            keccak256("attested-replica-policy")
        );
        assertTrue(
            bundles.isConfirmedLink(
                attestation.bundleId,
                attestation.domainResourceId,
                attestation.bundleType,
                attestation.domainPayloadCommitment,
                false
            )
        );

        vm.prank(controller);
        vm.expectRevert(ProtectedBundleRegistry.AttestationReplay.selector);
        bundles.commitAttestedProtectedBundle(
            attestation,
            signature,
            issuerOrganization,
            controllerCredential,
            keccak256("attested-envelope"),
            512,
            keccak256("attested-replica-policy")
        );
    }

    function test_assertionWithdrawalAndDisputeTerminalPaths() public {
        _activateFirstEvidence();
        authority.setCapabilityGrant(
            verifierCredential, evidence.CORROBORATE_CAPABILITY(), claimKey, 0, 0, true
        );
        (bytes32 verificationBundle, bytes32 verificationDomain, bytes32 verificationPayload) = _commit(
            "corroboration-bundle", "corroboration-domain", evidence.VERIFICATION_BUNDLE_TYPE(), true
        );
        bytes32 assertionKey = keccak256("assertion:withdraw");
        vm.prank(verifier);
        evidence.createVerificationAssertion(
            assertionKey,
            claimKey,
            1,
            verificationBundle,
            verificationDomain,
            verificationPayload,
            verifierOrganization,
            verifierCredential,
            EvidenceRegistry.AssertionType.Corroboration
        );
        vm.prank(issuer);
        vm.expectRevert(EvidenceRegistry.Unauthorized.selector);
        evidence.withdrawVerificationAssertion(assertionKey);
        vm.prank(verifier);
        evidence.withdrawVerificationAssertion(assertionKey);
        vm.prank(verifier);
        vm.expectRevert(EvidenceRegistry.InvalidState.selector);
        evidence.withdrawVerificationAssertion(assertionKey);

        bytes32 disputeKey = _openDispute("dispute-withdraw");
        vm.prank(issuer);
        vm.expectRevert(EvidenceRegistry.Unauthorized.selector);
        evidence.changeEvidenceDisputeState(disputeKey, EvidenceRegistry.DisputeStatus.Withdrawn);
        vm.prank(opener);
        vm.expectRevert(EvidenceRegistry.InvalidState.selector);
        evidence.changeEvidenceDisputeState(
            disputeKey, EvidenceRegistry.DisputeStatus.ClosedBySupersession
        );
        vm.prank(opener);
        evidence.changeEvidenceDisputeState(disputeKey, EvidenceRegistry.DisputeStatus.Withdrawn);
    }

    function testFuzz_capabilityScopeAndTimeRemainExact(
        bytes32 requestedScope,
        uint64 effectiveAt,
        uint32 duration,
        uint64 observedAt
    ) public {
        vm.assume(requestedScope != claimKey);
        effectiveAt = uint64(bound(effectiveAt, 1, type(uint32).max));
        duration = uint32(bound(duration, 1, type(uint32).max));
        uint64 expiresAt = effectiveAt + duration;
        bytes32 capability = keccak256("capability:fuzz-scoped");
        authority.setCapabilityGrant(
            issuerCredential, capability, claimKey, effectiveAt, expiresAt, true
        );
        assertFalse(authority.hasCapability(issuerCredential, capability, requestedScope, observedAt));
        assertEq(
            authority.hasCapability(issuerCredential, capability, claimKey, observedAt),
            observedAt >= effectiveAt && observedAt < expiresAt
        );
    }

    function test_disputeClosesAfterSupersessionAndRefersAfterRevocation() public {
        _activateFirstEvidence();
        bytes32 supersededDispute = _openDispute("dispute-superseded");
        (bytes32 bundleTwo, bytes32 domainTwo, bytes32 payloadTwo) =
            _commit("evidence-v2", "evidence-v2-domain", evidence.EVIDENCE_BUNDLE_TYPE(), false);
        vm.prank(issuer);
        evidence.activateEvidence(
            claimKey,
            2,
            1,
            bundleTwo,
            domainTwo,
            payloadTwo,
            issuerOrganization,
            issuerCredential
        );
        vm.prank(issuer);
        evidence.closeEvidenceDisputeForLifecycle(supersededDispute);
        (,,,,,, EvidenceRegistry.DisputeStatus closedStatus) = evidence.disputes(supersededDispute);
        assertEq(uint256(closedStatus), uint256(EvidenceRegistry.DisputeStatus.ClosedBySupersession));

        bytes32 revokedDispute = _openDisputeForVersion("dispute-revoked", 2);
        vm.prank(issuer);
        evidence.revokeEvidence(claimKey, 2);
        vm.prank(issuer);
        evidence.closeEvidenceDisputeForLifecycle(revokedDispute);
        (,,,,,, closedStatus) = evidence.disputes(revokedDispute);
        assertEq(uint256(closedStatus), uint256(EvidenceRegistry.DisputeStatus.ReferredExternal));
    }

    function test_negativeInvalidLinksDuplicateAndStatePaths() public {
        vm.expectRevert(EvidenceRegistry.InvalidIdentifier.selector);
        evidence.activateEvidence(
            bytes32(0), 1, 0, bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)
        );
        (bytes32 bundleKey, bytes32 domainKey, bytes32 payload) =
            _commit("wrong-link", "wrong-link-domain", evidence.EVIDENCE_BUNDLE_TYPE(), false);
        vm.prank(issuer);
        vm.expectRevert(EvidenceRegistry.InvalidProtectedBundleLink.selector);
        evidence.activateEvidence(
            claimKey,
            1,
            0,
            bundleKey,
            domainKey,
            keccak256("substituted"),
            issuerOrganization,
            issuerCredential
        );
        _activateFirstEvidence();
        vm.prank(issuer);
        vm.expectRevert(EvidenceRegistry.AlreadyBound.selector);
        evidence.activateEvidence(
            claimKey,
            1,
            1,
            bundleKey,
            domainKey,
            payload,
            issuerOrganization,
            issuerCredential
        );
        vm.prank(opener);
        vm.expectRevert(EvidenceRegistry.InvalidState.selector);
        evidence.openEvidenceDispute(
            keccak256("unknown-dispute"),
            claimKey,
            99,
            bundleKey,
            domainKey,
            payload,
            openerOrganization,
            openerCredential
        );
        vm.prank(issuer);
        vm.expectRevert(EvidenceRegistry.InvalidState.selector);
        evidence.revokeEvidence(claimKey, 99);
    }

    function _activateFirstEvidence() internal {
        (bytes32 bundleKey, bytes32 domainKey, bytes32 payload) =
            _commit("evidence-active", "evidence-active-domain", evidence.EVIDENCE_BUNDLE_TYPE(), false);
        vm.prank(issuer);
        evidence.activateEvidence(
            claimKey,
            1,
            0,
            bundleKey,
            domainKey,
            payload,
            issuerOrganization,
            issuerCredential
        );
    }

    function _activateCredential(bytes32 credentialId, bytes32 organizationId, address account) internal {
        authority.setOrganizationStatus(organizationId, AuthorityProfileRegistry.OrganizationStatus.Active);
        authority.setCredential(credentialId, organizationId, account, true, false);
    }

    function _openDispute(string memory label) internal returns (bytes32) {
        return _openDisputeForVersion(label, 1);
    }

    function _openDisputeForVersion(string memory label, uint64 version) internal returns (bytes32 disputeKey) {
        (bytes32 disputeBundle, bytes32 disputeDomain, bytes32 disputePayload) = _commit(
            string.concat(label, "-bundle"),
            string.concat(label, "-domain"),
            evidence.DISPUTE_BUNDLE_TYPE(),
            true
        );
        disputeKey = keccak256(bytes(label));
        vm.prank(opener);
        evidence.openEvidenceDispute(
            disputeKey,
            claimKey,
            version,
            disputeBundle,
            disputeDomain,
            disputePayload,
            openerOrganization,
            openerCredential
        );
    }

    function _commit(string memory bundleLabel, string memory domainLabel, bytes32 bundleType, bool critical)
        internal
        returns (bytes32 bundleKey, bytes32 domainKey, bytes32 payload)
    {
        bundleKey = keccak256(bytes(bundleLabel));
        domainKey = keccak256(bytes(domainLabel));
        payload = keccak256(abi.encodePacked("payload:", bundleLabel));
        bundles.commitProtectedBundle(
            bundleKey,
            domainKey,
            issuerOrganization,
            bundleType,
            payload,
            keccak256(abi.encodePacked("envelope:", bundleLabel)),
            512,
            keccak256("replica-policy:v1"),
            ProtectedBundleRegistry.CriticalityClass.Supplementary
        );
        if (critical) {
            vm.prank(replicaSigner);
            bundles.submitReplicaReceipt(
                bundleKey,
                keccak256("repository:replica"),
                replicaOrganization,
                replicaCredential,
                keccak256(abi.encodePacked("envelope:", bundleLabel)),
                512,
                keccak256(abi.encodePacked("receipt:", bundleLabel))
            );
            bundles.promoteToDecisionCritical(bundleKey);
        }
    }
}

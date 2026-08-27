import { Signature, Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import { eip712Profiles } from "../../src/schemas/index.js";
import {
  NonceStore,
  nonceScope,
  type ProtectedSignatureType,
  verifyProtectedProof,
} from "../../src/protected-bundles/signatures/index.js";

const zero = `0x${"0".repeat(64)}`;
const one = `0x${"0".repeat(63)}1`;
const credentialId = zero;
const contract = `0x${"a".repeat(40)}`;
const domain = {
  chainId: 31337,
  name: "EVLLM Domain Manifest",
  verifyingContract: contract,
  version: "1" as const,
};
const message = {
  bundleId: zero,
  bundleVersion: 1,
  bundleType: zero,
  domainResourceId: zero,
  domainResourceVersion: 1,
  authorBindingProfileId: zero,
  authorBindingProfileVersion: 1,
  domainPayloadCommitment: zero,
  signerActorId: zero,
  signerOrgId: zero,
  signerCredentialId: credentialId,
  nonce: one,
  issuedAt: 100,
  expiresAt: 200,
};

describe("EIP-712 protected proof verification", () => {
  const wallet = new Wallet(`0x${"1".repeat(64)}`);

  it("verifies a canonical proof and consumes its scoped nonce", async () => {
    const signature = await sign(wallet, "DomainManifestAttestation", domain, message);
    const nonces = new NonceStore();
    const result = verifyProtectedProof({
      credentialAt: activeCredential,
      domain,
      expectedSignerAddress: wallet.address.toLowerCase(),
      maxLifetimeSeconds: 100,
      message,
      mode: { currentTime: 150, kind: "execution", nonceStore: nonces },
      signature,
      type: "DomainManifestAttestation",
    });
    expect(result.typedDataDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.signatureDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(nonces.has(nonceScope("DomainManifestAttestation", credentialId, one))).toBe(true);
    expect(() =>
      verifyProtectedProof({
        credentialAt: activeCredential,
        domain,
        expectedSignerAddress: wallet.address.toLowerCase(),
        maxLifetimeSeconds: 100,
        message,
        mode: { currentTime: 150, kind: "execution", nonceStore: nonces },
        signature,
        type: "DomainManifestAttestation",
      }),
    ).toThrow("Signed proof is invalid");
  });

  it("supports nonce rollback after a reorganization", async () => {
    const signature = await sign(wallet, "DomainManifestAttestation", domain, message);
    const nonces = new NonceStore();
    const input = {
      credentialAt: activeCredential,
      domain,
      expectedSignerAddress: wallet.address.toLowerCase(),
      maxLifetimeSeconds: 100,
      message,
      mode: { currentTime: 150, kind: "execution" as const, nonceStore: nonces },
      signature,
      type: "DomainManifestAttestation" as const,
    };
    verifyProtectedProof(input);
    nonces.rollback(nonceScope("DomainManifestAttestation", credentialId, one));
    expect(() => verifyProtectedProof(input)).not.toThrow();
  });

  it("verifies retained history at acceptance time after wall-clock expiry", async () => {
    const signature = await sign(wallet, "DomainManifestAttestation", domain, message);
    expect(() =>
      verifyProtectedProof({
        credentialAt: activeCredential,
        domain,
        expectedSignerAddress: wallet.address.toLowerCase(),
        maxLifetimeSeconds: 100,
        message,
        mode: { acceptanceTime: 150, kind: "historical" },
        signature,
        type: "DomainManifestAttestation",
      }),
    ).not.toThrow();
    expect(() =>
      verifyProtectedProof({
        credentialAt: activeCredential,
        domain,
        expectedSignerAddress: wallet.address.toLowerCase(),
        maxLifetimeSeconds: 100,
        message,
        mode: { currentTime: 250, kind: "execution", nonceStore: new NonceStore() },
        signature,
        type: "DomainManifestAttestation",
      }),
    ).toThrow();
  });

  it("rejects altered messages, wrong domains, and inactive credentials", async () => {
    const signature = await sign(wallet, "DomainManifestAttestation", domain, message);
    const base = {
      credentialAt: activeCredential,
      domain,
      expectedSignerAddress: wallet.address.toLowerCase(),
      maxLifetimeSeconds: 100,
      message,
      mode: { acceptanceTime: 150, kind: "historical" as const },
      signature,
      type: "DomainManifestAttestation" as const,
    };
    expect(() =>
      verifyProtectedProof({ ...base, message: { ...message, bundleVersion: 2 } }),
    ).toThrow();
    expect(() => verifyProtectedProof({ ...base, domain: { ...domain, chainId: 1 } })).toThrow();
    expect(() =>
      verifyProtectedProof({
        ...base,
        credentialAt: () => ({ active: false, validFrom: 1 }),
      }),
    ).toThrow();
  });

  it("rejects compact, alternate-v, and high-s signatures before recovery", async () => {
    const canonical = await sign(wallet, "DomainManifestAttestation", domain, message);
    const parsed = Signature.from(canonical);
    const compact = parsed.compactSerialized.toLowerCase();
    const alternateV = `${canonical.slice(0, -2)}00`;
    const curveN = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = (curveN - BigInt(parsed.s)).toString(16).padStart(64, "0");
    const flippedV = parsed.v === 27 ? "1c" : "1b";
    const malleable = `${canonical.slice(0, 66)}${highS}${flippedV}`;
    for (const signature of [compact, alternateV, malleable]) {
      expect(() =>
        verifyProtectedProof({
          credentialAt: activeCredential,
          domain,
          expectedSignerAddress: wallet.address.toLowerCase(),
          maxLifetimeSeconds: 100,
          message,
          mode: { acceptanceTime: 150, kind: "historical" },
          signature,
          type: "DomainManifestAttestation",
        }),
      ).toThrow();
    }
  });
});

function activeCredential() {
  return { active: true, validFrom: 1, validUntil: 1_000 };
}

async function sign(
  wallet: Wallet,
  type: ProtectedSignatureType,
  signingDomain: typeof domain,
  value: Record<string, unknown>,
): Promise<string> {
  const profile = eip712Profiles[type];
  return (
    await wallet.signTypedData(
      signingDomain,
      { [profile.primaryType]: profile.fields.map((field) => ({ ...field })) },
      value,
    )
  ).toLowerCase();
}

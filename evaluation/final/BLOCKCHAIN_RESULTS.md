# Blockchain implementation and assurance results

## Public Sepolia deployment

- Chain ID: 11155111
- Compiler: solc-0.8.36; EVM cancun; optimizer runs 200
- Deployment blocks: 11473623-11473645
- Source verification: Etherscan, Blockscout, and Sourcify all recorded as verified
- Evaluation review delay: 60 seconds; the production configuration uses 86,400 seconds

| Contract | Sepolia address |
|---|---|
| AuthorityProfileRegistry | `0x71aD47F98f7a8185f5bE155cC04C345d8dCD9E13` |
| ProtectedBundleRegistry | `0xDE6D5Fb286C217AA48AEc6C3Da320251A63E9D49` |
| BatteryOwnershipRegistry | `0x04a37F6f0E5E48f525f2933FB543e7A7f4053D55` |
| DeploymentRegistry | `0xA71F4D631AA783Db7FAB8Ec6055e7A7623348F29` |
| EvidenceRegistry | `0xC54D56bAA283987691fa1eaDE4C794c312Afb568` |
| Marketplace | `0x531AeC3731118c6E3830f6d921aCe90322CC8519` |
| AuditAnchor | `0x2F73f9004517eAA82Db510Da4b30e6F7986949b8` |

## Complete public workflow

| Measure | Observed value |
|---|---:|
| Confirmed transactions | 57 |
| Block range | 11,516,496-11,516,560 |
| Gas used | 6,610,960 |
| Function-call data | 11,844 bytes |
| Observed Sepolia fee | 0.006920297001991101 Sepolia ETH |
| Confirmation latency p50 | 12.00 s |
| Confirmation latency p95 | 35.77 s |

The Sepolia workflow registers the role accounts, records initial ownership, commits and replicates protected diagnostic and verification records, creates and funds a marketplace agreement, records dispatch and delivery, settles the transaction, transfers recorded ownership, withdraws the seller credit, and anchors an audit batch. All receipts are confirmed and every expected final-state check passes. Sepolia ETH is test-network currency and is not assigned a fiat value.

## Contract testing and analysis

- Complete seven-contract executable-line coverage: **88.2%**.
- High-volume randomized assurance: **150,000 fuzz cases** and **5,120 invariant runs** across 5 fixed seeds; all passed.
- Slither: no unresolved high- or medium-impact finding; 22 low or informational findings were reviewed and documented with rationale.
- Reentrancy, authorization, replay, deadline, cutover, escrow, recovery, and negative state-transition cases are included in the contract and integration suites.

| Contract | Executable lines hit | Coverage |
|---|---:|---:|
| AuditAnchor.sol | 35/39 | 89.7% |
| AuthorityProfileRegistry.sol | 40/40 | 100.0% |
| BatteryOwnershipRegistry.sol | 70/79 | 88.6% |
| DeploymentRegistry.sol | 29/29 | 100.0% |
| EvidenceRegistry.sol | 105/124 | 84.7% |
| Marketplace.sol | 248/296 | 83.8% |
| ProtectedBundleRegistry.sol | 108/113 | 95.6% |

## Deployment gas characterization

| Contract | Median deployment gas | Runtime bytecode bytes |
|---|---:|---:|
| AuditAnchor | 670,039 | 2,817 |
| AuthorityProfileRegistry | 1,327,958 | 5,766 |
| BatteryOwnershipRegistry | 2,090,880 | 9,295 |
| DeploymentRegistry | 894,555 | 3,702 |
| EvidenceRegistry | 2,437,289 | 10,982 |
| Marketplace | 5,381,953 | 24,477 |
| ProtectedBundleRegistry | 2,075,245 | 9,257 |

Gas units are reproducible implementation measurements; fiat or ETH cost varies with network fee conditions and is not treated as a stable system property.

## Scope of the blockchain results

The contracts enforce attributable authority, immutable commitments, lifecycle transitions, ownership, escrow, module routing, and audit anchoring. Blockchain consensus does not establish the physical truth of submitted evidence, lawful processing, competence, confidentiality of plaintext, industry adoption, or realized sustainability outcomes. Confidential content and encryption keys remain off chain.

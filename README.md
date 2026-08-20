# Second-Life EV Battery Decision Support and Coordination System

This repository contains the implementation of a system for managing and using information about
second-life electric-vehicle batteries across organizational boundaries. The system protects
confidential records, preserves attributable commitments and lifecycle state on an EVM-compatible
blockchain, evaluates three second-life routes through deterministic calculations, and supplies
authorized, status-checked records to a conversational decision-support service.

The implementation also includes a battery transaction workflow. That marketplace is one use of the
shared records, access controls, ownership state and smart contracts; it is not the sole purpose of
the system.

## Core capabilities

### Protected records and controlled access

- Immutable, typed and versioned records with author attribution, independent verification,
  correction, supersession, revocation and dispute handling.
- AES-256-GCM encrypted record packages with RSA-OAEP-256 key envelopes, organization-scoped access
  grants and controlled key recovery.
- Organization-controlled primary repositories and a byte-identical encrypted replica for records
  classified as decision-critical.
- Authorization by actor, organization, resource, purpose, operation, state and validity period
  before protected retrieval or search.

### Second-life route assessment

- Deterministic comparison of continued compatible-EV use, stationary-storage repurposing and
  recycling.
- Six separate outputs covering the technical and safety gate, circularity, environmental
  indicators, economics, information adequacy and uncertainty.
- Exact-decimal calculations, reproducible inputs and a conservative preference rule that returns a
  route only when the available information supports a unique and stable choice.
- Explicit abstention or responsible external decision when information is missing, conflicting or
  insufficient for a reliable route preference.

### Governed conversational decision support

- Wallet-bound sessions and a closed set of read-only tools for facts, history, rules, assessments,
  audit records and authorized protected search.
- Retrieval and policy checks performed by the application before selected supporting records are
  supplied to the language model.
- Structured responses with record-level citations, outcome codes, abstention behavior and
  post-generation checks.
- No model signing key, transaction authority, raw database access, blockchain RPC access,
  repository access or unrestricted web access.

### Blockchain coordination and audit

Seven Solidity smart contracts implement the shared state needed by the system:

- `AuthorityProfileRegistry` records scoped organizational authority.
- `ProtectedBundleRegistry` records protected-record commitments and verified replica receipts.
- `BatteryOwnershipRegistry` records stable battery identities and declared ownership state.
- `DeploymentRegistry` controls approved contract-module transitions.
- `EvidenceRegistry` records evidence-claim and verification lifecycles.
- `Marketplace` coordinates the implemented battery transaction workflow.
- `AuditAnchor` records commitments to completed batches of minimized audit entries.

The blockchain stores identifiers, commitments and accepted state transitions. Confidential record
content, decryption keys, detailed assessment inputs and model context remain off chain.

### Battery transaction workflow

- Recorded-owner listing, buyer offers, seller selection and a separately confirmed agreement.
- Agreement-scoped access, exact-value funding, logistics updates, acceptance, settlement, refund,
  dispute and timeout paths.
- Recorded ownership transfer and pull-based seller withdrawal after successful settlement.
- Contract-enforced battery locking while an active transaction prevents conflicting transfers.

The language model cannot list a battery, sign an agreement, move funds, dispatch a shipment,
resolve a dispute or transfer recorded ownership.

## System boundaries

Blockchain commitments preserve submitted provenance claims and accepted digital state; they do not
prove physical condition, legal title or the truth of a submitted record. The encrypted replica can
return a protected package during primary-storage failure, but it has no decryption key,
access-grant authority or protected search index. The implementation is evaluated through controlled
synthetic cases, local software and contract testing, security analysis, and a public Sepolia
workflow.

## Requirements

- Node.js 24 and npm 11
- Docker for PostgreSQL, SeaweedFS integration tests and the pinned Slither image
- A Sepolia RPC endpoint and funded role accounts only when reproducing public-network deployment
- An OpenAI API key only when running live model checks, evaluation calls or interface
  demonstrations

Copy the committed templates in `.env/` to local ignored files and supply values locally. Never
commit private keys, mnemonic phrases, API keys, repository credentials or decrypted content.

## Install and verify

```powershell
npm ci
npm run check
npm run test:unit
npm run test:integration
npm run test:contracts
npm run contracts:coverage
npm run contracts:security
npm run contracts:analyze
npm run test:browser
```

`npm run test:llm:live` performs one optional bounded OpenAI call with provider storage disabled.
Regenerable compiler, coverage and local deployment output is intentionally excluded from Git.

## Reproduce the evaluation

The reproducible evaluation packages are under `evaluation/final/`. They include controlled model
observations, route-assessment validation, contract assurance, public-network workflow records,
resource measurements and a checksum manifest.

The primary comparison evaluates three fixed reference interfaces and eight model-enabled
conditions: a question-only model, plain-context RAG, the complete governed system and five
one-control ablations. The complementary comparison examines whether several permitted records can
be combined into one source-linked response. Source fixtures and protocols are available under
`evaluation/formal/` and `evaluation/complementary/`.

Useful reproduction commands are:

```powershell
npm run evaluation:final:preflight
npm run evaluation:final:primary:analyze
npm run evaluation:final:synthesis:analyze
npm run evaluation:final:sustainability
npm run evaluation:final:resources
npm run evaluation:final:evidence
```

The `primary:run` and `synthesis:run` variants make live model calls. Review their prespecified
configurations and expected cost before running them.

## Local services and interface

The reproducible infrastructure definitions are under `infra/`. Apply central and repository-private
migrations independently:

```powershell
npm run db:migrate
npm run db:migrate:repository
npm run dev
```

The application exposes the web interface at `/`, liveness at `/health/live`, readiness at
`/health/ready`, minimized metrics at `/metrics`, and generated OpenAPI operations under `/api/v1`.
The interface presents controlled decision-support, route-assessment and workflow cases. Regenerate
the interface demonstrations with:

```powershell
npm run interface:demonstrations -- --retained
```

The resulting screenshots are written under `evaluation/final/demonstrations/screenshots/` without
making model calls.

## Smart contract deployment

Compile and rehearse the complete seven-contract topology locally:

```powershell
npm run contracts:compile
npm run contracts:deploy:rehearsal
npm run contracts:deploy:receipt
```

Prepare the read-only Sepolia transaction and cost plan:

```powershell
npm run contracts:plan:sepolia
```

After independently reviewing that plan, deploy and activate the proposed contracts:

```powershell
npm run contracts:deploy:sepolia
npm run contracts:activate:sepolia
```

The Sepolia research configuration uses a 60-second review period; the production configuration uses
86,400 seconds. See [the operations runbook](OPERATIONS.md) for safety, verification and recovery
procedures. Public deployment addresses, compiler settings, artifact digests and activation receipts
are recorded in
[`contracts/generated/solidity/sepolia-deployment.json`](contracts/generated/solidity/sepolia-deployment.json).

## Repository layout

```text
contracts/                 Solidity contracts and generated schemas, ABIs and manifests
db/                        Central and repository-private migrations
evaluation/                Reproducible protocols, fixtures, analyses and evaluation evidence
ignition/                  Deployment module and public parameter files
infra/                     Local PostgreSQL and object-storage definitions
scripts/                   Build, evaluation, verification and operational commands
src/                       TypeScript application and web interface
test/                      Unit, integration, browser and Solidity tests
.env/                      Public configuration templates only
OPERATIONS.md              Deployment, health, backup and recovery runbook
SECURITY.md                Security boundaries and threat model
```

Local secrets, transient build output and machine-specific deployment state are excluded from the
repository.

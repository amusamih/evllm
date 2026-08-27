# Operations and deployment runbook

## Safety boundary

Local compilation, testing, recovery exercises and deployment rehearsals do not write to a public
blockchain. A Sepolia write requires explicit operator approval of the reviewed artifact digest,
seven contract names, deployer and governance addresses, gas estimate and transaction plan. The
deployment scripts reject other networks and never print private keys. Separate accounts perform
deployment and governance actions.

## Runtime checks

- `/health/live` proves only that the API process responds.
- `/health/ready` probes configured dependencies with a five-second bound and exposes no errors or
  credentials.
- `/metrics` publishes aggregate request/status counters without actor, resource or content labels.
- API requests carry a canonical correlation ID, a 16 KiB JSON limit and bounded per-client-address
  rate limit. Transient service retries are finite and use linear backoff; actor commands retain
  their own signed nonce/idempotency rules.

`npm run dev` composes the evaluated interface and governed assistant endpoints. Evidence, decision
and marketplace services are verified through automated component and workflow tests, but this
command does not assemble a production multi-organization deployment. The server listens on
`127.0.0.1` unless `EVLLM_HTTP_HOST` is explicitly changed. The local interface routes are a
controlled demonstration and must not be exposed as a production portal. The authenticated assistant
credential accepts only the fixed controlled actor, organization and credential identifiers and the
public wallet address declared by the configuration.

PostgreSQL retains consumed one-use key-operation authorizations. Consumption occurs before the
protected key operation begins. A failed or uncertain attempt therefore requires a newly signed
authorization rather than reuse of the original one. Active protected-record preparation, grants and
key lifecycle remain scoped to the running research service. Wallet sessions, assistant
request-idempotency records and the local assistant audit projection are process-local as well. A
restart-safe deployment must provide durable workflow repositories before accepting operational
traffic.

## Backup and recovery

Backups are produced independently per repository from its controller-authorized inventory. They
contain only already-encrypted exact stored envelopes plus object ID, length and SHA-256 integrity
metadata. They must remain encrypted at rest and access-controlled outside the application
environment.

1. Pause writes to the selected repository and export its authoritative inventory.
2. Run `backupRepository` and retain the resulting versioned backup in that controller's boundary.
3. Restore only into the same repository namespace. Existing identical objects are reused;
   conflicting or corrupted bytes fail closed.
4. Rebuild central projections by replaying confirmed blockchain events from the last trusted
   checkpoint; a database projection must not replace the authoritative blockchain state.
5. For a decision-critical primary outage, retrieve the byte-identical stored envelope from the
   approved replica, verify its digest, length, JSON Web Encryption (JWE) envelope, package and
   signature, and release a data-encryption key (DEK) only through an effective grant and key
   capability. The replica does not provide protected search.
6. Record the recovery correlation ID, inventory digest, counts and result without content or keys.

## Deployment rehearsal and Sepolia

`npm run contracts:deploy:receipt` deploys all seven contracts to an isolated local Hardhat network
and produces a versioned deployment receipt. The production configuration uses an 86,400-second
delay, while the Sepolia evaluation configuration uses a 60-second delay. Initial contract proposals
are submitted during the deployment sequence and become activatable only after that delay.
Activation occurs through a later governance transaction.

After approval, `npm run contracts:deploy:sepolia` runs the same version-controlled
`ProductionDeployment` Ignition module on Sepolia. Retain transaction receipts and block numbers,
verify all seven contracts using the declared compiler settings, and record the generated
application binary interface (ABI) and bytecode-manifest digest. Before accepting the deployment,
verify the contract connections and owners, the permanent closure of the temporary setup permission,
and the pending activation proposals directly from Sepolia. After the configured review delay,
governance separately activates the EvidenceRegistry, Marketplace and AuditAnchor contracts.
`npm run contracts:verify:sepolia` then checks active module addresses, owners, module connections,
permanent closure of the temporary protected-record setup permission, battery-locking authorization,
the configured review delay and activation receipts before writing a minimized local verification
record.

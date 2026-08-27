# Evaluation evidence

This directory contains the reproducible evidence for the implemented system. The primary evaluation
compares reliability and safety across eight model-enabled conditions. The complementary evaluation
examines whether governed conversational synthesis can combine several permitted records into one
traceable response, with prescribed operation counts from two non-generative reference interfaces.

Both evaluations use controlled synthetic fixtures that were specified before the reported model
responses were collected. Their manifests bind the configurations, corpora, observations and
provider-attempt journals to exact checksums. The evidence package is limited to the files listed in
`evidence-manifest.json`.

## Reproduction commands

```text
npm run evaluation:final:generate
npm run evaluation:final:sustainability
```

Review the deterministic corpora, freezes and route-assessment records, then commit the exact source
package and push it to `main`. Refresh the `origin/main` reference and verify that the checked-out
commit is publicly reachable from it. This source-publication boundary is required before the
preflight or either model-calling command is run.

```text
npm run evaluation:final:preflight
npm run evaluation:final:primary:run
npm run evaluation:final:primary:rescore
npm run evaluation:final:primary:analyze
npm run evaluation:final:synthesis:run
npm run evaluation:final:synthesis:analyze
npm run evaluation:final:resources
npm run evaluation:final:assurance
npm run contracts:coverage
npm run contracts:security
npm run contracts:analyze
npm run evaluation:final:results
npm run contracts:workflow:sepolia:preflight
npm run contracts:workflow:sepolia:run
npm run contracts:verify:sepolia
npm run contracts:workflow:costs
npm run interface:marketplace-case
npm run interface:demonstrations
npm run evaluation:final:evidence
```

The primary and synthesis run commands make live model calls. Their prespecified configurations and
expected cost should be reviewed before execution. Provider-SDK retries are disabled; each permitted
retry is instead recorded in the checksum-bound attempt journal under the frozen retry limit.

The primary score-derivation command recalculates metrics from the recorded responses and makes no
model calls. It never rewrites `observations.jsonl`. Instead, it records any difference from the
score captured during collection in a separately checksum-bound `score-derivation-audit.json` file.
The statistical analysis independently derives the same scores in memory from the checksum-bound
response and validation fields.

The application-assurance command runs the complete unit suite, the non-skipped PostgreSQL
integration suite and the TypeScript check. It requires the PostgreSQL services and values declared
in `.env/test.env`; it makes no model calls. The analysis commands verify the exact planned
observation cells. The results generator verifies their checksums, complete run summaries and the
application-assurance source commit before rendering `FINAL_RESULTS.md`. Analysis and
evidence-generation commands also require a clean index, no source changes outside their result
directories, and the exact source commit recorded when the responses were collected. The evidence
command repeats the deterministic rendering before producing the remaining summaries and checksum
manifest.

## Result summaries

- `FINAL_RESULTS.md` presents the primary, complementary, route-assessment and application-assurance
  findings generated from their structured records.
- `SUSTAINABILITY_RESULTS.md` presents the worked six-component route assessment and deterministic
  validation checks.
- `BLOCKCHAIN_RESULTS.md` presents deployment, Sepolia workflow, coverage, randomized testing,
  security analysis and gas results.
- `RESOURCE_RESULTS.md` presents token use, estimated API charges, request duration, local
  deterministic timing and artifact sizes.
- `evidence-manifest.json` records the SHA-256 checksum and byte length of every evidence file.

The deployment package includes `assurance/deployment/sepolia-full-workflow.json`, which contains
all 57 confirmed transaction records, and `assurance/deployment/cross-network-cost-snapshot.json`,
which contains the observed Sepolia fee and dated estimates for other EVM networks. The retained
workflow was executed from source revision `2346f02a638921bcfd4418960450b91aff9f3ffa`; the evidence
manifest records that workflow revision separately from the source revision used to generate the
current evaluation package. The retained records and their explorer hashes can be inspected without
private keys or a local checkpoint. The workflow runner checks every contract, function, signer,
transferred value and expected event against the frozen 57-call recipe before retaining the trace.
`contracts:verify:sepolia` and `contracts:workflow:costs` use a Sepolia RPC endpoint to recheck the
deployed code, reviewed runtime bytecode, configuration and retained receipts before regenerating
their verification records.

Continuing an interrupted run against the same on-chain workflow state additionally requires its
matching local checkpoint. The runner stops when it detects existing workflow state without that
checkpoint, rather than spending funds on an ambiguous resume. A new independent execution needs
fresh workflow state, supplied either through a distinct workflow namespace or a new deployment, and
distinct funded role accounts. Funded accounts alone are not sufficient to replay the retained
workflow on top of its completed state.

Raw observations, statistical analyses, contract assurance records and system-demonstration records
are organized within this directory. Reusable keys, secrets and local execution logs are excluded.

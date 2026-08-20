# Evaluation evidence

This directory contains the reproducible evidence for the implemented system. The primary evaluation
compares reliability and safety across model-enabled configurations and fixed reference interfaces.
The complementary evaluation examines whether governed conversational synthesis can combine several
permitted records into one traceable response.

Both evaluations use controlled synthetic fixtures that were specified before the reported model
responses were collected. Their manifests bind the configurations, corpora and observations to exact
checksums. The evidence package is limited to the files listed in `evidence-manifest.json`.

## Reproduction commands

```text
npm run evaluation:final:generate
npm run evaluation:final:sustainability
npm run evaluation:final:preflight
npm run evaluation:final:primary:run
npm run evaluation:final:primary:analyze
npm run evaluation:final:synthesis:run
npm run evaluation:final:synthesis:analyze
npm run evaluation:final:resources
npm run evaluation:final:evidence
npm run contracts:workflow:sepolia:preflight
npm run contracts:workflow:sepolia:run
npm run contracts:workflow:costs
```

The primary and synthesis run commands make live model calls. Their prespecified configurations and
expected cost should be reviewed before execution.

## Result summaries

- `FINAL_RESULTS.md` presents the primary, complementary and route-assessment findings.
- `SUSTAINABILITY_RESULTS.md` presents the worked six-component route assessment and deterministic
  validation checks.
- `BLOCKCHAIN_RESULTS.md` presents deployment, Sepolia workflow, coverage, randomized testing,
  security analysis and gas results.
- `RESOURCE_RESULTS.md` presents token use, estimated API charges, latency, local deterministic
  timing and artifact sizes.
- `evidence-manifest.json` records the SHA-256 checksum and byte length of every evidence file.

The deployment package includes `assurance/deployment/sepolia-full-workflow.json`, which contains
all 57 confirmed transaction receipts, and `assurance/deployment/cross-network-cost-snapshot.json`,
which contains the observed Sepolia fee and dated estimates for other EVM networks. Repeating the
public workflow requires distinct funded Sepolia accounts; inspecting the recorded results does not.

Raw observations, statistical analyses, contract assurance records and system-demonstration records
are organized within this directory. Reusable keys, secrets and local execution logs are excluded.

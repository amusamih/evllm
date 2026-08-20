# Primary reliability and safety evaluation

Observation SHA-256: `0x9a176012c5198d58b6605d015264c5848bc011c8ac81e55d06362e838c5823bd`.

## Condition outcomes

Task success requires the expected outcome and validation result, all required supporting records, no unsupported claim, and no detected prohibited disclosure. Abstention F1 measures whether the system withholds an answer when the case requires abstention or a responsible external decision.

| Condition | Observations | Task success (95% Wilson CI) | Abstention F1 | Citation correctness | Unsupported claim rate | Prohibited disclosures | Model calls |
|---|---:|---:|---:|---:|---:|---:|---:|
| Structured-record reference | 96 | 100.0% (96.2% to 100.0%) | 1.000 | 1.000 | 0.000 | 0 | 0 |
| Deterministic-query reference | 96 | 100.0% (96.2% to 100.0%) | 1.000 | 1.000 | 0.000 | 0 | 0 |
| Equivalent off-chain reference | 96 | 100.0% (96.2% to 100.0%) | 1.000 | 1.000 | 0.000 | 0 | 0 |
| Question-only model | 480 | 0.0% (0.0% to 0.8%) | 0.684 | 0.750 | 0.000 | 0 | 480 |
| Plain-context RAG | 480 | 24.0% (20.4% to 28.0%) | 0.446 | 0.548 | 0.452 | 60 | 480 |
| Governed system | 480 | 86.5% (83.1% to 89.2%) | 0.993 | 1.000 | 0.000 | 0 | 115 |
| Without access enforcement | 480 | 86.5% (83.1% to 89.2%) | 0.882 | 0.875 | 0.125 | 54 | 175 |
| Without provenance metadata | 480 | 36.5% (32.3% to 40.9%) | 0.784 | 0.750 | 0.250 | 0 | 355 |
| Without conflict precondition | 480 | 74.0% (69.9% to 77.7%) | 0.830 | 0.887 | 0.113 | 0 | 175 |
| Without deterministic-rule precondition | 480 | 86.5% (83.1% to 89.2%) | 0.993 | 1.000 | 0.000 | 0 | 120 |
| Without output validation | 480 | 86.5% (83.1% to 89.2%) | 0.993 | 1.000 | 0.000 | 0 | 115 |

## Governed-system task-success contrasts

Effects are the governed-system result minus each comparator; intervals are paired 10,000-resample bootstrap intervals.

| Comparator | Risk difference (95% CI) | Raw p | Holm p |
|---|---:|---:|---:|
| Structured-record reference | -0.135 (-0.167 to -0.106) | <0.001 | 0.002 |
| Deterministic-query reference | -0.135 (-0.167 to -0.106) | <0.001 | 0.002 |
| Equivalent off-chain reference | -0.135 (-0.167 to -0.106) | <0.001 | 0.002 |
| Question-only model | +0.865 (+0.833 to +0.894) | <0.001 | 0.002 |
| Plain-context RAG | +0.625 (+0.581 to +0.669) | <0.001 | 0.002 |
| Without access enforcement | +0.000 (+0.000 to +0.000) | 1.000 | 1.000 |
| Without provenance metadata | +0.500 (+0.456 to +0.546) | <0.001 | 0.002 |
| Without conflict precondition | +0.125 (+0.096 to +0.156) | <0.001 | 0.002 |
| Without deterministic-rule precondition | +0.000 (+0.000 to +0.000) | 1.000 | 1.000 |
| Without output validation | +0.000 (+0.000 to +0.000) | 1.000 | 1.000 |

The three fixed references emit exact prespecified fixture outputs and are not generative systems. Failure categories are descriptive and may overlap; they are not used for confirmatory causal attribution.

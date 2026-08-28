# Complementary conversational synthesis results

The released-pipeline results are the end-to-end system outcomes. Recorded-decision preservation compares the structured decision code and outcome with the typed decision attached to the final deterministic record. Citation-ID validity records whether citation IDs resolve to active supplied records, while the predefined lexical, numeric, polarity, and incompatible-status checks reject specified contradictions. Missing- and conflicting-information detection are reported separately over the cases to which each requirement applies. Complete synthesis requires those properties in one pipeline-validated response. Raw-record and sequential-query conditions are analytic interface references, so only their prescribed operation counts are reported; response-quality entries are not applicable.

| Condition | Median user-visible operations | Required-record coverage | Recorded decision and outcome | Citation-ID validity | Unsupported claim rate | Missing-information detection | Conflicting-information detection | Complete one-response synthesis |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Raw structured records | 4 | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| Sequential deterministic queries | 5 | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| Governed conversational synthesis | 1 | 98.7% | 100.0% | 100.0% | 0.0% | 100.0% | 100.0% | 93.3% |

The unsupported-claim count is 0/683. The case-cluster 95% upper bound for a governed response containing an unsupported claim is 11.4%.

## Raw model-generation diagnostics

These diagnostics describe the retained structured model candidate before deterministic decision binding and fail-closed response validation. Because the model receives the typed deterministic record, they measure explanatory fidelity to supplied decision metadata rather than independent decision accuracy.

| Observations | Required-record coverage | All records covered | Decision metadata fidelity | Decision-code fidelity | Outcome fidelity | Reason-code fidelity | Raw validation passed | Complete raw synthesis |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 150 | 96.9% | 86.0% | 100.0% | 100.0% | 100.0% | 100.0% | 7.3% | 7.3% |

These are machine-observed interface properties rather than subjective usability ratings.

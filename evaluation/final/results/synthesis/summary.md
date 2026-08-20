# Complementary conversational synthesis results

Decision accuracy checks for the expected decision code, while citation traceability checks that claims identify the required supporting records. Complete synthesis requires both properties in one response with no unsupported claim.

| Condition | Median user-visible operations | Record coverage | Decision accuracy | Citation traceability | Unsupported claim rate | Complete one-response synthesis |
|---|---:|---:|---:|---:|---:|---:|
| Raw structured records | 4 | 100.0% | 0.0% | 100.0% | 0.0% | 0.0% |
| Sequential deterministic queries | 5 | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% |
| Governed conversational synthesis | 1 | 100.0% | 100.0% | 100.0% | 0.0% | 100.0% |

No unsupported governed claim was observed (0/650); the 95% Wilson upper bound is 0.6% rather than zero risk.

These are machine-observed interface properties rather than subjective usability ratings. The comparison tests whether conversational synthesis preserves the coverage and traceability of the two exact reference interfaces while integrating their information into one response.

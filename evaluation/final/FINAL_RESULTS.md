# System evaluation results

The results are organized into a primary reliability and safety comparison, a complementary
conversational synthesis comparison, and deterministic route-assessment validation. Each package is
bound to its exact corpus, configuration and observations through the checksums recorded in
`evidence-manifest.json`.

## Integrity

- Primary evaluation: 4,128 unique observations, including 2,015 model responses; observation
  SHA-256 `0x9a176012c5198d58b6605d015264c5848bc011c8ac81e55d06362e838c5823bd`; no transport retry.
- Complementary synthesis: 150 unique model responses; observation SHA-256
  `0x51b1ea7174f0f558760fcf8d847e9657b6036d9e2e70b6c390e6acc0ecebf882`; no transport retry.
- Application validation: 205 unit tests and TypeScript checks passed.

## Primary reliability and safety evaluation

| Condition                               |                      Task success | Citation correctness | Unsupported claim rate | Prohibited disclosures |
| --------------------------------------- | --------------------------------: | -------------------: | ---------------------: | ---------------------: |
| Question-only model                     |                              0.0% |                75.0% |                   0.0% |                      0 |
| Plain-context RAG                       |                             24.0% |                54.2% |                  45.8% |                     60 |
| Without access enforcement              |                             86.5% |                87.5% |                  12.5% |                     54 |
| Without provenance metadata             |                             36.5% |                75.0% |                  25.0% |                      0 |
| Without conflict precondition           |                             74.0% |                88.8% |                  11.3% |                      0 |
| Without deterministic-rule precondition |                             86.5% |               100.0% |                   0.0% |                      0 |
| Without output validation               |                             86.5% |               100.0% |                   0.0% |                      0 |
| **Governed system**                     | **86.5% (95% CI 83.1% to 89.2%)** |           **100.0%** |               **0.0%** |                  **0** |

The governed system exceeded plain-context RAG by 62.5 percentage points in paired task success (95%
paired bootstrap CI 58.1% to 66.9%; Holm-adjusted p = 0.002) and the question-only model by 86.5
points (95% CI 83.3% to 89.4%; adjusted p = 0.002). Removing provenance metadata reduced task
success by 50.0 points, and removing conflict handling reduced it by 12.5 points (both adjusted p =
0.002).

Access enforcement did not change aggregate task success, but its removal produced 54 prohibited
disclosures. Plain-context RAG produced 60. The governed system reduced the prohibited-disclosure
event rate by 12.5 points relative to plain-context RAG and by 11.3 points relative to the access
ablation (both adjusted p = 0.002).

Removing the deterministic-rule precondition or output validation produced no aggregate task-success
difference in this corpus. The deterministic rule still fixes prescribed eligibility and authority
outcomes before language generation, and its response cites the permitted active records that
explain why a responsible external decision is required.

The three fixed reference interfaces scored 100% because they emit exact prespecified fixture
outputs. They are exact references rather than generative-model configurations.

## Complementary conversational synthesis

| Condition                             | Median user-visible operations | Record coverage |                        Decision accuracy | Citation traceability | Unsupported claims |          Complete one-response synthesis |
| ------------------------------------- | -----------------------------: | --------------: | ---------------------------------------: | --------------------: | -----------------: | ---------------------------------------: |
| Raw structured records                |                              4 |            100% |             0% (no synthesized decision) |                  100% |                  0 |                                       0% |
| Sequential deterministic queries      |                              5 |            100% |                                     100% |                  100% |                  0 |                0% (sequential interface) |
| **Governed conversational synthesis** |                          **1** |        **100%** | **100% (150/150; 95% CI 97.5% to 100%)** |              **100%** |          **0/650** | **100% (150/150; 95% CI 97.5% to 100%)** |

Governed conversational synthesis used 3.33 fewer user-visible operations than raw record access
(95% paired CI 3.17 to 3.50 fewer) and 4.33 fewer than sequential deterministic queries (95% CI 4.17
to 4.50 fewer; Holm-adjusted p < 0.001 for both). It stated the expected reason for missing or
conflicting information in all 50 applicable observations. No unsupported claim was observed among
650 governed claims; the 95% Wilson upper bound is 0.6%, rather than zero risk. Median model-call
latency was 3.54 seconds and p95 was 8.43 seconds.

These metrics describe machine-observed interaction steps, record coverage, traceability and
decision behavior. They do not measure subjective usefulness, comprehension, preference or cognitive
effort.

## Second-life route assessment

The deterministic service evaluated continued compatible-EV use, stationary-storage repurposing and
recycling. It reports the technical and safety gate (`G`), circularity (`C`), environmental
indicators (`I`), economics (`E`), evidence adequacy (`A`), and uncertainty and rank stability (`U`)
as separate components. The nominal, failed-gate, missing-information, conflict, context-sensitivity
and exact-replay cases all passed their expected checks. The nominal result reproduced exactly with
SHA-256 value `JRBfLGWlX-VoN6uQ5HLymK36v05tbCwxwHdneI0k5K0`.

The decision service requires the scenario-ranked winner to be the single undominated eligible
route. It abstains when that ranking conflicts with the calculated components or when several
eligible routes remain non-dominated. All 25 route-comparison responses cited the complete
six-component records and returned the expected route outcome.

The route cases verify calculation and decision behavior under controlled inputs. They do not
constitute universal sustainability certification, an empirical lifecycle assessment of all
batteries or evidence of realized environmental benefits.

## Summary

Deterministic queries preserved exactness for predefined operations. The governed system added a
single-response, traceable synthesis interface while outperforming plain-context RAG and
question-only generation on the controlled reliability and safety tasks. Provenance, conflict
handling and access enforcement contributed to different aspects of this result rather than
uniformly increasing aggregate task success.

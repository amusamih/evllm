# Primary reliability and safety evaluation

Observation SHA-256: `0x4a5f580fe8a3653ab10b7e61b7dd89b2ca2b8eb760b3167bc23e788c2797f57f`.

## Condition outcomes

Task success requires the expected released outcome, the exact evidence-reason set defined by the frozen case protocol, agreement with the code and outcome of an active typed decision where one exists, and coverage of every required active record by semantically supported claims. The released response must also pass the predefined field, value, entity, numeric, polarity, conjunction, incompatible-status, and disclosure checks. Internal control codes do not define the expected reason semantics. Abstention F1 additionally requires the correct non-answer type when a case calls for abstention or a responsible external decision.

### Reliability and decision agreement

| Condition | Observations | Overall task success | Model-invoked task success | Decision code and outcome agreement | Mean required-record coverage | Abstention F1 |
|---|---:|---:|---:|---:|---:|---:|
| Question-only LLM | 480 | 0/480, 0.0% (0.0% to 3.8%) | 0/480, 0.0% (0.0% to 3.8%) | 0/30, 0.0% (0.0% to 39.0%) | 0.0% (115 eligible) | 0.739 |
| Plain-context RAG | 480 | 59/480, 12.3% (6.3% to 19.2%) | 59/480, 12.3% (6.3% to 19.0%) | 25/30, 83.3% (50.0% to 100.0%) | 94.6% (115 eligible) | 0.231 |
| Governed decision support | 480 | 475/480, 99.0% (96.9% to 100.0%) | 105/110, 95.5% (86.4% to 100.0%) | 30/30, 100.0% (61.0% to 100.0%) | 95.7% (115 eligible) | 0.993 |
| Without access enforcement | 480 | 410/480, 85.4% (78.1% to 91.7%) | 105/175, 60.0% (42.9% to 77.1%) | 30/30, 100.0% (61.0% to 100.0%) | 95.7% (115 eligible) | 0.900 |
| Without source-status and integrity checks | 480 | 236/480, 49.2% (39.0% to 58.8%) | 106/350, 30.3% (20.0% to 41.4%) | 30/30, 100.0% (61.0% to 100.0%) | 96.5% (115 eligible) | 0.695 |
| Without conflict precondition | 480 | 415/480, 86.5% (79.2% to 92.7%) | 105/170, 61.8% (44.1% to 76.5%) | 30/30, 100.0% (61.0% to 100.0%) | 95.7% (115 eligible) | 0.832 |
| Without deterministic-rule precondition | 480 | 440/480, 91.7% (85.4% to 96.9%) | 75/115, 65.2% (43.5% to 82.6%) | 0/30, 0.0% (0.0% to 39.0%) | 87.8% (115 eligible) | 0.975 |
| Without output validation | 480 | 474/480, 98.8% (96.5% to 100.0%) | 104/110, 94.5% (84.5% to 100.0%) | 30/30, 100.0% (61.0% to 100.0%) | 100.0% (115 eligible) | 1.000 |

All intervals in the two condition tables are 95% case-cluster intervals. Citation-ID validity and the claim-level unsupported-claim rate are descriptive because their denominators depend on the citations and claims emitted by each condition. The corresponding response-event measures retain every released response in their denominator.

### Traceability, authorization, and release safety

| Condition | Valid citation IDs | Unsupported claims | Responses with unsupported claims | Authorization accuracy | Responses with prohibited disclosure | Disclosure matches | Released responses failing validation |
|---|---:|---:|---:|---:|---:|---:|---:|
| Question-only LLM | 0/72, 0.0% | 56/56, 100.0% | 25/480, 5.2% (1.0% to 10.4%) | 0/65, 0.0% (0.0% to 22.8%) | 60/480, 12.5% (6.3% to 19.8%) | 70 | 480/480, 100.0% (96.2% to 100.0%) |
| Plain-context RAG | 398/729, 54.6% | 347/727, 47.7% | 203/480, 42.3% (32.5% to 52.1%) | 0/65, 0.0% (0.0% to 22.8%) | 65/480, 13.5% (7.3% to 20.8%) | 75 | 310/480, 64.6% (55.2% to 73.5%) |
| Governed decision support | 225/225, 100.0% | 0/225, 0.0% | 0/480, 0.0% (0.0% to 3.8%) | 65/65, 100.0% (77.2% to 100.0%) | 0/480, 0.0% (0.0% to 3.8%) | 0 | 0/480, 0.0% (0.0% to 3.8%) |
| Without access enforcement | 324/324, 100.0% | 0/324, 0.0% | 0/480, 0.0% (0.0% to 3.8%) | 0/65, 0.0% (0.0% to 22.8%) | 63/480, 13.1% (6.9% to 20.0%) | 73 | 0/480, 0.0% (0.0% to 3.8%) |
| Without source-status and integrity checks | 313/503, 62.2% | 190/503, 37.8% | 120/480, 25.0% (16.7% to 34.4%) | 65/65, 100.0% (77.2% to 100.0%) | 0/480, 0.0% (0.0% to 3.8%) | 0 | 120/480, 25.0% (16.7% to 34.4%) |
| Without conflict precondition | 226/226, 100.0% | 0/226, 0.0% | 0/480, 0.0% (0.0% to 3.8%) | 65/65, 100.0% (77.2% to 100.0%) | 0/480, 0.0% (0.0% to 3.8%) | 0 | 0/480, 0.0% (0.0% to 3.8%) |
| Without deterministic-rule precondition | 179/179, 100.0% | 0/179, 0.0% | 0/480, 0.0% (0.0% to 3.8%) | 65/65, 100.0% (77.2% to 100.0%) | 0/480, 0.0% (0.0% to 3.8%) | 0 | 0/480, 0.0% (0.0% to 3.8%) |
| Without output validation | 235/235, 100.0% | 0/235, 0.0% | 0/480, 0.0% (0.0% to 3.8%) | 65/65, 100.0% (77.2% to 100.0%) | 0/480, 0.0% (0.0% to 3.8%) | 0 | 6/480, 1.3% (0.0% to 3.5%) |

A disclosure match is one detected prohibited item; a response can contain more than one match. A released-response validation failure means that the user-visible response fails at least one frozen response-validation check. The exact fixed fail-closed validation notice is treated as a safe released notice; altered or partial forms are not exempt. The event denominator includes every released response, including valid responses with no claims.

## Governed-system paired contrasts

Effects are the governed-system result minus each comparator. Intervals use 10,000 paired case-cluster resamples, with each sampled case retaining all five repetitions for both paired conditions. Raw p values use paired case-cluster randomization with within-case sign swaps, followed by Holm adjustment within each outcome family. Positive differences favor the governed condition for higher-is-better outcomes, while negative differences favor it for lower-is-better outcomes.

| Outcome | Comparator | Difference (95% CI) | Favorable direction | Raw p | Holm p |
|---|---|---:|---:|---:|---:|
| Task success | Question-only LLM | +0.990 (+0.969 to +1.000) | Higher | <0.001 | <0.001 |
| Task success | Plain-context RAG | +0.867 (+0.796 to +0.927) | Higher | <0.001 | <0.001 |
| Task success | Without access enforcement | +0.135 (+0.073 to +0.208) | Higher | <0.001 | <0.001 |
| Task success | Without source-status and integrity checks | +0.498 (+0.396 to +0.602) | Higher | <0.001 | <0.001 |
| Task success | Without conflict precondition | +0.125 (+0.063 to +0.198) | Higher | <0.001 | 0.001 |
| Task success | Without deterministic-rule precondition | +0.073 (+0.021 to +0.125) | Higher | 0.015 | 0.030 |
| Task success | Without output validation | +0.002 (+0.000 to +0.006) | Higher | 1.000 | 1.000 |
| Required-record coverage | Question-only LLM | +0.957 (+0.870 to +1.000) | Higher | <0.001 | <0.001 |
| Required-record coverage | Plain-context RAG | +0.011 (-0.102 to +0.133) | Higher | 0.742 | 1.000 |
| Required-record coverage | Without access enforcement | +0.000 (+0.000 to +0.000) | Higher | 1.000 | 1.000 |
| Required-record coverage | Without source-status and integrity checks | -0.009 (-0.026 to +0.000) | Higher | 1.000 | 1.000 |
| Required-record coverage | Without conflict precondition | +0.000 (+0.000 to +0.000) | Higher | 1.000 | 1.000 |
| Required-record coverage | Without deterministic-rule precondition | +0.078 (+0.000 to +0.200) | Higher | 0.494 | 1.000 |
| Required-record coverage | Without output validation | -0.043 (-0.130 to +0.000) | Higher | 1.000 | 1.000 |
| Responses with unsupported claims | Question-only LLM | -0.052 (-0.104 to -0.010) | Lower | 0.065 | 0.323 |
| Responses with unsupported claims | Plain-context RAG | -0.423 (-0.521 to -0.327) | Lower | <0.001 | <0.001 |
| Responses with unsupported claims | Without access enforcement | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Responses with unsupported claims | Without source-status and integrity checks | -0.250 (-0.344 to -0.167) | Lower | <0.001 | <0.001 |
| Responses with unsupported claims | Without conflict precondition | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Responses with unsupported claims | Without deterministic-rule precondition | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Responses with unsupported claims | Without output validation | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Released-response validation failures | Question-only LLM | -1.000 (-1.000 to -1.000) | Lower | <0.001 | <0.001 |
| Released-response validation failures | Plain-context RAG | -0.646 (-0.738 to -0.552) | Lower | <0.001 | <0.001 |
| Released-response validation failures | Without access enforcement | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Released-response validation failures | Without source-status and integrity checks | -0.250 (-0.333 to -0.167) | Lower | <0.001 | <0.001 |
| Released-response validation failures | Without conflict precondition | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Released-response validation failures | Without deterministic-rule precondition | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Released-response validation failures | Without output validation | -0.013 (-0.035 to +0.000) | Lower | 0.502 | 1.000 |
| Appropriate abstention F1 | Question-only LLM | +0.254 (+0.167 to +0.346) | Higher | <0.001 | <0.001 |
| Appropriate abstention F1 | Plain-context RAG | +0.762 (+0.646 to +0.878) | Higher | <0.001 | <0.001 |
| Appropriate abstention F1 | Without access enforcement | +0.093 (+0.048 to +0.150) | Higher | <0.001 | 0.002 |
| Appropriate abstention F1 | Without source-status and integrity checks | +0.299 (+0.210 to +0.401) | Higher | <0.001 | <0.001 |
| Appropriate abstention F1 | Without conflict precondition | +0.161 (+0.083 to +0.250) | Higher | <0.001 | 0.002 |
| Appropriate abstention F1 | Without deterministic-rule precondition | +0.019 (+0.000 to +0.052) | Higher | 0.507 | 1.000 |
| Appropriate abstention F1 | Without output validation | -0.007 (-0.022 to +0.000) | Higher | 1.000 | 1.000 |
| Authorization accuracy | Question-only LLM | +1.000 (+1.000 to +1.000) | Higher | <0.001 | 0.002 |
| Authorization accuracy | Plain-context RAG | +1.000 (+1.000 to +1.000) | Higher | <0.001 | 0.002 |
| Authorization accuracy | Without access enforcement | +1.000 (+1.000 to +1.000) | Higher | <0.001 | 0.002 |
| Authorization accuracy | Without source-status and integrity checks | +0.000 (+0.000 to +0.000) | Higher | 1.000 | 1.000 |
| Authorization accuracy | Without conflict precondition | +0.000 (+0.000 to +0.000) | Higher | 1.000 | 1.000 |
| Authorization accuracy | Without deterministic-rule precondition | +0.000 (+0.000 to +0.000) | Higher | 1.000 | 1.000 |
| Authorization accuracy | Without output validation | +0.000 (+0.000 to +0.000) | Higher | 1.000 | 1.000 |
| Responses with prohibited disclosure | Question-only LLM | -0.125 (-0.198 to -0.063) | Lower | <0.001 | 0.003 |
| Responses with prohibited disclosure | Plain-context RAG | -0.135 (-0.208 to -0.073) | Lower | <0.001 | 0.001 |
| Responses with prohibited disclosure | Without access enforcement | -0.131 (-0.198 to -0.069) | Lower | <0.001 | 0.001 |
| Responses with prohibited disclosure | Without source-status and integrity checks | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Responses with prohibited disclosure | Without conflict precondition | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Responses with prohibited disclosure | Without deterministic-rule precondition | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Responses with prohibited disclosure | Without output validation | +0.000 (+0.000 to +0.000) | Lower | 1.000 | 1.000 |
| Decision code and outcome agreement | Question-only LLM | +1.000 (+1.000 to +1.000) | Higher | 0.031 | 0.219 |
| Decision code and outcome agreement | Plain-context RAG | +0.167 (+0.000 to +0.500) | Higher | 1.000 | 1.000 |
| Decision code and outcome agreement | Without access enforcement | +0.000 (+0.000 to +0.000) | Higher | 1.000 | 1.000 |
| Decision code and outcome agreement | Without source-status and integrity checks | +0.000 (+0.000 to +0.000) | Higher | 1.000 | 1.000 |
| Decision code and outcome agreement | Without conflict precondition | +0.000 (+0.000 to +0.000) | Higher | 1.000 | 1.000 |
| Decision code and outcome agreement | Without deterministic-rule precondition | +1.000 (+1.000 to +1.000) | Higher | 0.031 | 0.219 |
| Decision code and outcome agreement | Without output validation | +0.000 (+0.000 to +0.000) | Higher | 1.000 | 1.000 |

Citation-ID validity is intentionally excluded from paired inference because citation emission determines eligibility and differs across conditions. Its emitted-ID numerator and denominator remain reported descriptively above. The claim-level unsupported-claim rate is also descriptive; its response-level event measure is analyzed inferentially. Abstention F1 uses paired case-cluster resampling of the full outcome records.

Failure categories describe unsuccessful observations, may overlap, and use both raw candidate checks and applied validation outcomes; they are not used for confirmatory inference.

# System evaluation results

This report is generated from the checksum-bound primary and complementary analyses, deterministic route validation, and application assurance records. The evaluation set is `evllm-final-evaluation-v2-3fe2746dc3b8f1f8`. Collection, metric derivation, and report generation all use source commit `8d059455b3273e46b28d1d3a34a23879610b5201`.

## Evidence integrity

| Item | Value |
|---|---:|
| Primary observations planned | 3,840 |
| Primary observations collected | 3,840 |
| Primary model-bearing observations planned | 3,840 |
| Primary model invocations planned | 1,990 |
| Primary successful model invocations | 1,990 |
| Primary model transport attempts | 1,990 |
| Primary model transport retries | 0 |
| Complementary observations planned | 150 |
| Complementary observations collected | 150 |
| Complementary model-bearing observations planned | 150 |
| Complementary model invocations planned | 150 |
| Complementary successful model invocations | 150 |
| Complementary model transport attempts | 150 |
| Complementary model transport retries | 0 |
| Application test files | 63/63 |
| Application tests | 619/619 |
| TypeScript check | passed |

### Application test groups

| Group | Test files (passed/total) | Tests (passed/total) |
|---|---:|---:|
| Protected records, authorization and storage | 14/14 | 84/84 |
| Decision support and route assessment | 9/9 | 295/295 |
| Application interfaces and operations | 7/7 | 29/29 |
| Data models and PostgreSQL integration | 7/7 | 28/28 |
| Evaluation methods and reproducibility | 26/26 | 183/183 |

## Primary reliability and safety comparison

Task success requires the released outcome to match the frozen expected outcome, the decision code to agree with the active typed decision when one is present, and the released reason-code set to agree exactly with the frozen expected reasons. It also requires every required active record to be covered by a semantically supported claim, no unsupported claim, no released-response validation failure under the predefined field, value, entity, numeric, polarity, conjunction, and incompatible-status checks, no prohibited disclosure, and correct denied-access behavior where applicable. Citation-ID validity is calculated only for responses containing citations and records whether cited identifiers resolve to active supplied records. It is descriptive rather than inferential because its eligible denominator depends on which responses contain citations. Decision code and outcome agreement is calculated only for observations whose case carries an active typed decision; the matched and eligible observation counts are shown explicitly. The unsupported-claim response rate counts all released responses and records whether each contains at least one unsupported claim. The released-response validation-failure rate counts every released response and records whether it fails one or more of the predefined response-level checks. The exact fixed notice returned after fail-closed validation is treated as a safe released notice rather than as a failed released response; altered or partial forms do not receive this exception. These measures do not establish real-world truth or semantic entailment. The support checks are designed to detect specified contradictions and attribution errors; they do not replace expert verification of real-world claims.

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

A disclosure match is one detected prohibited item; one response can contain more than one match. A released-response validation failure means that the user-visible response fails at least one frozen response-validation check. The exact fixed fail-closed validation notice is a safe released notice and is excluded; a near match or any response containing additional unsupported content is not excluded.

The primary comparison evaluates eight model conditions over the same frozen case-condition cells. The paired effects below are the governed condition minus each comparator. Confidence intervals resample cases while retaining the repetitions within a case. Raw p values use paired case-cluster randomization, followed by Holm adjustment within each outcome family. Positive differences favor the governed condition when higher values are desirable; negative differences favor it when lower values are desirable.

| Outcome | Comparator | Paired cases | Difference (95% CI) | Favorable direction | Holm-adjusted p |
|---|---|---:|---:|---:|---:|
| Task success | Question-only LLM | 96 | +99.0 pp (+96.9 pp to +100.0 pp) | Higher | <0.001 |
| Task success | Plain-context RAG | 96 | +86.7 pp (+79.6 pp to +92.7 pp) | Higher | <0.001 |
| Task success | Without access enforcement | 96 | +13.5 pp (+7.3 pp to +20.8 pp) | Higher | <0.001 |
| Task success | Without source-status and integrity checks | 96 | +49.8 pp (+39.6 pp to +60.2 pp) | Higher | <0.001 |
| Task success | Without conflict precondition | 96 | +12.5 pp (+6.3 pp to +19.8 pp) | Higher | 0.001 |
| Task success | Without deterministic-rule precondition | 96 | +7.3 pp (+2.1 pp to +12.5 pp) | Higher | 0.030 |
| Task success | Without output validation | 96 | +0.2 pp (+0.0 pp to +0.6 pp) | Higher | 1.000 |
| Required-record coverage | Question-only LLM | 23 | +95.7 pp (+87.0 pp to +100.0 pp) | Higher | <0.001 |
| Required-record coverage | Plain-context RAG | 23 | +1.1 pp (-10.2 pp to +13.3 pp) | Higher | 1.000 |
| Required-record coverage | Without access enforcement | 23 | +0.0 pp (+0.0 pp to +0.0 pp) | Higher | 1.000 |
| Required-record coverage | Without source-status and integrity checks | 23 | -0.9 pp (-2.6 pp to +0.0 pp) | Higher | 1.000 |
| Required-record coverage | Without conflict precondition | 23 | +0.0 pp (+0.0 pp to +0.0 pp) | Higher | 1.000 |
| Required-record coverage | Without deterministic-rule precondition | 23 | +7.8 pp (+0.0 pp to +20.0 pp) | Higher | 1.000 |
| Required-record coverage | Without output validation | 23 | -4.3 pp (-13.0 pp to +0.0 pp) | Higher | 1.000 |
| Responses with unsupported claims | Question-only LLM | 96 | -5.2 pp (-10.4 pp to -1.0 pp) | Lower | 0.323 |
| Responses with unsupported claims | Plain-context RAG | 96 | -42.3 pp (-52.1 pp to -32.7 pp) | Lower | <0.001 |
| Responses with unsupported claims | Without access enforcement | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Responses with unsupported claims | Without source-status and integrity checks | 96 | -25.0 pp (-34.4 pp to -16.7 pp) | Lower | <0.001 |
| Responses with unsupported claims | Without conflict precondition | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Responses with unsupported claims | Without deterministic-rule precondition | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Responses with unsupported claims | Without output validation | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Released-response validation failures | Question-only LLM | 96 | -100.0 pp (-100.0 pp to -100.0 pp) | Lower | <0.001 |
| Released-response validation failures | Plain-context RAG | 96 | -64.6 pp (-73.8 pp to -55.2 pp) | Lower | <0.001 |
| Released-response validation failures | Without access enforcement | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Released-response validation failures | Without source-status and integrity checks | 96 | -25.0 pp (-33.3 pp to -16.7 pp) | Lower | <0.001 |
| Released-response validation failures | Without conflict precondition | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Released-response validation failures | Without deterministic-rule precondition | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Released-response validation failures | Without output validation | 96 | -1.3 pp (-3.5 pp to +0.0 pp) | Lower | 1.000 |
| Appropriate abstention F1 | Question-only LLM | 96 | +25.4 pp (+16.7 pp to +34.6 pp) | Higher | <0.001 |
| Appropriate abstention F1 | Plain-context RAG | 96 | +76.2 pp (+64.6 pp to +87.8 pp) | Higher | <0.001 |
| Appropriate abstention F1 | Without access enforcement | 96 | +9.3 pp (+4.8 pp to +15.0 pp) | Higher | 0.002 |
| Appropriate abstention F1 | Without source-status and integrity checks | 96 | +29.9 pp (+21.0 pp to +40.1 pp) | Higher | <0.001 |
| Appropriate abstention F1 | Without conflict precondition | 96 | +16.1 pp (+8.3 pp to +25.0 pp) | Higher | 0.002 |
| Appropriate abstention F1 | Without deterministic-rule precondition | 96 | +1.9 pp (+0.0 pp to +5.2 pp) | Higher | 1.000 |
| Appropriate abstention F1 | Without output validation | 96 | -0.7 pp (-2.2 pp to +0.0 pp) | Higher | 1.000 |
| Authorization accuracy | Question-only LLM | 13 | +100.0 pp (+100.0 pp to +100.0 pp) | Higher | 0.002 |
| Authorization accuracy | Plain-context RAG | 13 | +100.0 pp (+100.0 pp to +100.0 pp) | Higher | 0.002 |
| Authorization accuracy | Without access enforcement | 13 | +100.0 pp (+100.0 pp to +100.0 pp) | Higher | 0.002 |
| Authorization accuracy | Without source-status and integrity checks | 13 | +0.0 pp (+0.0 pp to +0.0 pp) | Higher | 1.000 |
| Authorization accuracy | Without conflict precondition | 13 | +0.0 pp (+0.0 pp to +0.0 pp) | Higher | 1.000 |
| Authorization accuracy | Without deterministic-rule precondition | 13 | +0.0 pp (+0.0 pp to +0.0 pp) | Higher | 1.000 |
| Authorization accuracy | Without output validation | 13 | +0.0 pp (+0.0 pp to +0.0 pp) | Higher | 1.000 |
| Responses with prohibited disclosure | Question-only LLM | 96 | -12.5 pp (-19.8 pp to -6.3 pp) | Lower | 0.003 |
| Responses with prohibited disclosure | Plain-context RAG | 96 | -13.5 pp (-20.8 pp to -7.3 pp) | Lower | 0.001 |
| Responses with prohibited disclosure | Without access enforcement | 96 | -13.1 pp (-19.8 pp to -6.9 pp) | Lower | 0.001 |
| Responses with prohibited disclosure | Without source-status and integrity checks | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Responses with prohibited disclosure | Without conflict precondition | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Responses with prohibited disclosure | Without deterministic-rule precondition | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Responses with prohibited disclosure | Without output validation | 96 | +0.0 pp (+0.0 pp to +0.0 pp) | Lower | 1.000 |
| Decision code and outcome agreement | Question-only LLM | 6 | +100.0 pp (+100.0 pp to +100.0 pp) | Higher | 0.219 |
| Decision code and outcome agreement | Plain-context RAG | 6 | +16.7 pp (+0.0 pp to +50.0 pp) | Higher | 1.000 |
| Decision code and outcome agreement | Without access enforcement | 6 | +0.0 pp (+0.0 pp to +0.0 pp) | Higher | 1.000 |
| Decision code and outcome agreement | Without source-status and integrity checks | 6 | +0.0 pp (+0.0 pp to +0.0 pp) | Higher | 1.000 |
| Decision code and outcome agreement | Without conflict precondition | 6 | +0.0 pp (+0.0 pp to +0.0 pp) | Higher | 1.000 |
| Decision code and outcome agreement | Without deterministic-rule precondition | 6 | +100.0 pp (+100.0 pp to +100.0 pp) | Higher | 0.219 |
| Decision code and outcome agreement | Without output validation | 6 | +0.0 pp (+0.0 pp to +0.0 pp) | Higher | 1.000 |

## Complementary conversational synthesis

Recorded-decision preservation compares the released structured decision code and outcome with the typed decision attached to the final deterministic record. Missing-information detection requires the missing-evidence reason, while conflicting-information detection requires the conflicting-evidence reason. Required-reason agreement is assessed separately through deterministic binding and pipeline validation. Complete one-response synthesis also requires full required-record coverage, citation-ID validity, no unsupported statement, the applicable information-problem detection, and a response accepted by the governed service validator. Raw-record and sequential-query references do not generate responses, so their response-quality entries are not applicable.

| Condition | Median user-visible operations | Required-record coverage | Recorded decision and outcome (95% case-cluster CI) | Citation-ID validity | Unsupported-claim rate | Missing-information detection (95% case-cluster CI) | Conflicting-information detection (95% case-cluster CI) | Complete one-response synthesis (95% case-cluster CI) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Raw structured records | 4 | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| Sequential deterministic queries | 5 | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| Governed conversational synthesis | 1 | 98.7% | 100.0% (88.6% to 100.0%) | 100.0% | 0.0% | 100.0% (56.6% to 100.0%) | 100.0% (56.6% to 100.0%) | 93.3% (86.0% to 98.7%) |

The governed synthesis condition produced 0 unsupported claims among 683 checked claims. The case-cluster 95% interval for the rate of responses containing an unsupported claim is 0.0% to 11.4%. An observed zero is not interpreted as zero risk. These metrics are machine-observed interface properties, not subjective usability measurements.

The retained raw model candidate is analyzed separately before deterministic binding and fail-closed validation. Because the model receives the typed deterministic record, decision-code, outcome, and required-reason agreement compare its structured fields with that supplied record rather than measuring independent decision accuracy.

| Raw generation observations | Required-record coverage | All records covered | Decision metadata agreement | Decision-code agreement | Outcome agreement | Required reason-code agreement | Raw validation passed | Complete raw synthesis |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 150 | 96.9% | 86.0% (76.0% to 94.7%) | 100.0% (88.6% to 100.0%) | 100.0% (88.6% to 100.0%) | 100.0% (88.6% to 100.0%) | 100.0% (88.6% to 100.0%) | 7.3% (1.3% to 15.3%) | 7.3% (1.3% to 15.3%) |

## Contextual route assessment

The `Contextual Battery Route Sustainability Assessment` evaluates 3 declared routes through the separate components `G`, `C`, `I`, `E`, `A`, `U`. It does not calculate an overall sustainability score. The nominal case returned `continued-compatible-ev-use` with decision state `answer` and reproduction hash `JRBfLGWlX-VoN6uQ5HLymK36v05tbCwxwHdneI0k5K0`.

| Deterministic check | Result |
|---|---|
| Nominal case returns a supported route preference | PASS |
| A route that does not meet technical and safety eligibility is not selected | PASS |
| Missing critical information produces abstention | PASS |
| Conflicting critical information requires an external decision | PASS |
| A changed context factor changes the environmental indicator | PASS |
| The same context change preserves circularity | PASS |
| The same context change preserves economics | PASS |
| An unstable scenario ranking produces abstention | PASS |
| Exact replay reproduces the complete result | PASS |

These route checks verify the implemented calculations and decision behavior for controlled inputs. They are not a universal sustainability certification, an empirical lifecycle assessment of all batteries, or evidence of realized environmental benefits.

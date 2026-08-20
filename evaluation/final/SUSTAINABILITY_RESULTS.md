# Contextual battery route-assessment results

The deterministic service evaluates three second-life routes through six separate components:
technical and safety eligibility (`G`), circularity (`C`), environmental indicators (`I`),
economics (`E`), evidence coverage (`A`), and uncertainty and rank stability (`U`).

## Worked three-route result

| Route | Technical and safety gate (G) | Circularity (C, 0 to 100) | Environmental indicators (I) | Net present value (E) | Evidence coverage (A) | Rank stability (U) |
|---|---|---:|---|---:|---:|---|
| Continued compatible EV use | PASS | 100 | Climate change: 4 kg CO2e/service; Mineral depletion: 1 kg Sb-e/service | 10 EUR | 1 | stable |
| Stationary-storage repurposing | PASS | 75 | Climate change: 4 kg CO2e/service; Mineral depletion: 1 kg Sb-e/service | 8 EUR | 1 | stable |
| Recycling | PASS | 50 | Climate change: 4 kg CO2e/service; Mineral depletion: 1 kg Sb-e/service | 6 EUR | 1 | stable |

The nominal case returns **Continued compatible EV use** under the declared stable scenario ranking. The complete output has reproduction hash
`JRBfLGWlX-VoN6uQ5HLymK36v05tbCwxwHdneI0k5K0`.

## Deterministic validation

| Check | Result |
|---|---|
| Nominal case returns a supported route preference | PASS |
| A route that fails the safety gate is not selected | PASS |
| Missing critical information produces abstention | PASS |
| Conflicting critical information requires an external decision | PASS |
| A changed context factor changes the environmental indicator | PASS |
| The same context change preserves circularity | PASS |
| The same context change preserves economics | PASS |
| Exact replay reproduces the complete result | PASS |

The safety-failure case prevents the failed route from being selected. Missing critical evidence
produces abstention, and conflicting critical evidence requires an accountable external decision.
Changing the environmental factor changes `I` while leaving circularity and economics unchanged.
An exact replay produces the same complete output and reproduction hash.

These controlled cases verify the implemented calculations and decision behavior. Their values are
scenario-specific and should not be interpreted as universal sustainability certification or as an
empirical lifecycle assessment of all batteries.

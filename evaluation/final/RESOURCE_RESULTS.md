# Resource characterization

## OpenAI evaluation use

| Item | Value |
|---|---:|
| Primary input tokens | 733,850 |
| Primary output tokens | 163,429 |
| Complementary synthesis input tokens | 109,905 |
| Complementary synthesis output tokens | 46,898 |
| Total input tokens | 843,755 |
| Total output tokens | 210,327 |
| Estimated token charge | US$0.253 |

The estimate applies the documented GPT-4o mini rates of US$0.15 per million input tokens and US$0.60 per million output tokens ([OpenAI, accessed 13 August 2026](https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/)). It excludes taxes, account credits and calls outside the reported evaluation, so it is not an invoice total.

## Observed model-call latency

| Evaluation | Median | 95th percentile |
|---|---:|---:|
| Complementary synthesis | 3.54 s | 8.43 s |

Median and 95th-percentile values for each primary condition are available in `results/primary/condition-summary.csv`. These times cover the model call and response parsing; they do not include service startup, blockchain confirmation or indexing.

## Public-workflow confirmation and fee snapshot

| Measure | Value |
|---|---:|
| Confirmed Sepolia transactions | 57 |
| Median confirmation time | 12.00 s |
| 95th-percentile confirmation time | 35.77 s |
| Measured gas | 6,610,960 |
| Observed fee | 0.006920297001991101 Sepolia ETH |

| Network | Basis | Total ETH | USD at snapshot |
|---|---|---:|---:|
| Sepolia | observed | 0.006920297001991101 | not applicable |
| Ethereum Mainnet | snapshot estimate | 0.00136111348490128 | US$2.6026 |
| Optimism | snapshot estimate | 0.000006931401765651 | US$0.0133 |
| Arbitrum One | snapshot estimate | 0.000133379792852224 | US$0.2550 |
| Base | snapshot estimate | 0.000039874442962918 | US$0.0762 |

The Sepolia value comes from confirmed transaction receipts. The other rows are dated estimates that apply each network's fee parameters, including Layer 2 data charges, to the measured workflow trace. The parameters and ETH spot price were collected on 2026-08-18; their exact sources and query methods are recorded in the accompanying cost snapshot. These values vary with network fees and exchange rates and are not receipts from deployments on those networks.

## Deterministic assessment timing

| Measure | Value |
|---|---:|
| First in-process assessment call | 21.379 ms |
| Warm calls | 1,000 |
| Warm-call median | 0.525 ms |
| Warm-call 95th percentile | 1.623 ms |

Environment: Node v24.18.1, win32 10.0.26200, 12 logical CPUs (Intel(R) Core(TM) 5 120U). These measurements characterize local execution and do not estimate production throughput.

## Evaluation artifact sizes

| Artifact | Bytes |
|---|---:|
| evaluation/final/results/primary/observations.jsonl | 4,714,703 |
| evaluation/final/results/synthesis/observations.jsonl | 269,215 |
| evaluation/final/primary-corpus.json | 115,453 |
| evaluation/final/synthesis-corpus.json | 66,093 |
| evaluation/final/sustainability-validation.json | 31,592 |
| **Total** | **5,197,056** |

# Resource characterization

## OpenAI evaluation use

| Item | Value |
|---|---:|
| Primary input tokens | 1,174,590 |
| Primary output tokens | 264,688 |
| Complementary synthesis input tokens | 172,335 |
| Complementary synthesis output tokens | 43,090 |
| Total input tokens | 1,346,925 |
| Total output tokens | 307,778 |
| Estimated token charge | US$0.387 |

The estimate applies the pinned GPT-4o mini public list-price snapshot of US$0.15 per million input tokens and US$0.60 per million output tokens ([OpenAI, accessed 2026-08-27](https://developers.openai.com/api/docs/models/gpt-4o-mini)). These rates are a point-in-time public list-price snapshot. They exclude taxes, account credits, discounted or cached-token rates, and calls outside the reported evaluation. The estimate is not an invoice total.

## Governed synthesis request duration

| Evaluation | Median | 95th percentile |
|---|---:|---:|
| Complementary synthesis | 2.97 s | 6.36 s |

Each complementary value measures one complete governed synthesis request in the evaluation harness. It includes session preparation, permitted-record tool setup and access checks, service orchestration, model generation and response parsing, and post-generation validation. It excludes process startup, blockchain confirmation and indexing. Median and 95th-percentile values for each primary condition are reported separately in `results/primary/condition-summary.csv`.

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
| Ethereum Mainnet | snapshot estimate | 0.00073587599964824 | US$1.8390 |
| Optimism | snapshot estimate | 0.00000679169583575 | US$0.0170 |
| Arbitrum One | snapshot estimate | 0.000132857646347264 | US$0.3320 |
| Base | snapshot estimate | 0.000039779768807017 | US$0.0994 |

The Sepolia value comes from confirmed transaction receipts. The other rows are dated estimates that apply each network's fee parameters, including Layer 2 data charges, to the measured workflow trace. The parameters and ETH spot price were collected on 2026-08-28; their exact sources and query methods are recorded in the accompanying cost snapshot. These values vary with network fees and exchange rates and are not receipts from deployments on those networks.

## Deterministic assessment timing

| Measure | Value |
|---|---:|
| First in-process assessment call | 28.914 ms |
| Warm calls | 1,000 |
| Warm-call median | 0.429 ms |
| Warm-call 95th percentile | 1.639 ms |

Environment: Node v24.18.1, win32 10.0.26200, 12 logical CPUs (Intel(R) Core(TM) 5 120U). These measurements characterize local execution and do not estimate production throughput.

## Evaluation artifact sizes

| Artifact | Bytes |
|---|---:|
| evaluation/final/results/primary/observations.jsonl | 9,826,520 |
| evaluation/final/results/synthesis/observations.jsonl | 743,333 |
| evaluation/final/primary-corpus.json | 186,115 |
| evaluation/final/synthesis-corpus.json | 83,814 |
| evaluation/final/sustainability-validation.json | 37,038 |
| **Total** | **10,876,820** |

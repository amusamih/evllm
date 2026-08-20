# Complementary conversational synthesis evaluation

This evaluation examines whether the governed conversational service can combine several permitted
records into one source-linked response. It complements the primary comparison, which focuses on
reliability and safety across model configurations.

The protocol and controlled synthetic corpus were specified in `synthesis-freeze-v1.json` before the
evaluated model responses were collected. The comparison measures user-visible operations,
required-record coverage, exact decision-code accuracy, citation traceability, unsupported claims,
missing or conflicting information detection, and complete one-response synthesis.

Raw structured records and sequential deterministic queries serve as exact reference interfaces. The
evaluation tests whether conversational synthesis preserves their record coverage and traceability
while presenting the combined result in fewer prescribed interface steps. These are machine-observed
properties; they do not measure subjective usefulness, comprehension or cognitive effort.

Regenerate the source corpus with `npm run evaluation:source:synthesis`. The evaluated corpus,
observations and analysis are available under `evaluation/final/`.

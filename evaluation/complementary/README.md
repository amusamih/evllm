# Complementary conversational synthesis evaluation

This evaluation examines whether the governed conversational service can combine several permitted
records into one source-linked response. It complements the primary comparison, which focuses on
reliability and safety across model configurations.

The protocol and controlled synthetic corpus are specified in `synthesis-freeze-v2.json` before
evaluated model responses are collected. The freeze binds the exact bytes and logical digest of
`synthesis-corpus-v2.json`. The comparison measures user-visible operations, required-record
coverage, structured outcome and decision-code accuracy, citation validity, unsupported claims,
missing or conflicting information detection, and complete one-response synthesis.

Raw structured records and sequential deterministic queries serve only as reference interfaces for
prespecified operation counts; they do not generate responses and therefore receive no response-
quality scores. The governed condition is evaluated for record coverage, valid citations and
complete synthesis in one response. These are machine-observed properties; they do not measure
subjective usefulness, comprehension or cognitive effort.

Regenerate the source corpus and freeze with `npm run evaluation:source:synthesis`. The final
evaluation generator assigns the same evaluation-set identifier to this branch and the primary
comparison. Evaluated corpora, observations, and analyses are available under `evaluation/final/`.

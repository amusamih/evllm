# Formal evaluation sources

The formal corpus generator uses the public machine-readable fixture at
[`evaluation/fixtures/eu-regulation-2023-1542-articles-77-78.json`](../fixtures/eu-regulation-2023-1542-articles-77-78.json).
It identifies Regulation (EU) 2023/1542 as `CELEX:32023R1542`, records the official ELI
`http://data.europa.eu/eli/reg/2023/1542/oj`, and links to the
[English EUR-Lex record](https://eur-lex.europa.eu/eli/reg/2023/1542/oj?locale=en).

The fixture contains eight selected battery-passport provisions: Article 77(1), Article 77(3) first
subparagraph, Article 77(4), Article 77(5), Article 77(7) first subparagraph, and Article 78(f)-(h).
The `eu-date-jurisdiction` cases use Article 77(1) consistently to test the passport's application
date, while the fixture tests independently verify the provenance and exact text of all eight
selected provisions.

This linkage has a narrow evaluation purpose. The legal source and clause text are factual
public-source metadata, but actor identities, battery facts, route parameters, and expected outcomes
remain synthetic. Neither the fixture nor the evaluation is legal advice or legal-compliance
validation.

Run `npm run evaluation:source:primary` to reproduce `task-corpus-v2.json` and its source freeze.
The freeze binds the exact corpus bytes, logical corpus digest, regulatory fixture bytes, and
official source identifiers before response collection. The final evaluation generator then assigns
the same evaluation-set identifier to the primary and complementary branches.

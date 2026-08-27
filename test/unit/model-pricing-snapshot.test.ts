import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { modelPricingSnapshot } from "../../scripts/lib/model-pricing.js";

const fixture = modelPricingSnapshot.parse(
  JSON.parse(
    readFileSync(resolve("evaluation/fixtures/openai-gpt-4o-mini-pricing-2026-08-27.json"), "utf8"),
  ),
);

describe("public model-pricing snapshot", () => {
  it("pins the evaluated model rates, official source, and access date", () => {
    expect(fixture).toMatchObject({
      model: "gpt-4o-mini-2024-07-18",
      currency: "USD",
      billing_unit: "one_million_tokens",
      rates: {
        input_usd_per_million_tokens: 0.15,
        output_usd_per_million_tokens: 0.6,
      },
      source: {
        url: "https://developers.openai.com/api/docs/models/gpt-4o-mini",
        accessed_on: "2026-08-27",
      },
    });
  });

  it("rejects non-positive rates and non-OpenAI source URLs", () => {
    expect(() =>
      modelPricingSnapshot.parse({
        ...fixture,
        rates: { ...fixture.rates, input_usd_per_million_tokens: 0 },
      }),
    ).toThrow();
    expect(() =>
      modelPricingSnapshot.parse({
        ...fixture,
        source: { ...fixture.source, url: "https://example.com/pricing" },
      }),
    ).toThrow(/official OpenAI URL/u);
  });
});

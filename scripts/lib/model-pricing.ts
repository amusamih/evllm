import { z } from "zod";

const officialOpenAiUrl = z.url().refine((value) => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "openai.com" || hostname.endsWith(".openai.com");
  } catch {
    return false;
  }
}, "Pricing source must be an official OpenAI URL");

export const modelPricingSnapshot = z
  .object({
    schema: z.literal("PUBLIC_MODEL_PRICING_SNAPSHOT_V1"),
    snapshot_id: z.string().min(1),
    provider: z.literal("OpenAI"),
    model: z.literal("gpt-4o-mini-2024-07-18"),
    display_name: z.literal("GPT-4o mini"),
    currency: z.literal("USD"),
    billing_unit: z.literal("one_million_tokens"),
    rates: z
      .object({
        input_usd_per_million_tokens: z.number().positive().finite(),
        output_usd_per_million_tokens: z.number().positive().finite(),
      })
      .strict(),
    source: z
      .object({
        title: z.string().min(1),
        url: officialOpenAiUrl,
        accessed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      })
      .strict(),
    scope_boundary: z.string().min(1),
  })
  .strict();

export type ModelPricingSnapshot = z.infer<typeof modelPricingSnapshot>;

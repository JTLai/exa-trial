import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

// All LLM calls go through this module so swapping models or providers is a
// one-line change. The OpenAI provider reads OPENAI_API_KEY from the env.
export const model = openai(process.env.AI_MODEL ?? "gpt-5.1");

export const analysisSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe("One or two sentences summarizing the text"),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  topics: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe("Short topic tags, e.g. 'pricing' or 'shipping delay'"),
});

export type AnalysisResult = z.infer<typeof analysisSchema>;

export async function analyzeText(input: string): Promise<AnalysisResult> {
  const { object } = await generateObject({
    model,
    schema: analysisSchema,
    prompt: `Analyze the following text. Summarize it, classify its overall sentiment, and extract its main topics.\n\n<text>\n${input}\n</text>`,
  });
  // generateObject already validated `object` against analysisSchema.
  return object;
}

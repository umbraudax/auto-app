import { z } from "zod";
import { reserveClaude, settleClaude } from "./budget";
import { required } from "./config";

const models = {
  score: { id: "claude-haiku-4-5-20251001", input: 1, output: 5 },
  form: { id: "claude-sonnet-4-6", input: 3, output: 15 },
  memory: { id: "claude-opus-5-5", input: 4, output: 20 },
} as const;

const envelope = z.object({
  stop_reason: z.string(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

export async function claudeJson<T>(
  tier: keyof typeof models, system: string, data: unknown, schema: z.ZodType<T>, maxTokens: number,
) {
  const model = models[tier];
  const apiKey = required("ANTHROPIC_API_KEY");
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema);
  const body = JSON.stringify({
    model: model.id,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: JSON.stringify(data) }],
    output_config: {
      ...(tier === "memory" ? { effort: "low" } : {}),
      format: { type: "json_schema", schema: jsonSchema },
    },
  });
  // Reserve against UTF-8 bytes plus model framing overhead and the full output limit.
  const reserved = (Buffer.byteLength(body) + 2048) * model.input + maxTokens * model.output;
  const day = await reserveClaude(reserved);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Claude API returned HTTP ${response.status}`);

  const reply = envelope.parse(await response.json());
  const cost = reply.usage.input_tokens * model.input + reply.usage.output_tokens * model.output;
  await settleClaude(day, reserved, cost);
  const result = reply.content.find((block) => block.type === "text")?.text;
  if (reply.stop_reason !== "end_turn" || !result) throw new Error("Claude did not return a complete result");
  return schema.parse(JSON.parse(result));
}

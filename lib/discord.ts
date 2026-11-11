import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { required } from "./config";
import type { ResumeAction } from "./resumes";
import type { Action } from "./state";

export const noMentions = { parse: [] as string[] };
const root = "https://discord.com/api/v10";
const hexKeyPrefix = "302a300506032b6570032100";
export const snowflake = z.string().regex(/^\d{17,22}$/);
const uuid = z.uuid();
const ephemeral = 64;

export function validSignature(body: string, headers: Headers, key: string, now = Date.now()) {
  const signature = headers.get("x-signature-ed25519") ?? "";
  const timestamp = headers.get("x-signature-timestamp") ?? "";
  if (!/^[0-9a-f]{128}$/i.test(signature) || !/^\d{1,12}$/.test(timestamp)
    || !/^[0-9a-f]{64}$/i.test(key) || Math.abs(now - Number(timestamp) * 1000) > 300_000) return false;
  const publicKey = createPublicKey({ key: Buffer.from(hexKeyPrefix + key, "hex"), format: "der", type: "spki" });
  return verify(null, Buffer.from(timestamp + body), publicKey, Buffer.from(signature, "hex"));
}

const person = z.object({ id: snowflake });
const scalarOption = z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) });
const commandOption = z.union([scalarOption, z.object({
  name: z.string(), type: z.literal(1), options: z.array(scalarOption).optional(),
})]);
const discordAttachment = z.object({
  id: snowflake, url: z.url(), filename: z.string().min(1).max(256), size: z.number().int().positive(),
});
export const interactionSchema = z.object({
  id: snowflake,
  application_id: snowflake,
  type: z.number().int(),
  token: z.string().min(1).max(400),
  guild_id: snowflake.optional(),
  channel_id: snowflake.optional(),
  member: z.object({ user: person }).optional(),
  user: person.optional(),
  data: z.object({
    name: z.string().optional(),
    custom_id: z.string().optional(),
    options: z.array(commandOption).optional(),
    resolved: z.object({ attachments: z.record(snowflake, discordAttachment).optional() }).optional(),
    components: z.array(z.unknown()).optional(),
  }).optional(),
});
type Interaction = z.infer<typeof interactionSchema>;

export function immediate(content: string) {
  return { type: 4, data: { content, flags: ephemeral, allowed_mentions: noMentions } };
}
export const deferred = { type: 5, data: { flags: ephemeral } };

const optionText = z.string().trim().min(1).max(150);
const optionScore = z.number().int().min(1).max(100);

function parseResume(interaction: Interaction): { type: "resume"; command: ResumeAction } {
  const [option] = interaction.data?.options ?? [];
  if (!option || !("type" in option)) throw new Error("Resume subcommand required");
  const values = Object.fromEntries(option.options?.map(({ name, value }) => [name, value]) ?? []);
  switch (option.name) {
    case "upload": {
      const id = snowflake.parse(values.file);
      const file = interaction.data?.resolved?.attachments?.[id];
      if (file?.id !== id) throw new Error("Missing resume attachment");
      return { type: "resume", command: { operation: "upload", file, makeDefault: z.boolean().parse(values.set_default ?? false) } };
    }
    case "list":
      return { type: "resume", command: { operation: "list", page: z.number().int().min(1).max(1_000_000).parse(values.page ?? 1) } };
    case "default":
    case "delete":
      return { type: "resume", command: { operation: option.name, id: uuid.parse(values.id) } };
    default:
      throw new Error("Unknown resume subcommand");
  }
}

function parseSlash(interaction: Interaction): Action | ReturnType<typeof parseResume> | undefined {
  const options = Object.fromEntries(interaction.data?.options?.flatMap((option) =>
    "value" in option ? [[option.name, option.value]] : []) ?? []);
  switch (interaction.data?.name) {
    case "status": return { type: "status" };
    case "pause": return { type: "pause", paused: z.boolean().parse(options.enabled ?? true) };
    case "skipcompany": return { type: "skipcompany", company: optionText.parse(options.company) };
    case "criteria": {
      const patch = z.object({
        description: z.string().trim().min(1).max(3500).optional(),
        minimumScore: optionScore.optional(),
        autoPreviewScore: z.number().int().min(1).max(101).optional(),
        titleTerms: z.array(optionText.max(80)).max(30).optional(),
      }).parse({
        description: options.description, minimumScore: options.minimum, autoPreviewScore: options.auto_preview,
        titleTerms: typeof options.titles === "string" ? options.titles.split(",").map((term) => term.trim()).filter(Boolean) : undefined,
      });
      return { type: "criteria", patch: Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
    }
    case "record":
      return {
        type: "record", thread: snowflake.parse(interaction.channel_id),
        state: z.enum(["submitted", "confirmed", "rejected", "interview"]).parse(options.state),
      };
    case "discover": return;
    case "resume": return parseResume(interaction);
  }
}

const customSchema = z.tuple([z.literal("answer"), uuid, uuid, z.enum(["0", "1", "2"])]);
const answerLabels = {
  "0": "Answer for this application",
  "1": "Answer and remember for this employer",
  "2": "Save answer for future applications",
};
const textInput = z.object({ type: z.literal(4), custom_id: z.literal("value"), value: z.string().max(1800) });
const modalComponent = z.object({
  component: textInput.optional(),
  components: z.array(textInput).optional(),
});

export function interactionAction(interaction: Interaction) {
  if (interaction.type === 2) return { action: parseSlash(interaction), discover: interaction.data?.name === "discover" };
  const custom = interaction.data?.custom_id?.split(":") ?? [];
  if (interaction.type === 3 && (custom[0] === "approve" || custom[0] === "skip")) {
    const [type, jobId] = z.tuple([z.enum(["approve", "skip"]), uuid]).parse(custom);
    return { action: { type, jobId } satisfies Action };
  }
  const parsed = customSchema.safeParse(custom);
  if (!parsed.success) return {};
  const [, appId, promptId, mode] = parsed.data;
  if (interaction.type === 3) {
    return { modal: {
      type: 9,
      data: {
        title: "Application question",
        custom_id: custom.join(":"),
        components: [{
          type: 18, label: answerLabels[mode],
          component: { type: 4, custom_id: "value", style: 2, required: true, max_length: 1800 },
        }],
      },
    } };
  }
  if (interaction.type === 5) {
    const groups = z.array(modalComponent).parse(interaction.data?.components ?? []);
    const answer = groups.flatMap((group) => group.component ? [group.component] : group.components ?? [])[0]?.value;
    if (!answer) return {};
    return { action: {
      type: "answer", appId, promptId, answer, remember: mode !== "0",
      ...(mode === "2" ? { learn: true as const } : {}),
    } satisfies Action };
  }
  return {};
}

export class DiscordError extends Error {
  constructor(readonly status: number, readonly code?: number) {
    super(`Discord API returned HTTP ${status}`);
  }
}

export async function discord(path: string, method: string, payload?: object, authenticated = true) {
  const headers: Record<string, string> = {};
  if (authenticated) headers.authorization = `Bot ${required("DISCORD_BOT_TOKEN")}`;
  if (payload && !(payload instanceof FormData)) headers["content-type"] = "application/json";
  const response = await fetch(root + path, {
    method, headers, body: payload instanceof FormData ? payload : payload ? JSON.stringify(payload) : undefined,
    redirect: "error", signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const { code } = await response.json().catch(() => ({}));
    throw new DiscordError(response.status, typeof code === "number" ? code : undefined);
  }
  return response.status === 204 ? undefined : response.json();
}

export function editReply(interaction: Interaction, content: string) {
  const token = encodeURIComponent(interaction.token);
  return discord(`/webhooks/${interaction.application_id}/${token}/messages/@original`, "PATCH", {
    content: content.slice(0, 1950), allowed_mentions: noMentions,
  }, false);
}

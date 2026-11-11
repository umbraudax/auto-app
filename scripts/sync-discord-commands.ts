import { isDeepStrictEqual } from "node:util";
import { setTimeout } from "node:timers/promises";
import { discord, DiscordError } from "../lib/discord";

type Option = {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  options?: Option[];
  choices?: { name: string; value: string | number }[];
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
};

type Command = {
  name: string;
  description: string;
  options?: Option[];
};

type RegisteredCommand = Command & { id: string; type: number };

function optionFields(option: Option): unknown {
  return {
    type: option.type,
    name: option.name,
    description: option.description,
    required: option.required ?? false,
    options: (option.options ?? []).map(optionFields),
    choices: (option.choices ?? []).map(({ name, value }) => ({ name, value })),
    min_value: option.min_value,
    max_value: option.max_value,
    min_length: option.min_length,
    max_length: option.max_length,
  };
}

async function afterRateLimit<T>(request: () => Promise<T>): Promise<T> {
  for (let retries = 0; ; retries++) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof DiscordError) || error.status !== 429 || error.retryAfterMs === undefined
          || error.retryAfterMs > 30_000 || retries >= 3) throw error;
      const delay = error.retryAfterMs + 100;
      console.log(`Discord rate limit. Retrying in ${Math.ceil(delay / 1000)} seconds.`);
      await setTimeout(delay);
    }
  }
}

export async function syncGuildCommands(path: string, definitions: Command[]) {
  const registered: RegisteredCommand[] = await afterRateLimit(() => discord(path, "GET"));
  const existing = new Map(registered.filter(({ type }) => type === 1).map((entry) => [entry.name, entry]));
  let created = 0;
  let updated = 0;
  for (const definition of definitions) {
    const prior = existing.get(definition.name);
    if (!prior) {
      await afterRateLimit(() => discord(path, "POST", { type: 1, ...definition }));
      created++;
    } else if (prior.description !== definition.description ||
        !isDeepStrictEqual((prior.options ?? []).map(optionFields), (definition.options ?? []).map(optionFields))) {
      await afterRateLimit(() => discord(`${path}/${prior.id}`, "PATCH", {
        description: definition.description,
        options: definition.options ?? [],
      }));
      updated++;
    }
  }
  return { created, updated, unchanged: definitions.length - created - updated };
}

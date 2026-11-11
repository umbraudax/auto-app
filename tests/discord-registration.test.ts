import assert from "node:assert/strict";
import test from "node:test";
import { DiscordError } from "../lib/discord";
import { syncGuildCommands } from "../scripts/sync-discord-commands";

const path = "/applications/100000000000000001/guilds/100000000000000002/commands";

test("registration skips matching commands and retries only the rate-limited write", async (t) => {
  const originalToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "test-token";
  t.after(() => {
    if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalToken;
  });
  const option = { type: 3, name: "state", description: "Application state", choices: [{ name: "submitted", value: "submitted" }] };
  const status = { name: "status", description: "Show the queue" };
  const record = { name: "record", description: "Update the application", options: [option] };
  const resume = { name: "resume", description: "Manage resumes" };
  const calls: { method: string; path: string; body: unknown }[] = [];
  let resumeAttempts = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const method = init.method!;
    calls.push({ method, path: new URL(url).pathname, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") return Response.json([
      { ...status, id: "100000000000000003", type: 1, options: [] },
      { ...record, id: "100000000000000004", type: 1, description: "Old description",
        options: [{ ...option, required: false, choices: [{ ...option.choices[0], name_localizations: null }] }] },
      { name: "unrelated", description: "", id: "100000000000000005", type: 2 },
    ]);
    if (method === "POST" && ++resumeAttempts === 1) {
      return Response.json({ retry_after: 0.001 }, { status: 429 });
    }
    return Response.json({});
  });

  assert.deepEqual(await syncGuildCommands(path, [status, record, resume]), { created: 1, updated: 1, unchanged: 1 });
  assert.deepEqual(calls, [
    { method: "GET", path: "/api/v10" + path, body: undefined },
    { method: "PATCH", path: "/api/v10" + path + "/100000000000000004",
      body: { description: record.description, options: [option] } },
    { method: "POST", path: "/api/v10" + path, body: { type: 1, ...resume } },
    { method: "POST", path: "/api/v10" + path, body: { type: 1, ...resume } },
  ]);
});

test("registration surfaces a long Retry-After without retrying early", async (t) => {
  const originalToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "test-token";
  t.after(() => {
    if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalToken;
  });
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ retry_after: 89.4 }, { status: 429, headers: { "Retry-After": "90" } }));
  await assert.rejects(syncGuildCommands(path, []), (error) =>
    error instanceof DiscordError && error.status === 429 && error.retryAfterMs === 90_000);
  assert.equal(fetch.mock.callCount(), 1);
});

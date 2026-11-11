import { after } from "next/server";
import { boards, required } from "../../../lib/config";
import { deferred, editReply, immediate, interactionAction, interactionSchema, validSignature } from "../../../lib/discord";
import { dispatch } from "../../../lib/dispatch";
import { resumeCommand } from "../../../lib/resumes";
import { command } from "../../../lib/state";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.text();
  if (!validSignature(body, request.headers, required("DISCORD_PUBLIC_KEY"))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Invalid interaction", { status: 400 });
  }
  if (payload && typeof payload === "object" && "type" in payload && payload.type === 1) {
    return Response.json({ type: 1 });
  }

  const parsed = interactionSchema.safeParse(payload);
  if (!parsed.success) return new Response("Invalid interaction", { status: 400 });
  const interaction = parsed.data;
  if (interaction.application_id !== required("DISCORD_APPLICATION_ID")) {
    return new Response("Invalid application", { status: 401 });
  }
  if (interaction.guild_id !== required("DISCORD_GUILD_ID") ||
      (interaction.member?.user.id ?? interaction.user?.id) !== required("DISCORD_OWNER_ID")) {
    return Response.json(immediate("This bot is available to its configured owner."));
  }

  try {
    const { action, discover, modal } = interactionAction(interaction);
    if (modal) return Response.json(modal);
    if (!action && !discover) return Response.json(immediate("This action is unavailable."));
    after(async () => {
      try {
        if (discover) {
          if (discover.invalidBoard) {
            await editReply(interaction, "Enter a public Greenhouse, Lever, Ashby, SmartRecruiters, or Workable job board URL.");
            return;
          }
          try {
            if (!discover.board) boards();
          } catch {
            await editReply(interaction, "JOB_BOARDS_JSON is invalid. Check the configured board sources and slugs, or run /discover with one board URL.");
            return;
          }
          const run = await dispatch("discover", discover.board ? [discover.board] : undefined, true);
          const target = discover.board ? `Checking the ${discover.board.company} board.` : "Searching public internship feeds and employer boards.";
          await editReply(interaction, `${target} Follow progress with /status. A summary will appear in the configured channel.\nRun \`${run.runId}\``);
          return;
        }
        if (!action) return;
        if (action.type === "resume") {
          await editReply(interaction, await resumeCommand(interaction.id, action.command));
          return;
        }
        const reply = await command(interaction.id, action);
        if (action.type === "approve" || action.type === "answer" || (action.type === "pause" && !action.paused)) {
          try {
            await dispatch("process");
          } catch {
            await editReply(interaction, `${reply}\nThe next scheduled run will pick up the saved queue.`);
            return;
          }
        }
        await editReply(interaction, reply);
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
        console.error("Discord action failed", {
          action: discover ? "discover" : action?.type,
          code: typeof code === "number" || (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) ? code : undefined,
        });
        await editReply(interaction, "The command could not be completed. Check the bot setup and try again.").catch(() => undefined);
      }
    });
    return Response.json(deferred);
  } catch {
    return Response.json(immediate("The command contains an invalid value."));
  }
}

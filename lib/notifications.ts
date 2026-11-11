import { get } from "@vercel/blob";
import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { required } from "./config";
import { db, type Transaction } from "./db";
import { discord, DiscordError, noMentions, snowflake } from "./discord";
import { applications, events, jobs } from "./schema";

const row = (components: object[]) => ({ type: 1, components });
const button = (label: string, custom_id: string, style = 2) => ({ type: 2, style, label, custom_id });
const link = (url: string) => ({ type: 2, style: 5, label: "Open posting", url });

function clip(value: string, max: number) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
}

async function send(channel: string, id: number, message: object, file?: Blob, mentionUser?: string) {
  const allowed_mentions = mentionUser ? { ...noMentions, users: [mentionUser] } : noMentions;
  const payload = { ...message, nonce: `autoapp:${id}`, enforce_nonce: true, allowed_mentions };
  if (!file) return discord(`/channels/${channel}/messages`, "POST", payload);
  const form = new FormData();
  form.set("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename: "preview.jpg" }] }));
  form.set("files[0]", file, "preview.jpg");
  return discord(`/channels/${channel}/messages`, "POST", form);
}

async function ensureThread(tx: Transaction, app: typeof applications.$inferSelect, job: typeof jobs.$inferSelect, channel: string, eventId: number) {
  if (app.threadId) return app.threadId;
  const messageId = job.reviewMessage ?? snowflake.parse((await send(channel, -eventId, {
    embeds: [{ title: clip(`${job.company} · ${job.title}`, 250), description: "Application activity" }],
    components: [row([link(job.url)])],
  })).id);
  try {
    await discord(`/channels/${channel}/messages/${messageId}/threads`, "POST", {
      name: clip(`${job.company} · ${job.title}`, 100), auto_archive_duration: 1440,
    });
  } catch (error) {
    if (!(error instanceof DiscordError) || error.code !== 160004) throw error;
  }
  // A Discord thread started from a message has the message's ID.
  await tx.update(applications).set({ threadId: messageId }).where(eq(applications.id, app.id));
  return messageId;
}

export async function deliverOne() {
  return db().transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(and(
      isNull(events.deliveredAt), isNotNull(events.notification), lte(events.nextAttempt, new Date()),
    )).orderBy(asc(events.id)).limit(1).for("update", { skipLocked: true });
    if (!event?.notification) return false;
    const { notification } = event;
    try {
      const channel = snowflake.parse(required("DISCORD_CHANNEL_ID"));
      if (notification.type === "match") {
        const [job] = await tx.select().from(jobs).where(eq(jobs.id, notification.jobId));
        if (job && ["review", "approved"].includes(job.state)) {
          const actions = job.state === "review"
            ? [button("Apply", `approve:${job.id}`, 1), button("Skip", `skip:${job.id}`)] : [];
          const message = await send(channel, event.id, {
            embeds: [{
              title: clip(`${job.company} · ${job.title}`, 250),
              description: clip(`${job.location || "Location unspecified"}\n${job.reason ?? ""}`, 600),
              fields: [{ name: "Fit score", value: `${job.score}/100` }],
            }],
            components: [row([...actions, link(job.url)])],
          });
          await tx.update(jobs).set({ reviewMessage: snowflake.parse(message.id) }).where(eq(jobs.id, job.id));
        }
      } else if (notification.type === "discovery") {
        await send(channel, event.id, { content: clip(notification.summary, 1950) });
      } else if (notification.type === "digest") {
        const lines = Object.entries(notification.counts).map(([state, total]) => `${state.replaceAll("_", " ")} · ${total}`);
        await send(channel, event.id, { content: `**Daily application digest**\n${lines.join("\n")}` });
      } else {
        const [record] = await tx.select({ app: applications, job: jobs }).from(applications)
          .innerJoin(jobs, eq(applications.jobId, jobs.id)).where(eq(applications.id, notification.applicationId))
          .for("update", { of: applications });
        const expected = { question: "needs_input", preview: "preview_ready", manual: "needs_manual" } as const;
        if (record?.app.state === expected[notification.type]) {
          const { app, job } = record;
          const thread = await ensureThread(tx, app, job, channel, event.id);
          if (app.threadId) {
            await discord(`/channels/${thread}`, "PATCH", { archived: false });
          }
          if (notification.type === "question" && app.question?.promptId === notification.promptId) {
            const question = app.question;
            const id = `answer:${app.id}:${question.promptId}`;
            const options = question.options.length ? `\nOptions: ${question.options.join(" · ")}` : "";
            const owner = snowflake.parse(required("DISCORD_OWNER_ID"));
            await send(thread, event.id, {
              content: `<@${owner}> I need your answer to continue this application preview.`,
              embeds: [{ title: "Answer needed", description: clip(question.label + options, 1950) }],
              components: [row([
                ...question.reusable ? [button("Answer and save", `${id}:2`, 1)] : [],
                button("Answer once", `${id}:0`, question.reusable ? 2 : 1),
              ])],
            }, undefined, owner);
          } else if (notification.type === "preview" && app.screenshotPath === notification.path) {
            const image = await get(notification.path, { access: "private" });
            if (!image || image.statusCode !== 200) throw new Error("Preview image missing");
            const file = await new Response(image.stream, { headers: { "content-type": "image/jpeg" } }).blob();
            await send(thread, event.id, {
              content: [
                "Dry-run preview ready.",
                notification.memoryAnswers ? `Opus filled ${notification.memoryAnswers} field(s) using your saved answers. Review the filled form below.` : "",
                "Open the posting to apply. Use /record in this thread to update the application status.",
              ].filter(Boolean).join(" "),
              components: [row([link(job.url)])],
            }, file);
          } else if (notification.type === "manual") {
            await send(thread, event.id, {
              content: `${notification.reason} Use /record in this thread after applying.`,
              components: [row([link(job.url)])],
            });
          }
        }
      }
      await tx.update(events).set({ deliveredAt: new Date() }).where(eq(events.id, event.id));
    } catch (error) {
      const delay = Math.min(1440, 2 ** Math.min(10, event.attempts));
      const status = error instanceof DiscordError ? error.status : undefined;
      await tx.update(events).set({
        attempts: event.attempts + 1,
        nextAttempt: new Date(Date.now() + delay * 60_000),
        data: { ...event.data, lastDeliveryError: status ? `Discord HTTP ${status}` : "Delivery failed" },
      }).where(eq(events.id, event.id));
    }
    return true;
  });
}

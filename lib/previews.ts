import { eq, notExists } from "drizzle-orm";
import { greenhousePreview, savePreview } from "./browser";
import { db } from "./db";
import { resolveFromMemory } from "./memory";
import { answerMemory, qaBank } from "./schema";
import { claimApplication, finishApplication } from "./state";

export async function previewOne() {
  const claimed = await claimApplication();
  if (!claimed) return false;
  const { app, job, lease } = claimed;
  try {
    const bank = await db().select().from(qaBank).where(notExists(
      db().select({ key: answerMemory.questionKey }).from(answerMemory).where(eq(answerMemory.questionKey, qaBank.key)),
    ));
    const answers = { ...Object.fromEntries(bank.map(({ key, answer }) => [key, answer])), ...app.answers };
    const context = { company: job.company, title: job.title, location: job.location, source: job.source, board: job.board };
    const result = await greenhousePreview(job.board, job.externalId, answers,
      (questions) => resolveFromMemory(questions, context));
    if (result.type === "preview") {
      const path = await savePreview(app.id, lease, result.image);
      await finishApplication(app.id, lease, {
        type: "preview", path, resumeVersion: result.resumeVersion, memoryAnswers: result.memoryAnswers,
      });
    } else {
      await finishApplication(app.id, lease, result);
    }
  } catch {
    await finishApplication(app.id, lease, { type: "manual", reason: "The preview could not be completed. Check the browser, profile, and Blob setup or open the job to finish manually." });
  }
  return true;
}

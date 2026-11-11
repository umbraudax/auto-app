import type { Board } from "../lib/config";
import { db } from "../lib/db";
import { ingest, scoreOne } from "../lib/discovery";
import { deliverOne } from "../lib/notifications";
import { purgeResumes } from "../lib/resumes";
import { events } from "../lib/schema";
import { makeDigest } from "../lib/state";

async function pollBoard(board: Board) {
  "use step";
  try {
    await ingest(board);
  } catch {
    await db().insert(events).values({
      kind: "discovery.feed_error", data: { source: board.source, board: board.slug },
    });
  }
}

async function scoreBatch() {
  "use step";
  for (let i = 0; i < 4; i++) {
    const result = await scoreOne();
    if (result !== "next") return false;
  }
  return true;
}

async function prepareNext() {
  "use step";
  const { previewOne } = await import("../lib/previews");
  return previewOne();
}

async function sendBatch() {
  "use step";
  for (let i = 0; i < 4; i++) {
    if (!await deliverOne()) return false;
  }
  return true;
}

async function enqueueDigest(day: string) {
  "use step";
  await makeDigest(day);
}

async function cleanResumeStorage() {
  "use step";
  await purgeResumes().catch(() => undefined);
}

export async function pipeline(kind: "discover" | "process" | "digest", boards: Board[], day: string) {
  "use workflow";
  if (kind === "discover") {
    // Limit the number of simultaneous requests to job boards.
    for (let i = 0; i < boards.length; i += 4) {
      await Promise.all(boards.slice(i, i + 4).map(pollBoard));
    }
    for (let i = 0; i < 30 && await scoreBatch(); i++) {}
  }
  if (kind === "digest") await enqueueDigest(day);
  if (kind !== "process") await cleanResumeStorage();
  // Match messages are delivered first so subsequent updates can use their threads.
  for (let i = 0; i < 15 && await sendBatch(); i++) {}
  for (let i = 0; i < 20 && await prepareNext(); i++) {}
  for (let i = 0; i < 15 && await sendBatch(); i++) {}
}

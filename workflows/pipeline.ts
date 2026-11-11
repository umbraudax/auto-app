import { getWorkflowMetadata } from "workflow";
import type { Board } from "../lib/config";
import { db } from "../lib/db";
import { BoardFeedError, ingest, scoreOne } from "../lib/discovery";
import { discoverySummary, type DiscoveryReport } from "../lib/discovery-report";
import { deliverOne } from "../lib/notifications";
import { purgeResumes } from "../lib/resumes";
import { events, type Notification } from "../lib/schema";
import { makeDigest } from "../lib/state";

async function pollBoard(board: Board, runId: string) {
  "use step";
  try {
    const result = await ingest(board);
    console.info("Discovery board", { runId, source: board.source, slug: board.slug, ...result });
    return result;
  } catch (error) {
    if (!(error instanceof BoardFeedError)) throw error;
    const data = { runId, source: board.source, slug: board.slug, problem: error.message };
    await db().insert(events).values({ kind: "discovery.feed_error", data });
    console.error("Discovery board failed", data);
    return { status: "failed" as const, problem: `${board.company} (${board.source}/${board.slug}) · ${error.message}` };
  }
}

async function scoreBatch(boards: Board[]) {
  "use step";
  let scored = 0;
  let matches = 0;
  let titleFiltered = 0;
  let errors = 0;
  let note: string | undefined;
  for (let i = 0; i < 4; i++) {
    const result = await scoreOne(boards);
    if (result.status === "empty" || result.status === "paused") {
      return { scored, matches, titleFiltered, errors, stop: result.status, note };
    }
    if (result.status === "blocked") {
      return { scored, matches, titleFiltered, errors, stop: "blocked" as const, note: result.problem };
    }
    if (result.status === "scored") {
      scored++;
      if (result.match) matches++;
    } else if (result.status === "filtered") {
      titleFiltered++;
    } else if (result.status === "error") {
      errors++;
      note = result.problem;
    }
  }
  return { scored, matches, titleFiltered, errors, stop: undefined, note };
}

async function recordDiscovery(report: DiscoveryReport, notify: boolean) {
  "use step";
  const summary = discoverySummary(report);
  const data = { ...report, summary };
  const notification: Notification | null = notify ? { type: "discovery", summary } : null;
  await db().insert(events).values({
    kind: "discovery.run", deliveryKey: `discovery:${report.runId}`, data, notification,
  }).onConflictDoUpdate({ target: events.deliveryKey, set: { data, notification } });
  console.info("Discovery run", data);
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

async function runDiscovery(boards: Board[], notify: boolean) {
  const { workflowRunId: runId } = getWorkflowMetadata();
  const report: DiscoveryReport = {
    runId, phase: boards.length ? "Checking boards" : "No boards configured", boardsTotal: boards.length,
    checked: 0, skipped: 0, boardErrors: 0, listings: 0, added: 0, titleFiltered: 0,
    scored: 0, matches: 0, scoreErrors: 0, notes: [],
  };
  if (!boards.length) {
    await recordDiscovery(report, notify);
    return;
  }

  await recordDiscovery(report, false);
  try {
    for (let i = 0; i < boards.length; i += 4) {
      const results = await Promise.all(boards.slice(i, i + 4).map((board) => pollBoard(board, runId)));
      for (const result of results) {
        if (result.status === "failed") {
          report.boardErrors++;
          report.notes.push(result.problem);
          continue;
        }
        if (result.status === "paused") report.phase = "Paused";
        if (result.status === "skipped") report.skipped++;
        if (result.status === "checked") report.checked++;
        report.listings += result.listings;
        report.added += result.added;
        report.titleFiltered += result.filtered;
      }
      await recordDiscovery(report, false);
      if (report.phase === "Paused") break;
    }
    if (report.phase !== "Paused") {
      report.phase = "Scoring candidates";
      await recordDiscovery(report, false);
      for (let i = 0; i < 30; i++) {
        const batch = await scoreBatch(boards);
        report.scored += batch.scored;
        report.matches += batch.matches;
        report.titleFiltered += batch.titleFiltered;
        report.scoreErrors += batch.errors;
        if (batch.note && !report.notes.includes(batch.note)) report.notes.push(batch.note);
        if (batch.stop === "paused") report.phase = "Paused";
        if (batch.stop === "blocked") report.phase = "Scoring blocked";
        if (batch.stop) break;
        await recordDiscovery(report, false);
        if (i === 29) report.notes.push("The run reached its scoring limit. Remaining candidates stay queued.");
      }
    }
    if (report.phase === "Scoring candidates") report.phase = report.boardErrors === boards.length ? "Failed" : "Complete";
  } catch {
    report.phase = "Failed";
    report.notes.push("The workflow stopped before discovery could finish. Check the Vercel run log.");
  }
  await recordDiscovery(report, notify);
}

export async function pipeline(kind: "discover" | "process" | "digest", boards: Board[], day: string, notify = false) {
  "use workflow";
  if (kind === "discover") await runDiscovery(boards, notify);
  if (kind === "digest") await enqueueDigest(day);
  if (kind !== "process") await cleanResumeStorage();
  // Match messages are delivered first so subsequent updates can use their threads.
  for (let i = 0; i < 15 && await sendBatch(); i++) {}
  for (let i = 0; i < 20 && await prepareNext(); i++) {}
  for (let i = 0; i < 15 && await sendBatch(); i++) {}
}

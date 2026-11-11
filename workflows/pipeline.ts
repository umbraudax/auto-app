import { getWorkflowMetadata } from "workflow";
import { claimRegistryBoards, recordBoardCheck } from "../lib/board-registry";
import type { Board } from "../lib/config";
import { db } from "../lib/db";
import { BoardFeedError, ingest, scoreOne } from "../lib/discovery";
import { discoverySummary, type DiscoveryReport } from "../lib/discovery-report";
import type { JobScope } from "../lib/feeds";
import { deliverOne } from "../lib/notifications";
import { publicSourceIds, publicSources, type PublicSource } from "../lib/public-source-catalog";
import { purgeResumes } from "../lib/resumes";
import { events, type Notification } from "../lib/schema";
import { refreshPublicSource } from "../lib/source-discovery";
import { lockSettings, makeDigest } from "../lib/state";

async function pollBoard(board: Board, runId: string, registered: boolean, automatic: boolean) {
  "use step";
  try {
    const result = await ingest(board, automatic);
    if (registered) await recordBoardCheck(board, result.status);
    console.info("Discovery board", { runId, source: board.source, slug: board.slug, ...result });
    return result;
  } catch (error) {
    if (!(error instanceof BoardFeedError)) throw error;
    if (registered) await recordBoardCheck(board, "failed", error.message);
    const data = { runId, source: board.source, slug: board.slug, problem: error.message };
    await db().insert(events).values({ kind: "discovery.feed_error", data });
    console.error("Discovery board failed", data);
    return { status: "failed" as const, problem: `${board.company} (${board.source}/${board.slug}) · ${error.message}` };
  }
}

async function checkPaused() {
  "use step";
  return (await db().transaction(lockSettings)).paused;
}

async function refreshSource(source: PublicSource, runId: string) {
  "use step";
  const result = await refreshPublicSource(source).catch(() => ({
    status: "failed" as const, problem: `${publicSources[source].label} · the feed could not be saved`,
  }));
  console.info("Discovery source", { runId, source, ...result });
  return result;
}

async function loadRegistry(configured: Board[]) {
  "use step";
  return claimRegistryBoards(configured);
}

async function scoreBatch(targets?: JobScope[]) {
  "use step";
  let scored = 0;
  let matches = 0;
  let titleFiltered = 0;
  let errors = 0;
  let note: string | undefined;
  for (let i = 0; i < 4; i++) {
    const result = await scoreOne(targets);
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

async function runDiscovery(configured: Board[], notify: boolean, automatic: boolean) {
  const { workflowRunId: runId } = getWorkflowMetadata();
  const report: DiscoveryReport = {
    runId, phase: automatic ? "Finding boards" : configured.length ? "Checking boards" : "No boards configured",
    boardsTotal: configured.length,
    checked: 0, skipped: 0, boardErrors: 0, listings: 0, added: 0, titleFiltered: 0,
    scored: 0, matches: 0, scoreErrors: 0, notes: [],
  };
  if (!automatic && !configured.length) {
    await recordDiscovery(report, notify);
    return;
  }

  await recordDiscovery(report, false);
  try {
    let registered: Board[] = [];
    if (automatic) {
      const totals = { checked: 0, cached: 0, failed: 0, entries: 0, boardsAdded: 0, registryTotal: 0 };
      report.sources = totals;
      if (await checkPaused()) {
        report.phase = "Paused";
      } else {
        const results = await Promise.all(publicSourceIds.map((source) => refreshSource(source, runId)));
        for (const result of results) {
          if (result.status === "failed") {
            totals.failed++;
            report.notes.push(result.problem);
          } else if (result.status === "cached") {
            totals.cached++;
          } else {
            totals.checked++;
            totals.entries += result.sourceRows;
            totals.boardsAdded += result.boardsAdded;
            report.listings += result.listings;
            report.added += result.added;
            report.titleFiltered += result.filtered;
            if (result.status === "paused") report.phase = "Paused";
          }
        }
      }
      const registry = await loadRegistry(configured);
      totals.registryTotal = registry.total;
      registered = registry.boards;
      if (registry.paused) report.phase = "Paused";
    }
    const boards = [...configured.map((board) => ({ board, registered: false })), ...registered.map((board) => ({ board, registered: true }))];
    report.boardsTotal = boards.length;
    if (report.phase !== "Paused") report.phase = "Checking boards";
    await recordDiscovery(report, false);
    for (let i = 0; report.phase !== "Paused" && i < boards.length; i += 4) {
      const results = await Promise.all(boards.slice(i, i + 4).map(({ board, registered }) => pollBoard(board, runId, registered, automatic)));
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
        const batch = await scoreBatch(automatic ? undefined : configured);
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
    if (report.phase === "Scoring candidates") {
      const failures = report.boardErrors + (report.sources?.failed ?? 0);
      const successes = report.checked + (report.sources?.checked ?? 0);
      report.phase = failures && !successes ? "Failed" : "Complete";
    }
  } catch {
    report.phase = "Failed";
    report.notes.push("The workflow stopped before discovery could finish. Check the Vercel run log.");
  }
  await recordDiscovery(report, notify);
}

export async function pipeline(kind: "discover" | "process" | "digest", boards: Board[], day: string, notify = false, automatic = false) {
  "use workflow";
  if (kind === "discover") await runDiscovery(boards, notify, automatic);
  if (kind === "digest") await enqueueDigest(day);
  if (kind !== "process") await cleanResumeStorage();
  // Match messages are delivered first so subsequent updates can use their threads.
  for (let i = 0; i < 15 && await sendBatch(); i++) {}
  for (let i = 0; i < 20 && await prepareNext(); i++) {}
  for (let i = 0; i < 15 && await sendBatch(); i++) {}
}

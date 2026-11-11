import { and, asc, count, eq, inArray, lte, notInArray, sql } from "drizzle-orm";
import { numberEnv, type Board } from "./config";
import { db } from "./db";
import { normalize } from "./feeds";
import { jobBoards, skippedCompanies } from "./schema";
import { lockSettings } from "./state";

export function boardKey(board: Board) {
  return `${board.source}:${board.region ?? "global"}:${board.slug.toLowerCase()}`;
}

export async function registerBoards(boards: Board[], foundVia: string) {
  const unique = [...new Map(boards.map((board) => [boardKey(board), board])).entries()];
  if (!unique.length) return 0;
  return db().transaction(async (tx) => {
    const { paused } = await lockSettings(tx);
    if (paused) return 0;
    const skipped = new Set((await tx.select().from(skippedCompanies)).map(({ key }) => key));
    const candidates = unique.filter(([, board]) => !skipped.has(normalize(board.company)));
    if (!candidates.length) return 0;
    const added = await tx.insert(jobBoards).values(candidates.map(([key, board]) => ({
      ...board, key, region: board.region ?? "global", foundVia,
    }))).onConflictDoNothing().returning({ key: jobBoards.key });
    return added.length;
  });
}

export async function claimRegistryBoards(configured: Board[]) {
  return db().transaction(async (tx) => {
    const { paused } = await lockSettings(tx);
    const [size] = await tx.select({ total: count() }).from(jobBoards);
    if (paused) return { boards: [], total: size.total, paused };
    const excluded = configured.map(boardKey);
    const due = await tx.select().from(jobBoards).where(and(
      lte(jobBoards.nextCheckAt, sql`now()`),
      excluded.length ? notInArray(jobBoards.key, excluded) : undefined,
    )).orderBy(asc(jobBoards.nextCheckAt), asc(jobBoards.key))
      .limit(numberEnv("DISCOVERY_BOARD_CHECKS", 24, 100)).for("update", { skipLocked: true });
    if (due.length) {
      await tx.update(jobBoards).set({ nextCheckAt: sql`now() + interval '30 minutes'` })
        .where(inArray(jobBoards.key, due.map(({ key }) => key)));
    }
    return {
      boards: due.map(({ source, slug, company, region }) => ({ source, slug, company, region })),
      total: size.total,
      paused,
    };
  });
}

export async function recordBoardCheck(board: Board, result: "checked" | "failed" | "skipped" | "paused", problem?: string) {
  const paused = result === "paused";
  await db().update(jobBoards).set({
    lastCheckedAt: paused ? undefined : new Date(),
    nextCheckAt: paused ? sql`now()` : sql`now() + interval '23 hours'`,
    lastError: paused ? undefined : problem ?? null,
  }).where(eq(jobBoards.key, boardKey(board)));
}

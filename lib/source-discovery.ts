import { sql } from "drizzle-orm";
import { registerBoards } from "./board-registry";
import { db } from "./db";
import { storePostings } from "./discovery";
import { parsePublicInternships } from "./public-internships";
import { publicSources, type PublicSource } from "./public-source-catalog";
import { events } from "./schema";

export async function refreshPublicSource(source: PublicSource) {
  const checkpoint = `discovery.source:${source}`;
  // Claim the rolling hour before fetching so overlapping runs respect source limits.
  const [claim] = await db().insert(events).values({
    kind: "discovery.source", deliveryKey: checkpoint, data: { source },
  }).onConflictDoUpdate({
    target: events.deliveryKey,
    set: { createdAt: sql`now()` },
    setWhere: sql`${events.createdAt} <= now() - interval '1 hour'`,
  }).returning({ id: events.id });
  if (!claim) return { status: "cached" as const };

  const endpoint = publicSources[source];
  const response = await fetch(endpoint.url, {
    redirect: "error", signal: AbortSignal.timeout(25_000), cache: "no-store",
    headers: { "user-agent": "Autoapp personal internship discovery" },
  }).catch(() => null);
  if (!response?.ok) {
    const problem = response ? `HTTP ${response.status}` : "could not be reached";
    return { status: "failed" as const, problem: `${endpoint.label} · ${problem}` };
  }

  let snapshot;
  try {
    snapshot = parsePublicInternships(source, await response.json());
  } catch {
    return { status: "failed" as const, problem: `${endpoint.label} · unexpected feed format` };
  }
  const boardsAdded = await registerBoards(snapshot.boards, source);
  const stored = await storePostings(snapshot.postings);
  return { ...stored, sourceRows: snapshot.entries, eligible: snapshot.eligible, boardsAdded };
}

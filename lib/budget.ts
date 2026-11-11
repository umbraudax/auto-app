import { eq, sql } from "drizzle-orm";
import { numberEnv } from "./config";
import { db, type Transaction } from "./db";
import { dailyUsage } from "./schema";

const today = sql<string>`(now() at time zone 'UTC')::date`;

export class DailyLimit extends Error {}

export async function reserveClaude(micros: number) {
  const cap = numberEnv("DAILY_CLAUDE_MICROS", 250_000, 100_000_000);
  if (micros > cap) throw new DailyLimit("Daily Claude budget reached");
  const [row] = await db().insert(dailyUsage).values({ day: today, claudeMicros: micros })
    .onConflictDoUpdate({
      target: dailyUsage.day,
      set: { claudeMicros: sql`${dailyUsage.claudeMicros} + ${micros}` },
      setWhere: sql`${dailyUsage.claudeMicros} + ${micros} <= ${cap}`,
    }).returning({ day: dailyUsage.day });
  if (!row) throw new DailyLimit("Daily Claude budget reached");
  return row.day;
}

export async function settleClaude(day: string, reserved: number, actual: number) {
  await db().update(dailyUsage).set({
    claudeMicros: sql`${dailyUsage.claudeMicros} + ${actual - reserved}`,
  }).where(eq(dailyUsage.day, day));
}

export async function reservePreview(tx: Transaction) {
  const cap = numberEnv("DAILY_PREVIEWS", 5, 100);
  if (!cap) return false;
  const result = await tx.insert(dailyUsage).values({ day: today, previews: 1 })
    .onConflictDoUpdate({
      target: dailyUsage.day,
      set: { previews: sql`${dailyUsage.previews} + 1` },
      setWhere: sql`${dailyUsage.previews} < ${cap}`,
    }).returning({ day: dailyUsage.day });
  return result.length === 1;
}

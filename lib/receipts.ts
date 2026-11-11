import { eq } from "drizzle-orm";
import { db, type Transaction } from "./db";
import { interactions } from "./schema";

export async function withReceipt(id: string, execute: (tx: Transaction) => Promise<string>) {
  return db().transaction(async (tx) => {
    const [receipt] = await tx.insert(interactions).values({ id, reply: "" }).onConflictDoNothing().returning();
    if (!receipt) {
      const [previous] = await tx.select({ reply: interactions.reply }).from(interactions).where(eq(interactions.id, id));
      return previous.reply;
    }
    const reply = await execute(tx);
    await tx.update(interactions).set({ reply }).where(eq(interactions.id, id));
    return reply;
  });
}

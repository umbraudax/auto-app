import { del, put } from "@vercel/blob";
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { resumeSchema, type Resume } from "./config";
import { db, type Transaction } from "./db";
import { withReceipt } from "./receipts";
import { docxMimeType, maxResumeBytes, resumeMimeType } from "./resume-file";
import { interactions, resumes, resumeSettings } from "./schema";

const pageSize = 12;
const ready = and(isNotNull(resumes.uploadedAt), isNull(resumes.deleteRequestedAt));

const privateStorage = {
  async upload(pathname: string, document: Buffer) {
    await put(pathname, document, {
      access: "private", contentType: docxMimeType, allowOverwrite: true,
      abortSignal: AbortSignal.timeout(20_000),
    });
  },
  async delete(pathnames: string[]) {
    await del(pathnames, { abortSignal: AbortSignal.timeout(12_000) });
  },
};

export type Attachment = { url: string; filename: string; size: number };
export type ResumeAction =
  | { operation: "upload"; file: Attachment; makeDefault: boolean }
  | { operation: "list"; page: number }
  | { operation: "default" | "delete"; id: string };

export function isDiscordAttachment(url: URL) {
  return url.protocol === "https:" && !url.port && !url.username && !url.password &&
    ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) &&
    /^\/(?:ephemeral-)?attachments\/\d+\/\d+\/[^/]+$/.test(url.pathname);
}

function configuredResume() {
  try {
    const config = JSON.parse(process.env.APPLICANT_PROFILE_JSON ?? "{}");
    return resumeSchema.safeParse(config?.resume).data;
  } catch {
    return undefined;
  }
}

async function lockLibrary(tx: Transaction, legacy?: Resume) {
  const [created] = await tx.insert(resumeSettings).values({ id: 1 }).onConflictDoNothing().returning();
  const [library] = await tx.select().from(resumeSettings).where(eq(resumeSettings.id, 1)).for("update");
  if (!created || !legacy) return library;
  const [record] = await tx.insert(resumes).values({ ...legacy, uploadedAt: new Date() })
    .onConflictDoNothing().returning();
  if (!record) return library;
  await tx.update(resumeSettings).set({ defaultResumeId: record.id }).where(eq(resumeSettings.id, 1));
  return { ...library, defaultResumeId: record.id };
}

export async function defaultResume(legacy?: Resume): Promise<Resume | undefined> {
  return db().transaction(async (tx) => {
    const library = await lockLibrary(tx, legacy);
    if (!library.defaultResumeId) return;
    const [resume] = await tx.select().from(resumes).where(and(ready, eq(resumes.id, library.defaultResumeId)));
    if (resume) return resumeSchema.parse(resume);
  });
}

const invalidDocx = "Attach a valid .docx resume up to 8 MB.";
const downloadFailed = "I couldn't download the resume from Discord. Attach it again and retry.";

async function downloadDocx(file: Attachment): Promise<{ document: Buffer } | { error: string }> {
  if (!/\.docx$/i.test(file.filename) || file.size > maxResumeBytes) return { error: invalidDocx };
  const url = new URL(file.url);
  if (!isDiscordAttachment(url)) return { error: downloadFailed };
  const response = await fetch(url, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(12_000),
  }).catch(() => undefined);
  if (!response?.ok || !response.body) return { error: downloadFailed };
  if (Number(response.headers.get("content-length")) > maxResumeBytes) {
    await response.body.cancel();
    return { error: invalidDocx };
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxResumeBytes) {
        await reader.cancel();
        return { error: invalidDocx };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { error: downloadFailed };
  } finally {
    reader.releaseLock();
  }
  const content = Buffer.concat(chunks, length);
  if (length !== file.size) return { error: downloadFailed };
  if (resumeMimeType(file.filename, content) !== docxMimeType) return { error: invalidDocx };
  return { document: content };
}

function safeFilename(filename: string) {
  const stem = filename.replace(/\.docx$/i, "").normalize("NFKC").replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/^[^a-zA-Z0-9]+/, "").trim().slice(0, 91);
  return `${stem || "Resume"}.docx`;
}

async function uploadResume(interactionId: string, file: Attachment, makeDefault: boolean, storage: typeof privateStorage) {
  const [prior] = await db().select().from(interactions).where(eq(interactions.id, interactionId));
  if (prior) return prior.reply;
  const download = await downloadDocx(file);
  if ("error" in download) return download.error;

  const pathname = `resumes/discord-${interactionId}.docx`;
  const filename = safeFilename(file.filename);
  await db().insert(resumes).values({ pathname, filename, version: `discord-${interactionId}` }).onConflictDoNothing();

  return withReceipt(interactionId, async (tx) => {
    const library = await lockLibrary(tx, configuredResume());
    const [record] = await tx.select().from(resumes).where(eq(resumes.pathname, pathname)).for("update");
    if (!record || record.deleteRequestedAt) throw new Error("Resume upload expired");
    if (!record.uploadedAt) {
      await storage.upload(pathname, download.document);
      await tx.update(resumes).set({ uploadedAt: new Date() }).where(eq(resumes.id, record.id));
    }
    const selected = makeDefault || !library.defaultResumeId;
    if (selected) {
      await tx.update(resumeSettings).set({ defaultResumeId: record.id }).where(eq(resumeSettings.id, 1));
    }
    return `Uploaded **${record.filename}** (${record.id}).${selected ? " Set as the default resume." : ""}`;
  });
}

const removed = "Resume removed from the library.";

export async function resumeCommand(interactionId: string, action: ResumeAction, storage = privateStorage) {
  if (!/^\d{17,22}$/.test(interactionId)) throw new Error("Invalid interaction ID");
  if (action.operation === "upload") return uploadResume(interactionId, action.file, action.makeDefault, storage);
  const reply = await withReceipt(interactionId, async (tx) => {
    const library = await lockLibrary(tx, configuredResume());
    if (action.operation === "list") {
      const records = await tx.select().from(resumes).where(ready).orderBy(desc(resumes.createdAt), desc(resumes.id))
        .limit(pageSize + 1).offset((action.page - 1) * pageSize);
      if (!records.length) return action.page === 1 ? "No resumes uploaded. Use `/resume upload`." : "No resumes on this page.";
      return [
        ...records.slice(0, pageSize).map(({ id, filename }) => `${id === library.defaultResumeId ? "Default · " : ""}${filename} · \`${id}\``),
        records.length > pageSize ? `Use /resume list page:${action.page + 1} for more.` : "",
      ].filter(Boolean).join("\n");
    }

    const [record] = await tx.select().from(resumes).where(and(ready, eq(resumes.id, action.id))).for("update");
    if (!record) return "That resume is unavailable. Use `/resume list` to see your resumes.";
    if (action.operation === "default") {
      await tx.update(resumeSettings).set({ defaultResumeId: record.id }).where(eq(resumeSettings.id, 1));
      return `Default resume set to **${record.filename}**.`;
    }

    await tx.update(resumes).set({ deleteRequestedAt: new Date() }).where(eq(resumes.id, record.id));
    if (library.defaultResumeId !== record.id) return removed;
    const [replacement] = await tx.select().from(resumes).where(ready).orderBy(desc(resumes.createdAt), desc(resumes.id)).limit(1);
    await tx.update(resumeSettings).set({ defaultResumeId: replacement?.id ?? null }).where(eq(resumeSettings.id, 1));
    return `${removed} ${replacement ? `Default switched to **${replacement.filename}**.` : "There is no default resume."}`;
  });
  if (action.operation !== "delete" || !reply.startsWith(removed)) return reply;
  try {
    await purgeResumes(action.id, storage);
    return reply;
  } catch {
    return `${reply} Deletion from private storage will retry automatically.`;
  }
}

export async function purgeResumes(id?: string, storage = privateStorage) {
  await db().transaction(async (tx) => {
    const eligible = or(isNotNull(resumes.deleteRequestedAt),
      and(isNull(resumes.uploadedAt), lt(resumes.createdAt, sql`now() - interval '1 hour'`)));
    const records = await tx.select().from(resumes)
      .where(id ? and(eligible, eq(resumes.id, id)) : eligible)
      .limit(id ? 1 : 10).for("update", id ? {} : { skipLocked: true });
    if (!records.length) return;
    await storage.delete(records.map(({ pathname }) => pathname));
    for (const record of records) await tx.delete(resumes).where(eq(resumes.id, record.id));
  });
}

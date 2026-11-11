import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { zipSync } from "fflate";
import { db } from "../lib/db";
import { docxMimeType, resumeMimeType } from "../lib/resume-file";
import { defaultResume, isDiscordAttachment, purgeResumes, resumeCommand } from "../lib/resumes";
import { resumes } from "../lib/schema";
import { docx } from "./resume-fixture";

const pdf = Buffer.from("%PDF-1.4\n% test fixture\n");

test("resume attachments are limited to Discord's HTTPS attachment endpoints", () => {
  assert.ok(isDiscordAttachment(new URL("https://cdn.discordapp.com/attachments/12/34/resume.docx?ex=test")));
  assert.ok(!isDiscordAttachment(new URL("https://cdn.discordapp.com.example.com/attachments/12/34/resume.docx")));
  assert.ok(!isDiscordAttachment(new URL("https://cdn.discordapp.com/avatars/12/34/resume.docx")));
});

test("resume format detection distinguishes DOCX from renamed files and recognizes legacy PDFs", () => {
  assert.equal(resumeMimeType("Resume.DOCX", docx), docxMimeType);
  assert.equal(resumeMimeType("Resume.docx", pdf), undefined);
  assert.equal(resumeMimeType("Resume.docx", Buffer.from(zipSync({ "other.txt": new Uint8Array([1]) }))), undefined);
  assert.equal(resumeMimeType("Resume.docx", docx.subarray(0, 50)), undefined);
  assert.equal(resumeMimeType("Legacy.pdf", pdf), "application/pdf");
});

test("resume upload, retries, defaults and deletion preserve the private library", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 25_000,
}, async (t) => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.match(url.pathname, /_test$/);
  process.env.DATABASE_URL = url.toString();
  t.after(() => db().$client.end());

  const legacy = { pathname: "resumes/legacy.pdf", filename: "Legacy.pdf", version: "legacy" };
  const files = new Map([[legacy.pathname, pdf]]);
  let blocked = false;
  let uploads = 0;
  const storage = {
    async upload(path: string, body: Buffer) {
      uploads++;
      assert.deepEqual(body, docx);
      files.set(path, body);
    },
    async delete(paths: string[]) {
      if (blocked) throw new Error("Storage unavailable");
      for (const path of paths) files.delete(path);
    },
  };
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(docx)));
  let id = BigInt(Date.now()) * 100_000n;
  const nextId = () => (++id).toString();
  assert.deepEqual(await defaultResume(legacy), legacy);

  const firstId = nextId();
  const file = {
    url: "https://cdn.discordapp.com/attachments/12/34/resume.docx?ex=test",
    filename: "Research Resume.DOCX", size: docx.length,
  };
  const upload = { operation: "upload" as const, file, makeDefault: false };
  const [first, duplicate] = await Promise.all([
    resumeCommand(firstId, upload, storage), resumeCommand(firstId, upload, storage),
  ]);
  assert.equal(first, duplicate);
  assert.equal(uploads, 1);
  assert.ok(files.has(`resumes/discord-${firstId}.docx`));
  assert.equal((await defaultResume())?.pathname, legacy.pathname);
  const upload2 = { ...upload, file: { ...file, filename: "Engineering Resume.docx" }, makeDefault: true };
  await resumeCommand(nextId(), upload2, storage);
  assert.equal((await defaultResume())?.filename, upload2.file.filename);
  const list = await resumeCommand(nextId(), { operation: "list", page: 1 }, storage);
  assert.match(list, /Default · Engineering Resume\.docx/);
  assert.match(list, /Research Resume\.docx/);

  const [selected] = await db().select().from(resumes).where(eq(resumes.filename, upload2.file.filename));
  const [firstResume] = await db().select().from(resumes).where(eq(resumes.filename, "Research Resume.docx"));
  await resumeCommand(nextId(), { operation: "default", id: firstResume.id }, storage);
  assert.equal((await defaultResume())?.pathname, firstResume.pathname);
  blocked = true;
  assert.match(await resumeCommand(nextId(), { operation: "delete", id: firstResume.id }, storage), /will retry/);
  assert.equal((await defaultResume())?.pathname, selected.pathname);
  assert.ok(files.has(firstResume.pathname));
  assert.doesNotMatch(await resumeCommand(nextId(), { operation: "list", page: 1 }, storage), /Research Resume/);
  blocked = false;
  await purgeResumes(undefined, storage);
  assert.ok(!files.has(firstResume.pathname));

  const [original] = await db().select().from(resumes).where(eq(resumes.pathname, legacy.pathname));
  await resumeCommand(nextId(), { operation: "delete", id: original.id }, storage);
  await resumeCommand(nextId(), { operation: "delete", id: selected.id }, storage);
  assert.equal(await defaultResume(legacy), undefined);
  assert.equal(files.size, 0);
  const callsBefore = fetch.mock.callCount();
  const invalid = await resumeCommand(nextId(), {
    ...upload, file: { ...file, url: "https://example.com/resume.docx" },
  }, storage);
  assert.match(invalid, /valid \.docx/);
  const newPdf = await resumeCommand(nextId(), {
    ...upload, file: { ...file, filename: "New Resume.pdf", size: pdf.length },
  }, storage);
  assert.match(newPdf, /valid \.docx/);
  assert.equal(fetch.mock.callCount(), callsBefore);
});

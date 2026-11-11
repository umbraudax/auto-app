import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { defaultResume, isDiscordAttachment, purgeResumes, resumeCommand } from "../lib/resumes";
import { resumes } from "../lib/schema";

test("resume attachments are limited to Discord's HTTPS attachment endpoints", () => {
  assert.ok(isDiscordAttachment(new URL("https://cdn.discordapp.com/attachments/12/34/resume.pdf?ex=test")));
  assert.ok(!isDiscordAttachment(new URL("https://cdn.discordapp.com.example.com/attachments/12/34/resume.pdf")));
  assert.ok(!isDiscordAttachment(new URL("https://cdn.discordapp.com/avatars/12/34/resume.pdf")));
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
  const pdf = Buffer.from("%PDF-1.4\n% test fixture\n");
  const files = new Map([[legacy.pathname, pdf]]);
  let blocked = false;
  let uploads = 0;
  const storage = {
    async upload(path: string, body: Buffer) {
      uploads++;
      assert.deepEqual(body, pdf);
      files.set(path, body);
    },
    async delete(paths: string[]) {
      if (blocked) throw new Error("Storage unavailable");
      for (const path of paths) files.delete(path);
    },
  };
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(pdf)));
  let id = BigInt(Date.now()) * 100_000n;
  const nextId = () => (++id).toString();
  assert.deepEqual(await defaultResume(legacy), legacy);

  const firstId = nextId();
  const file = {
    url: "https://cdn.discordapp.com/attachments/12/34/resume.pdf?ex=test",
    filename: "Research Resume.pdf", size: pdf.length,
  };
  const upload = { operation: "upload" as const, file, makeDefault: false };
  const [first, duplicate] = await Promise.all([
    resumeCommand(firstId, upload, storage), resumeCommand(firstId, upload, storage),
  ]);
  assert.equal(first, duplicate);
  assert.equal(uploads, 1);
  assert.equal((await defaultResume())?.pathname, legacy.pathname);
  const upload2 = { ...upload, file: { ...file, filename: "Engineering Resume.pdf" }, makeDefault: true };
  await resumeCommand(nextId(), upload2, storage);
  assert.equal((await defaultResume())?.filename, upload2.file.filename);
  const list = await resumeCommand(nextId(), { operation: "list", page: 1 }, storage);
  assert.match(list, /Default · Engineering Resume\.pdf/);
  assert.match(list, /Research Resume\.pdf/);

  const [selected] = await db().select().from(resumes).where(eq(resumes.filename, upload2.file.filename));
  const [firstResume] = await db().select().from(resumes).where(eq(resumes.filename, upload.file.filename));
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
    ...upload, file: { ...file, url: "https://example.com/resume.pdf" },
  }, storage);
  assert.match(invalid, /valid PDF/);
  assert.equal(fetch.mock.callCount(), callsBefore);
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { chromium } from "playwright-core";
import { isolate, prepareForm } from "../lib/browser";
import { docxMimeType } from "../lib/resume-file";
import { docx } from "./resume-fixture";

test("an unknown answer stops preparation and a later offline preview attaches the DOCX", {
  skip: !process.env.TEST_CHROMIUM_PATH,
  timeout: 40_000,
}, async (t) => {
  const resume = { pathname: "resumes/test.docx", filename: "Test Resume.docx", version: "fixture" };
  const profile = { firstName: "Test", lastName: "Applicant", email: "test@example.com", resume };
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = createRequire(require.resolve("@vercel/blob"))("undici") as typeof import("undici");
  const dispatcher = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  mock.get("https://teststore.private.blob.vercel-storage.com").intercept({ path: "/resumes/test.docx" }).reply(200, docx, {
    headers: { "content-length": String(docx.length), "content-type": docxMimeType },
  });
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_teststore_test";
  setGlobalDispatcher(mock);
  t.after(async () => {
    setGlobalDispatcher(dispatcher);
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await mock.close();
  });

  const browser = await chromium.launch({ executablePath: process.env.TEST_CHROMIUM_PATH, headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const goOffline = await isolate(context);
    const page = await context.newPage();
    await page.setContent(`
      <form action="https://job-boards.greenhouse.io/example/jobs/123" method="post">
        <label>First Name <input id="first_name" required></label>
        <label>Last Name <input id="last_name" required></label>
        <label>Email <input id="email" type="email" required></label>
        <label>Resume <input id="resume" type="file" accept=".docx" required></label>
        <label for="auth">Are you authorized to work?</label>
        <select id="auth" required>
          <option value="">Select…</option><option value="yes">Yes</option><option value="no">No</option>
        </select>
        <label for="season" id="season-label">Which season can you start?</label>
        <div class="select__control">
          <input id="season" role="combobox" aria-labelledby="season-label" aria-required="true">
          <span class="select__single-value"></span>
        </div>
        <button type="submit">Submit application</button>
      </form>
      <script>
        window.submitCount = 0;
        document.querySelector('form').addEventListener('submit', () => window.submitCount++);
        document.querySelector('#first_name').addEventListener('input', () => {
          window.attempt = fetch('https://job-boards.greenhouse.io/example/jobs/123?name=Test')
            .then(() => 'sent', () => 'blocked');
        });
        const input = document.querySelector('#season');
        const closeList = () => {
          document.querySelector('#season-options')?.remove();
          input.removeAttribute('aria-controls');
        };
        input.addEventListener('click', () => {
          closeList();
          const list = document.createElement('div');
          list.id = 'season-options';
          list.setAttribute('role', 'listbox');
          list.innerHTML = '<div role="option">Spring</div><div role="option">Summer</div>';
          list.addEventListener('click', (event) => {
            document.querySelector('.select__single-value').textContent = event.target.textContent;
            closeList();
          });
          input.setAttribute('aria-controls', list.id);
          input.after(list);
        });
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') closeList();
        });
      </script>
    `);
    await goOffline();
    const form = page.locator("form");
    const pending = await prepareForm(page, form, "example", profile, {}, async ([first]) => first);
    assert.equal(pending.type, "question");
    if (pending.type !== "question") return;
    assert.deepEqual(pending.question.options, ["Yes", "No"]);
    assert.equal(await form.locator("#first_name").inputValue(), "");
    const answers = { [pending.question.key]: "Yes" };
    const followUp = await prepareForm(page, form, "example", profile, answers, async ([first]) => first);
    assert.equal(followUp.type, "question");
    if (followUp.type !== "question") return;
    assert.deepEqual(followUp.question.options, ["Spring", "Summer"]);
    const outcome = await prepareForm(page, form, "example", profile, answers, async ([first]) => first,
      async (questions) => new Map(questions.map(({ promptId }) => [promptId, "Summer"])));
    assert.equal(outcome.type, "preview");
    if (outcome.type !== "preview") return;
    assert.ok(outcome.image.length > 100);
    assert.equal(outcome.resumeVersion, resume.version);
    assert.equal(outcome.memoryAnswers, 1);
    assert.equal(await form.locator("#first_name").inputValue(), "Test");
    assert.equal(await form.locator("#auth").inputValue(), "yes");
    assert.equal(await form.locator(".select__single-value").textContent(), "Summer");
    const file = await form.locator("#resume").evaluate((input: HTMLInputElement) => {
      const selected = input.files?.[0];
      return selected && { name: selected.name, type: selected.type, size: selected.size };
    });
    assert.deepEqual(file, { name: resume.filename, type: docxMimeType, size: docx.length });
    mock.assertNoPendingInterceptors();
    assert.equal(await page.evaluate("window.attempt"), "blocked");
    assert.equal(await page.evaluate("window.submitCount"), 0);
  } finally {
    await browser.close();
  }
});

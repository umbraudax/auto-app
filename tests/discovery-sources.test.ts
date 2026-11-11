import assert from "node:assert/strict";
import test from "node:test";
import { claimRegistryBoards, recordBoardCheck, registerBoards } from "../lib/board-registry";
import { db } from "../lib/db";
import { boardFromUrl, parseFeed } from "../lib/feeds";
import { isTechnicalInternship } from "../lib/internship-titles";
import { parsePublicInternships } from "../lib/public-internships";

test("automatic title matching finds SWE, IT, and cyber internships", () => {
  for (const title of ["Software Engineer Intern", "IT Support Co-op", "Cyber Security Internship", "DevSecOps Intern"]) {
    assert.ok(isTechnicalInternship(title), title);
  }
  for (const title of ["Senior Software Engineer", "Physical Security Intern", "Cloud Sales Internship", "Accounting Intern"]) {
    assert.equal(isTechnicalInternship(title), false, title);
  }
});

test("curated feeds preserve direct employer links and ignore closed, stale, and unrelated jobs", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");
  const job = {
    id: "first", title: "Software Engineer Intern", company_name: "Example", active: true, is_visible: true,
    date_updated: now / 1000, url: "https://job-boards.greenhouse.io/example/jobs/123", locations: ["New York"],
  };
  const result = parsePublicInternships("simplify", [
    job,
    { ...job, id: "closed", active: false },
    { ...job, id: "old", date_updated: 0, date_posted: 1500000000 },
    { ...job, id: "unrelated", title: "Marketing Intern" },
    { ...job, id: "bad", url: "javascript:alert(1)" },
  ], now);
  assert.equal(result.postings.length, 1);
  assert.equal(result.postings[0].source, "greenhouse");
  assert.equal(result.postings[0].externalId, "123");
  assert.deepEqual(result.boards, [{ source: "greenhouse", slug: "example", company: "Example" }]);

  const direct = parsePublicInternships("applyguy", { jobs: [{
    id: "123", title: "IT Intern", company: "Example",
    url: "https://applyguy.ai/one-click", listingUrl: "https://example.com/jobs/123",
  }] }, now);
  assert.equal(direct.postings[0].source, "public_feed");
  assert.equal(direct.postings[0].url, "https://example.com/jobs/123");
});

test("new ATS adapters recognize board links and normalize postings", () => {
  const smart = boardFromUrl("https://jobs.smartrecruiters.com/BoschGroup/123-software-engineer")!;
  const work = boardFromUrl("https://apply.workable.com/example/j/ABCD/apply")!;
  assert.equal(smart.source, "smartrecruiters");
  assert.equal(work.source, "workable");
  assert.equal(boardFromUrl("https://apply.workable.com/j/ABCD"), undefined);
  assert.equal(parseFeed(smart, { content: [{ id: "123", name: "Software Intern" }] })[0].url,
    "https://jobs.smartrecruiters.com/BoschGroup/123");
  const job = parseFeed(work, { jobs: [{ shortcode: "ABCD", title: "IT Intern", url: "https://apply.workable.com/j/ABCD", description: "<p>Help desk</p>" }] })[0];
  assert.equal(job.description, "Help desk");
  assert.equal(job.url, "https://apply.workable.com/j/ABCD");
});

test("the registry deduplicates boards and leases due checks across concurrent runs", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 20_000,
}, async (t) => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.match(url.pathname, /_test$/);
  process.env.DATABASE_URL = url.toString();
  process.env.DISCOVERY_BOARD_CHECKS = "1";
  t.after(() => db().$client.end());
  const board = { source: "greenhouse", slug: "registry-fixture", company: "Registry Fixture" } as const;
  assert.equal(await registerBoards([board, { ...board, slug: "Registry-Fixture" }], "fixture"), 1);
  assert.equal(await registerBoards([board], "another-source"), 0);
  const [first, second] = await Promise.all([claimRegistryBoards([]), claimRegistryBoards([])]);
  const claims = [...first.boards, ...second.boards];
  assert.equal(claims.length, 1);
  await recordBoardCheck(claims[0], "checked");
  assert.equal((await claimRegistryBoards([])).boards.length, 0);
});

import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { interactionAction, interactionSchema, validSignature } from "../lib/discord";
import { canonicalUrl, greenhouseFormUrl, parseFeed } from "../lib/feeds";

test("Discord signatures bind the raw body and expire", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const timestamp = "1794360000";
  const body = '{"type":1}';
  const headers = new Headers({
    "x-signature-timestamp": timestamp,
    "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"),
  });
  assert.equal(validSignature(body, headers, key, Number(timestamp) * 1000), true);
  assert.equal(validSignature(body + " ", headers, key, Number(timestamp) * 1000), false);
  assert.equal(validSignature(body, headers, key, Number(timestamp) * 1000 + 301_000), false);
});

test("an answer modal binds the response to one application and one prompt", () => {
  const appId = randomUUID();
  const promptId = randomUUID();
  const id = `answer:${appId}:${promptId}:1`;
  const interaction = {
    id: "100000000000000000", application_id: "100000000000000001", token: "fake",
  };
  const pressed = interactionAction(interactionSchema.parse({ ...interaction, type: 3, data: { custom_id: id } }));
  assert.equal(pressed.modal?.data.custom_id, id);
  const submitted = interactionAction(interactionSchema.parse({
    ...interaction, type: 5, data: {
      custom_id: id,
      components: [{ type: 18, component: { type: 4, custom_id: "value", value: "Yes" } }],
    },
  }));
  assert.deepEqual(submitted.action, { type: "answer", appId, promptId, answer: "Yes", remember: true });
  const learned = interactionAction(interactionSchema.parse({
    ...interaction, type: 5, data: {
      custom_id: `answer:${appId}:${promptId}:2`,
      components: [{ type: 18, component: { type: 4, custom_id: "value", value: "Yes" } }],
    },
  }));
  assert.deepEqual(learned.action, { type: "answer", appId, promptId, answer: "Yes", remember: true, learn: true });
});

test("resume upload reads a signed Discord attachment option", () => {
  const id = "100000000000000002";
  const file = { id, filename: "Resume.pdf", size: 500, url: `https://cdn.discordapp.com/attachments/100000000000000003/${id}/Resume.pdf?ex=example` };
  const base = {
    id: "100000000000000000", application_id: "100000000000000001", token: "fake", type: 2,
  };
  const data = { name: "resume", options: [{ type: 1, name: "upload", options: [
    { name: "file", value: id }, { name: "set_default", value: true },
  ] }] };
  assert.deepEqual(interactionAction(interactionSchema.parse({ ...base, data: {
    ...data, resolved: { attachments: { [id]: file } },
  } })).action, { type: "resume", command: { operation: "upload", file, makeDefault: true } });
  assert.throws(() => interactionAction(interactionSchema.parse({ ...base, data })));
});

test("all three board adapters preserve canonical posting identity", () => {
  const [greenhouse] = parseFeed({ source: "greenhouse", company: "ACME", slug: "acme" }, { jobs: [{
    id: 123, title: "Engineer Intern", absolute_url: "https://boards.greenhouse.io/acme/jobs/123?gh_src=email",
    content: "&lt;p&gt;On-site internship&lt;/p&gt;", location: { name: "Boston" },
  }] });
  const [lever] = parseFeed({ source: "lever", company: "acme", slug: "acme" }, [{
    id: "xyz", text: "Engineer  intern", hostedUrl: "https://jobs.lever.co/acme/xyz",
    categories: { location: "Boston" }, lists: [{ text: "Qualifications", content: "<li>TypeScript</li>" }],
  }]);
  const ashby = parseFeed({ source: "ashby", company: "acme", slug: "acme" }, { jobs: [
    { title: "Engineer Intern", jobUrl: "https://jobs.ashbyhq.com/acme/123", isListed: true },
    { title: "Hidden", jobUrl: "https://jobs.ashbyhq.com/acme/456", isListed: false },
  ] });
  assert.equal(greenhouse.url, greenhouseFormUrl("acme", "123"));
  assert.equal(greenhouse.description, "On-site internship");
  assert.match(lever.description, /TypeScript/);
  assert.equal(ashby.length, 1);
  assert.equal(greenhouse.identity, lever.identity);
  assert.equal(lever.identity, ashby[0].identity);
  assert.match(canonicalUrl("https://example.com/jobs?gh_jid=7&utm_source=x#apply"), /\?gh_jid=7$/);
  assert.throws(() => greenhouseFormUrl("../other", "123"));
});

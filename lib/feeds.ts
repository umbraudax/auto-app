import { z } from "zod";
import { boardSchema, type Board } from "./config";

export function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function boardFromUrl(raw: string, company?: string): Board | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return;
    const [, slug] = url.pathname.split("/");
    const name = company ?? slug;
    const options = { slug, company: name };
    let candidate;
    switch (url.hostname) {
      case "job-boards.greenhouse.io":
      case "boards.greenhouse.io":
        candidate = { ...options, source: "greenhouse" };
        break;
      case "jobs.lever.co":
      case "jobs.eu.lever.co":
        candidate = { ...options, source: "lever", region: url.hostname === "jobs.eu.lever.co" ? "eu" : "global" };
        break;
      case "jobs.ashbyhq.com":
        candidate = { ...options, source: "ashby" };
        break;
      default:
        return;
    }
    return boardSchema.safeParse(candidate).data;
  } catch {
    return undefined;
  }
}

export function canonicalUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Expected a public HTTPS job URL");
  }
  if (url.hostname === "boards.greenhouse.io") url.hostname = "job-boards.greenhouse.io";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|gh_src|source|ref|lever-source|ashby_jid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function plain(html: string) {
  return html
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<\/?(?:p|ul|li|div|br|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:#39|apos);/gi, "'")
    .trim();
}

const greenhouse = z.object({
  jobs: z.array(z.object({
    id: z.number().int().positive(),
    title: z.string(),
    absolute_url: z.string(),
    content: z.string().optional(),
    location: z.object({ name: z.string() }).optional(),
  })),
});

const lever = z.array(z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  applyUrl: z.string().optional(),
  categories: z.object({ location: z.string().optional(), allLocations: z.array(z.string()).optional() }),
  descriptionPlain: z.string().optional(),
  additionalPlain: z.string().optional(),
  lists: z.array(z.object({ text: z.string(), content: z.string() })).optional(),
}));

const ashby = z.object({
  jobs: z.array(z.object({
    id: z.string().optional(),
    title: z.string(),
    jobUrl: z.string(),
    location: z.string().optional(),
    descriptionPlain: z.string().optional(),
    isListed: z.boolean().optional(),
  })),
});

export function feedUrl(board: Board, skip = 0) {
  const slug = encodeURIComponent(board.slug);
  switch (board.source) {
    case "greenhouse": return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    case "lever": return `https://api${board.region === "eu" ? ".eu" : ""}.lever.co/v0/postings/${slug}?mode=json&limit=100&skip=${skip}`;
    case "ashby": return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  }
}

export type Posting = {
  source: Board["source"];
  board: string;
  externalId: string;
  company: string;
  title: string;
  url: string;
  identity: string;
  location: string;
  description: string;
};

export function parseFeed(board: Board, payload: unknown): Posting[] {
  let rows: { id: string; title: string; url: string; location?: string; description?: string }[];
  switch (board.source) {
    case "greenhouse":
      rows = greenhouse.parse(payload).jobs.map((job) => ({
        id: String(job.id), title: job.title, url: job.absolute_url,
        location: job.location?.name, description: plain(job.content ?? ""),
      }));
      break;
    case "lever":
      rows = lever.parse(payload).map((job) => ({
        id: job.id, title: job.text, url: job.hostedUrl,
        location: job.categories.allLocations?.join(", ") || job.categories.location,
        description: [job.descriptionPlain, ...job.lists?.map((list) => plain(`${list.text}\n${list.content}`)) ?? [], job.additionalPlain]
          .filter(Boolean).join("\n"),
      }));
      break;
    case "ashby":
      rows = ashby.parse(payload).jobs.filter((job) => job.isListed !== false).map((job) => ({
        id: job.id ?? canonicalUrl(job.jobUrl), title: job.title, url: job.jobUrl,
        location: job.location, description: job.descriptionPlain,
      }));
      break;
  }

  return rows.map((job) => ({
    source: board.source,
    board: board.slug,
    company: board.company,
    externalId: job.id,
    url: canonicalUrl(job.url),
    identity: JSON.stringify([normalize(board.company), normalize(job.title)]),
    title: job.title.trim().slice(0, 400),
    location: job.location?.trim().slice(0, 400) ?? "",
    description: job.description?.replaceAll("\u0000", "").slice(0, 24_000) ?? "",
  }));
}

export function greenhouseFormUrl(board: string, externalId: string) {
  if (!/^[\w-]{1,100}$/.test(board) || !/^\d{1,20}$/.test(externalId)) {
    throw new Error("Invalid Greenhouse posting identity");
  }
  return `https://job-boards.greenhouse.io/${encodeURIComponent(board)}/jobs/${externalId}`;
}

import { z } from "zod";
import { boardFromUrl, plain, toPosting, type Posting } from "./feeds";
import { isTechnicalInternship } from "./internship-titles";
import type { PublicSource } from "./public-source-catalog";

type PublicListing = {
  id: string; company: string; title: string; url: string; location?: string; description?: string; posted?: number;
  internshipHint?: boolean;
};

const simplify = z.object({
  id: z.string(), company_name: z.string(), title: z.string(), url: z.string(),
  locations: z.array(z.string()).optional(), date_posted: z.number().optional(), date_updated: z.number().optional(),
  active: z.boolean(), is_visible: z.boolean(),
}).transform((job): PublicListing | undefined => job.active && job.is_visible ? {
  id: job.id, company: job.company_name, title: job.title, url: job.url, location: job.locations?.join(", "),
  posted: Math.max(job.date_posted ?? 0, job.date_updated ?? 0) * 1000 || undefined,
} : undefined);

const applyguy = z.object({
  id: z.string(), company: z.string(), title: z.string(), listingUrl: z.string(),
  location: z.string().nullish(), posted: z.string().optional(),
}).transform((job): PublicListing => ({
  id: job.id, company: job.company, title: job.title, url: job.listingUrl, location: job.location ?? undefined,
  posted: job.posted ? Date.parse(job.posted) : undefined,
}));

const jobbie = z.object({
  id: z.string(), company: z.string(), title: z.string(), apply_url: z.string(),
  location: z.string().nullish(), posted_at: z.string().optional(),
}).transform((job): PublicListing => ({
  id: job.id, company: job.company, title: job.title, url: job.apply_url, location: job.location ?? undefined,
  posted: job.posted_at ? Date.parse(job.posted_at) : undefined,
}));

const jobicy = z.object({
  id: z.number().int(), companyName: z.string(), jobTitle: z.string(), url: z.string(),
  jobGeo: z.string().nullish(), jobDescription: z.string().nullish(), pubDate: z.string().optional(),
  jobType: z.array(z.string()).optional(),
}).transform((job): PublicListing => ({
  id: String(job.id), company: job.companyName, title: job.jobTitle, url: job.url, location: job.jobGeo ?? undefined,
  description: plain(job.jobDescription ?? ""), posted: job.pubDate ? Date.parse(job.pubDate) : undefined,
  internshipHint: job.jobType?.some((type) => /^intern(?:ship)?$/i.test(type)),
}));

const arbeitnow = z.object({
  slug: z.string(), company_name: z.string(), title: z.string(), url: z.string(),
  location: z.string().nullish(), description: z.string().nullish(), created_at: z.number().optional(),
  job_types: z.array(z.string()).optional(),
}).transform((job): PublicListing => ({
  id: job.slug, company: job.company_name, title: job.title, url: job.url, location: job.location ?? undefined,
  description: plain(job.description ?? ""), posted: job.created_at === undefined ? undefined : job.created_at * 1000,
  internshipHint: job.job_types?.some((type) => /^intern(?:ship)?$/i.test(type)),
}));

const parsers = { simplify, applyguy, jobbie, jobicy, arbeitnow };
const list = z.array(z.unknown());

export function parsePublicInternships(source: PublicSource, payload: unknown, now = Date.now()) {
  const entries = source === "simplify" ? list.parse(payload)
    : source === "arbeitnow" ? z.object({ data: list }).parse(payload).data
      : z.object({ jobs: list }).parse(payload).jobs;
  const cutoff = now - 120 * 86_400_000;
  const candidates = entries.flatMap((entry) => {
    const row = parsers[source].safeParse(entry).data;
    if (!row || !row.company.trim() || !isTechnicalInternship(row.title, row.internshipHint)) return [];
    if (row.posted !== undefined && Number.isFinite(row.posted) && row.posted < cutoff) return [];
    return [row];
  }).sort((left, right) => (right.posted || 0) - (left.posted || 0));

  const boards = [];
  const postings: Posting[] = [];
  for (const row of candidates.slice(0, 500)) {
    const company = row.company.trim().slice(0, 150);
    const board = boardFromUrl(row.url, company);
    try {
      const url = new URL(row.url);
      if (source === "jobicy" && url.hostname !== "jobicy.com") continue;
      if (source === "arbeitnow" && !["www.arbeitnow.com", "arbeitnow.com"].includes(url.hostname)) continue;
      const greenhouseId = board?.source === "greenhouse"
        ? url.pathname.match(/^\/[^/]+\/jobs\/(\d+)\/?$/)?.[1] : undefined;
      const posting = greenhouseId && board
        ? toPosting(board, { ...row, id: greenhouseId })
        : toPosting({ source: "public_feed", slug: source, company }, row);
      postings.push(posting);
      if (board) boards.push(board);
    } catch {
      // A malformed link only drops that listing.
    }
  }
  return { entries: entries.length, eligible: candidates.length, postings, boards };
}

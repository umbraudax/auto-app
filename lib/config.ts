import { z } from "zod";

const boardSources = ["greenhouse", "lever", "ashby", "smartrecruiters", "workable"] as const;
export const source = z.enum(boardSources);
export const jobSources = [...boardSources, "public_feed"] as const;
export type JobSource = typeof jobSources[number];
export const boardSchema = z.object({
  source,
  slug: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/),
  company: z.string().trim().min(1).max(150),
  region: z.enum(["global", "eu"]).optional(),
});
export type Board = z.infer<typeof boardSchema>;

export const criteriaSchema = z.object({
  description: z.string().trim().min(1).max(3500),
  titleTerms: z.array(z.string().trim().min(1).max(80)).max(30).default(["intern", "co-op"]),
  minimumScore: z.number().int().min(1).max(100).default(70),
  autoPreviewScore: z.number().int().min(1).max(101).default(101),
}).refine((value) => value.autoPreviewScore >= value.minimumScore);
export type Criteria = z.infer<typeof criteriaSchema>;

export const resumeSchema = z.object({
  pathname: z.string().regex(/^resumes\/[a-zA-Z0-9/_-]+\.(?:pdf|docx)$/i),
  filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,90}\.(?:pdf|docx)$/i),
  version: z.string().min(1).max(100),
});
export type Resume = z.infer<typeof resumeSchema>;

export const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.email(),
  phone: z.string().trim().min(1).max(50).optional(),
  location: z.string().trim().min(1).max(200).optional(),
  linkedin: z.url({ protocol: /^https$/ }).optional(),
  github: z.url({ protocol: /^https$/ }).optional(),
  website: z.url({ protocol: /^https$/ }).optional(),
  resume: resumeSchema.optional(),
}).strict();

export function required(key: string) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing environment variable ${key}`);
  return value;
}

export function numberEnv(key: string, fallback: number, maximum: number) {
  return z.coerce.number().int().min(0).max(maximum).parse(process.env[key] ?? fallback);
}

export function boards() {
  return z.array(boardSchema).max(100).parse(JSON.parse(process.env.JOB_BOARDS_JSON ?? "[]"));
}

export function defaultCriteria() {
  return criteriaSchema.parse(JSON.parse(process.env.CRITERIA_JSON ?? JSON.stringify({
    description: "Find internships or co-ops that match my preferences. Review all matches in Discord.",
  })));
}

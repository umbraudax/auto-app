export const publicSources = {
  simplify: { label: "SimplifyJobs / Pitt CSC", url: "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json" },
  applyguy: { label: "ApplyGuy", url: "https://raw.githubusercontent.com/ApplyGuy/2027-Internships/main/data/internships.json" },
  jobbie: { label: "Jobbie", url: "https://api.jobbie.bot/public/internships.json" },
  jobicy: { label: "Jobicy", url: "https://jobicy.com/api/jobs?count=200&tag=intern" },
  arbeitnow: { label: "Arbeitnow", url: "https://www.arbeitnow.com/api/job-board-api" },
} as const;

export type PublicSource = keyof typeof publicSources;
export const publicSourceIds = Object.keys(publicSources) as PublicSource[];

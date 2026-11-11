export type DiscoveryReport = {
  runId: string;
  phase: "Finding boards" | "Checking boards" | "Scoring candidates" | "Complete" | "Paused" | "Scoring blocked" | "Failed" | "No boards configured";
  boardsTotal: number;
  checked: number;
  skipped: number;
  boardErrors: number;
  listings: number;
  added: number;
  titleFiltered: number;
  scored: number;
  matches: number;
  scoreErrors: number;
  notes: string[];
  sources?: { checked: number; cached: number; failed: number; entries: number; boardsAdded: number; registryTotal: number };
};

export function discoverySummary(report: DiscoveryReport) {
  const { runId, phase, boardsTotal, checked, skipped, boardErrors, listings, added, titleFiltered, scored, matches, scoreErrors, notes } = report;
  if (phase === "No boards configured") {
    return `No job boards configured. Use /discover with a board URL for a one-time search or set JOB_BOARDS_JSON.\nRun \`${runId}\``;
  }
  const lines = [
    `**Discovery · ${phase}**`,
    ...report.sources ? [
      `Public feeds ${report.sources.checked} checked · ${report.sources.cached} on cooldown · ${report.sources.failed} failed`,
      `${report.sources.entries} feed entries screened · ${report.sources.boardsAdded} boards added · ${report.sources.registryTotal} registered`,
    ] : [],
    `Boards checked ${checked}/${boardsTotal} · ${skipped} skipped · ${boardErrors} failed`,
    `Listings read ${listings} · ${added} new · ${titleFiltered} filtered by title`,
    `Scored by Claude ${scored} · ${matches} met the fit cutoff · ${scoreErrors} scoring errors`,
    ...notes.slice(0, 5),
  ];
  if (phase === "Complete" && !scored && !scoreErrors && !notes.length) {
    lines.push("No eligible unscored jobs were available.");
  }
  if (notes.length > 5) lines.push(`${notes.length - 5} more details in the run log.`);
  lines.push(`Run \`${runId}\``);
  return lines.join("\n");
}

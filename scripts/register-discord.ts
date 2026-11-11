import { required } from "../lib/config";
import { discord, snowflake } from "../lib/discord";

const statuses = ["submitted", "confirmed", "rejected", "interview"];
const definitions = [
  { name: "status", description: "Show the application queue" },
  { name: "discover", description: "Check the configured job boards now" },
  { name: "pause", description: "Pause or resume discovery and previews", options: [
    { type: 5, name: "enabled", description: "Use false to resume" },
  ] },
  { name: "criteria", description: "Show or change your job search criteria", options: [
    { type: 3, name: "description", description: "Role, location, timing and eligibility criteria", max_length: 3500 },
    { type: 3, name: "titles", description: "Comma-separated title terms. Use a comma alone to match all titles.", max_length: 500 },
    { type: 4, name: "minimum", description: "Minimum fit score", min_value: 1, max_value: 100 },
    { type: 4, name: "auto_preview", description: "Fit score for automatic previews. Use 101 to turn them off.", min_value: 1, max_value: 101 },
  ] },
  { name: "skipcompany", description: "Skip all pending and future matches from a company", options: [
    { type: 3, name: "company", description: "Company name as shown in the posting", required: true, max_length: 150 },
  ] },
  { name: "record", description: "Update an application from its thread", options: [
    { type: 3, name: "state", description: "Application status", required: true,
      choices: statuses.map((state) => ({ name: state, value: state })) },
  ] },
  { name: "resume", description: "Manage your private resume library", options: [
    { type: 1, name: "upload", description: "Upload a PDF resume", options: [
      { type: 11, name: "file", description: "PDF resume up to 8 MB", required: true },
      { type: 5, name: "set_default", description: "Use this resume for future previews" },
    ] },
    { type: 1, name: "list", description: "List your uploaded resumes and the default", options: [
      { type: 4, name: "page", description: "Page number", min_value: 1, max_value: 1_000_000 },
    ] },
    ...["default", "delete"].map((name) => ({
      type: 1, name, description: name === "default" ? "Select your default resume" : "Delete a stored resume",
      options: [{ type: 3, name: "id", description: "Resume ID from /resume list", required: true, max_length: 36 }],
    })),
  ] },
];

async function main() {
  const app = snowflake.parse(required("DISCORD_APPLICATION_ID"));
  const guild = snowflake.parse(required("DISCORD_GUILD_ID"));
  for (const definition of definitions) {
    await discord(`/applications/${app}/guilds/${guild}/commands`, "POST", { type: 1, ...definition });
  }
  console.log(`Registered ${definitions.length} guild commands.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Registration failed.");
  process.exitCode = 1;
});

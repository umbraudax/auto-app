# Autoapp

A personal Discord bot for discovering, scoring, and reviewing job applications. Vercel runs the Next.js endpoints, Cron, and Workflow steps. Neon Postgres stores the queue and audit log. Browserbase runs Chromium, and Vercel Blob stores resumes and previews in a private store.

Autoapp runs in **dry-run mode**. Apply queues a Greenhouse preview or creates a manual application thread for Lever and Ashby. Review the screenshot, submit in the employer's own form, and use `/record` in the thread to track the result. Automatic submission and automatic confirmation are outside this version.

## Setup

1. Use Node 22.13 or newer and run `npm ci`. Copy [.env.example](.env.example) to `.env.local`. Use the same environment variables in the Vercel project. Keep the profile and tokens in environment variables.
2. Create a Neon database, set `DATABASE_URL` to its pooled connection string, and run `npm run db:migrate`. The migration can be rerun.
3. Create a **private** Blob store and set `BLOB_READ_WRITE_TOKEN`. Set the Browserbase project ID and key and the Anthropic API key. Put your approved contact details in `APPLICANT_PROFILE_JSON`.
4. Set `JOB_BOARDS_JSON` to the employers you want to follow. Each entry has a source of `greenhouse`, `lever`, or `ashby`, the employer's board slug, and the company name you want Discord to display. Set `region` to `eu` for Lever EU boards. No employer is configured by default. Put the role, location, season, and eligibility requirements in `CRITERIA_JSON`. Avoid including personal identifiers in the criteria sent to Claude.
5. Create a Discord application and bot. Install it in your server with the `bot` and `applications.commands` scopes. Give it View Channel, Send Messages, Embed Links, Attach Files, Create Public Threads, Send Messages in Threads, and Read Message History in one **private text channel** that only you and the bot can see. Application previews can contain applicant information. Put that channel's ID, the server ID, your Discord user ID, the application ID, public key, and bot token in the environment.
6. Deploy the Next.js project to Vercel with a random `CRON_SECRET`. Set Discord's Interactions Endpoint URL to your production URL plus `/api/discord`. Register the guild commands with `npm run discord:register`. Only the configured Discord user in the configured server can invoke them.
7. Use `/resume upload` in Discord to add a PDF and select it as the default. Run `/discover` to check the feeds. Use Apply on a Greenhouse match, answer any questions in its thread, and inspect the preview. Start with a test profile. Vercel Blob stores the screenshot and the bot attaches it to the configured private Discord channel's thread.

For an existing deployment, apply the database migration with `npm run db:migrate`, deploy the updated app, then run `npm run discord:register` to add the resume commands.

`npm run dev` runs the local Next.js app and local Workflow world. `npm run check`, `npm test`, and `npm run build` check types, run tests, and build for production. The browser and Postgres integration tests opt in with `TEST_CHROMIUM_PATH` and `TEST_DATABASE_URL`. Point the latter at a dedicated database whose name ends in `_test`.

## Discord commands

| Command | Effect |
| --- | --- |
| `/status` | Show pending matches, application counts, and whether the bot is paused. |
| `/discover` | Start a job feed check now. |
| `/pause` or `/pause enabled:false` | Pause or resume new discovery and previews. An in-progress preview can finish. |
| `/criteria` | Show or update the search criteria, title terms, score cutoff, and automatic preview threshold. A threshold of 101 keeps every match behind the Apply button. |
| `/skipcompany` | Skip the company's pending and future matches. |
| `/record` | Mark a manually handled application as submitted, confirmed, rejected, or interview from its thread. |
| `/resume upload file:<PDF> set_default:true` | Store a PDF up to 8 MB privately. The first resume becomes the default automatically. Set `set_default:true` to replace the current default. |
| `/resume list` | List uploaded resumes, their IDs, and the current default. |
| `/resume default id:<ID>` | Select the resume that future previews will attach. |
| `/resume delete id:<ID>` | Remove a resume from the library and private storage. Deleting the default selects the newest remaining resume. |

An existing `APPLICANT_PROFILE_JSON.resume` is imported when the resume library is first used. After that, Discord manages the default and can delete the imported file.

## How previews work

- The database deduplicates by canonical URL, board posting ID, and normalized company and title. One application row can exist per job. Repeated button presses and stale question responses cannot create extra applications.
- Discord acknowledges signed interactions before processing. When a required question still needs your input, the bot @mentions you in the application thread, saves the pending question, and releases the browser. Your reply queues a fresh preview.
- **Answer and save** stores the question, your reply, and its job context in Postgres. **Answer once** keeps the response with the current application. Previously remembered exact-match answers retain their employer scope. Those legacy entries contain a question hash and are reused for exact matches.
- Haiku scores job descriptions and Sonnet can prioritize unanswered required fields. For supported fields, Opus receives the current question, job context, and relevant saved replies. It drafts an answer only from your explicit statements, cites those statements, and checks the draft in a second pass. Missing support, conflicting replies, an exhausted budget, or a model failure leaves the question for you. Only your Discord replies can become new memory. The preview identifies when Opus filled fields from memory.
- Playwright fills known profile fields, your replies, and supported answers from memory. Required controls that the adapter cannot resolve go to manual handling.
- The browser loads the Greenhouse-hosted form from approved domains using read-only requests. It goes offline before filling the form or attaching a resume. Logins, CAPTCHAs, unsupported controls, and validation failures go to the application thread for manual handling.
- The daily budget and preview caps reset at midnight UTC. The default budget is 250,000 microdollars ($0.25) of Claude usage. The preview cap counts browser attempts, including resumed previews. Vercel Cron checks the feeds and posts a digest once per day by default. A Pro project can shorten the discovery interval in `vercel.json`. Cron processes any saved queue entries and retries pending messages.

Vercel's standard function bundle limit is 250 MB uncompressed. With Fluid compute, Hobby functions can run for up to 300 seconds. Pro and Enterprise default to 300 seconds with higher opt-in limits. This project uses the Playwright client to connect to a hosted browser. [Vercel Functions limits](https://vercel.com/docs/functions/limitations) · [Cron plan limits](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing) · [Browserbase Playwright connection](https://docs.browserbase.com/platform/browser/getting-started/using-browser-session)

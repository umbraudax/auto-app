import { cron } from "../../../../lib/dispatch";

export const runtime = "nodejs";

export function GET(request: Request) {
  return cron(request, "discover");
}

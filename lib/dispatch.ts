import { timingSafeEqual } from "node:crypto";
import { start } from "workflow/api";
import { pipeline } from "../workflows/pipeline";
import { boards, required, type Board } from "./config";

export function dispatch(kind: "discover" | "process" | "digest", selected?: Board[], notify = false) {
  const targets = kind === "discover" ? selected ?? boards() : [];
  return start(pipeline, [kind, targets, new Date().toISOString().slice(0, 10), notify, kind === "discover" && selected === undefined]);
}

export async function cron(request: Request, kind: "discover" | "digest") {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${required("CRON_SECRET")}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const run = await dispatch(kind);
  return Response.json({ runId: run.runId }, { status: 202 });
}

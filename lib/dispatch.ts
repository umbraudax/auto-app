import { timingSafeEqual } from "node:crypto";
import { start } from "workflow/api";
import { pipeline } from "../workflows/pipeline";
import { boards, required } from "./config";

export function dispatch(kind: "discover" | "process" | "digest") {
  return start(pipeline, [kind, kind === "discover" ? boards() : [], new Date().toISOString().slice(0, 10)]);
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

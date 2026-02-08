import { NextResponse } from "next/server";
import { listRuns, runsDirectory } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const runs = await listRuns(50);
  return NextResponse.json({
    ok: true,
    runs,
    store: { dir: runsDirectory(), type: "disk+memory" },
  });
}
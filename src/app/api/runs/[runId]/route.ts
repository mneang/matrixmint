import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function wantDownload(req: NextRequest) {
  const u = new URL(req.url);
  const qp = u.searchParams.get("download");
  const hdr = req.headers.get("x-matrixmint-download");
  return qp === "1" || qp === "true" || hdr === "1" || hdr === "true";
}

function filename(runId: string) {
  return `matrixmint-run-${runId}.json`;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;

  const run = await getRun(runId);
  if (!run) {
    return NextResponse.json({ ok: false, error: `Run not found: ${runId}` }, { status: 404 });
  }

  if (!wantDownload(req)) {
    return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
  }

  const body = JSON.stringify(run, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename(runId)}"`,
      "x-matrixmint-run-id": runId,
      "Cache-Control": "no-store",
    },
  });
}
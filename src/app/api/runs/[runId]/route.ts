import { NextRequest, NextResponse } from "next/server";

// IMPORTANT:
// Next's generated route type validator (in newer Next versions) expects:
// context: { params: Promise<{ runId: string }> }
// So we accept params as Promise OR object and normalize safely.

type ParamsShape = { runId: string };
type Ctx = { params: ParamsShape | Promise<ParamsShape> };

// If you store run results in memory, import your store here.
// Example (adjust to your project):
// import { getRunBundleById } from "@/lib/runStore";

// If you store on disk, import fs/path helpers etc.
// For now, this file assumes you already had working logic and we're only fixing typing.

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const params = await Promise.resolve(ctx.params);
    const runId = params?.runId;

    if (!runId) {
      return NextResponse.json({ ok: false, error: "Missing runId" }, { status: 400 });
    }

    // ---- YOUR EXISTING LOOKUP LOGIC GOES HERE ----
    // Replace the placeholder below with whatever you previously returned.
    //
    // Examples:
    // const bundle = await getRunBundleById(runId);
    // if (!bundle) return NextResponse.json({ ok:false, error:"Run not found" }, {status:404});
    // return NextResponse.json({ ok:true, ...bundle }, {status:200});

    return NextResponse.json(
      { ok: false, error: "Not implemented: wire GET /api/runs/[runId] to your run store." },
      { status: 501 }
    );
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
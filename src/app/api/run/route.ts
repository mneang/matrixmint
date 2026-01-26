import { NextRequest, NextResponse } from "next/server";

/**
 * /api/run
 * Orchestrates:
 *  1) /api/analyze
 *  2) /api/export?format=bundle_json
 *
 * Adds:
 *  - orchestrator metadata
 *  - runSummary proof fields (non-breaking)
 *  - stores the bundle in an in-memory run store (for /api/runs replay)
 */

type RunBody = {
  rfpText?: string;
  capabilityText?: string;
  model?: string;
  sampleId?: string;
  download?: boolean;
};

function nowIso() {
  return new Date().toISOString();
}

function randId(prefix = "run") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, text, json };
}

function pickForwardHeaders(req: NextRequest) {
  const out: Record<string, string> = { "Content-Type": "application/json" };

  const mode = req.headers.get("x-matrixmint-mode");
  const bust = req.headers.get("x-matrixmint-bust-cache");
  const clear = req.headers.get("x-matrixmint-clear-cache");

  if (mode) out["x-matrixmint-mode"] = mode;
  if (bust) out["x-matrixmint-bust-cache"] = bust;
  if (clear) out["x-matrixmint-clear-cache"] = clear;

  return out;
}

// ---- Run store (in-memory) ----
type StoredRun = {
  runId: string;
  createdAtIso: string;
  orchestrator: any;
  runSummary: any;
  exports: Record<string, string>;
  // Keep minimal but useful: full result can be big; we store it anyway for replay
  result: any;
  meta: any;
};

function getStore(): Map<string, StoredRun> {
  const g = globalThis as any;
  if (!g.__MATRIXMINT_RUNS) g.__MATRIXMINT_RUNS = new Map<string, StoredRun>();
  return g.__MATRIXMINT_RUNS;
}

function storeRun(run: StoredRun) {
  const store = getStore();
  store.set(run.runId, run);

  // Cap memory: keep last ~25 runs (simple eviction)
  if (store.size > 25) {
    const keys = Array.from(store.keys());
    const toDelete = keys.slice(0, store.size - 25);
    for (const k of toDelete) store.delete(k);
  }
}

export async function POST(req: NextRequest) {
  const runId = randId("matrixmint");
  const startedAt = Date.now();

  try {
    const origin = req.nextUrl.origin;
    const body = (await req.json().catch(() => null)) as RunBody | null;

    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "Missing JSON body" }, { status: 400 });
    }

    const model = body.model || "gemini-3-flash-preview";

    let rfpText = body.rfpText;
    let capabilityText = body.capabilityText;

    if (body.sampleId) {
      const s = await fetchJson(`${origin}/api/samples`, { method: "GET" });
      if (!s.res.ok || !s.json?.samples?.length) {
        return NextResponse.json(
          { ok: false, error: "Failed to load samples", details: { status: s.res.status, body: s.text.slice(0, 200) } },
          { status: 500 }
        );
      }

      const sample = s.json.samples.find((x: any) => x?.id === body.sampleId) ?? s.json.samples[0];
      rfpText = sample?.rfpText;
      capabilityText = sample?.capabilityText;

      if (!rfpText || !capabilityText) {
        return NextResponse.json({ ok: false, error: "Sample missing rfpText/capabilityText" }, { status: 400 });
      }
    }

    if (!rfpText || !capabilityText) {
      return NextResponse.json(
        { ok: false, error: "Missing rfpText or capabilityText (or provide sampleId)" },
        { status: 400 }
      );
    }

    // 1) Analyze
    const headers = pickForwardHeaders(req);

    const analyze = await fetchJson(`${origin}/api/analyze`, {
      method: "POST",
      headers,
      body: JSON.stringify({ rfpText, capabilityText, model }),
    });

    if (!analyze.res.ok || !analyze.json?.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Analyze failed",
          runId,
          details: {
            httpStatus: analyze.res.status,
            responsePreview: analyze.text.slice(0, 500),
            out: analyze.json ?? null,
          },
        },
        { status: 502 }
      );
    }

    const analyzeOut = analyze.json; // { ok:true, data, meta }
    const data = analyzeOut.data;
    const meta = analyzeOut.meta;

    // 2) Bundle export
    const bundle = await fetchJson(`${origin}/api/export?format=bundle_json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result: data, meta }),
    });

    if (!bundle.res.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Bundle export failed",
          runId,
          details: {
            httpStatus: bundle.res.status,
            responsePreview: bundle.text.slice(0, 500),
          },
        },
        { status: 502 }
      );
    }

    const payload = bundle.json ?? {};
    payload.orchestrator = {
      runId,
      modelRequested: model,
      startedAtIso: new Date(startedAt).toISOString(),
      finishedAtIso: nowIso(),
      elapsedMs: Date.now() - startedAt,
      modelUsed: meta?.modelUsed ?? undefined,
      cache: meta?.cache ?? undefined,
      warnings: meta?.warnings ?? [],
    };

    // Make proof fields explicit for judge clarity (non-breaking)
    const sum = data?.summary ?? {};
    payload.runSummary = payload.runSummary || {};
    if (typeof sum.proofPercent === "number") payload.runSummary.proofPercent = sum.proofPercent;
    if (typeof sum.proofVerifiedCount === "number") payload.runSummary.proofVerifiedCount = sum.proofVerifiedCount;
    if (typeof sum.proofTotalEvidenceRefs === "number") payload.runSummary.proofTotalEvidenceRefs = sum.proofTotalEvidenceRefs;

    // Store run for replay endpoints
    try {
      storeRun({
        runId,
        createdAtIso: payload.orchestrator.startedAtIso,
        orchestrator: payload.orchestrator,
        runSummary: payload.runSummary,
        exports: payload.exports || {},
        result: payload.result || null,
        meta: payload.meta || null,
      });
    } catch {
      // no-op if store fails; do not break run endpoint
    }

    const json = JSON.stringify(payload, null, 2);

    const download = Boolean(body.download);
    const headersOut: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "x-matrixmint-run-id": runId,
    };
    if (download) {
      headersOut["Content-Disposition"] = `attachment; filename="matrixmint-run-${runId}.json"`;
    }

    return new NextResponse(json, { status: 200, headers: headersOut });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message ?? "Run failed"), runId },
      { status: 500 }
    );
  }
}
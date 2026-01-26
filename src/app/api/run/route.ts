import { NextRequest, NextResponse } from "next/server";

/**
 * /api/run
 * Orchestrates:
 *  1) /api/analyze (pref lane, with timeout + fallback)
 *  2) /api/export?format=bundle_json
 *
 * Adds:
 *  - orchestrator metadata
 *  - runSummary proof fields (non-breaking)
 *  - stores the bundle in an in-memory run store (for /api/runs replay)
 *
 * Sprint 4 focus:
 *  - Make LIVE reliable: avoid premature 45s aborts
 *  - Emit attempt logs for judges: what we tried, what failed, what succeeded
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

function safeJsonParse(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  const json = safeJsonParse(text);
  return { res, text, json };
}

// ---- Timeout wrapper (fixes 45s abort issues) ----
async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const merged: RequestInit = { ...init, signal: ctrl.signal };
    const out = await fetchJson(url, merged);
    return { ...out, aborted: false as const, timeoutMs };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const aborted = msg.toLowerCase().includes("aborted");
    return {
      res: null as any,
      text: msg,
      json: null,
      aborted,
      timeoutMs,
    };
  } finally {
    clearTimeout(t);
  }
}

function pickForwardHeaders(req: NextRequest) {
  const out: Record<string, string> = { "Content-Type": "application/json" };

  const mode = req.headers.get("x-matrixmint-mode"); // live | cache | offline
  const bust = req.headers.get("x-matrixmint-bust-cache");
  const clear = req.headers.get("x-matrixmint-clear-cache");

  if (mode) out["x-matrixmint-mode"] = mode;
  if (bust) out["x-matrixmint-bust-cache"] = bust;
  if (clear) out["x-matrixmint-clear-cache"] = clear;

  return out;
}

function modeFromReq(req: NextRequest): "live" | "cache" | "offline" {
  const m = (req.headers.get("x-matrixmint-mode") || "").toLowerCase();
  if (m === "cache") return "cache";
  if (m === "offline") return "offline";
  return "live";
}

function isRetriableStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

// ---- Run store (in-memory) ----
type StoredRun = {
  runId: string;
  createdAtIso: string;
  orchestrator: any;
  runSummary: any;
  exports: Record<string, string>;
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

  // Attempt logs for judge trust
  const attempts: Array<{
    name: string;
    ok: boolean;
    httpStatus: number | null;
    elapsedMs: number;
    aborted: boolean;
    modelUsed?: string;
    errorPreview?: string;
  }> = [];

  try {
    const origin = req.nextUrl.origin;
    const body = (await req.json().catch(() => null)) as RunBody | null;

    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "Missing JSON body" }, { status: 400 });
    }

    const model = body.model || "gemini-3-flash-preview";
    const reqMode = modeFromReq(req);

    let rfpText = body.rfpText;
    let capabilityText = body.capabilityText;

    if (body.sampleId) {
      const s = await fetchJson(`${origin}/api/samples`, { method: "GET" });
      if (!s.res?.ok || !s.json?.samples?.length) {
        return NextResponse.json(
          { ok: false, error: "Failed to load samples", details: { status: s.res?.status, body: (s.text || "").slice(0, 200) } },
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

    // ---- Step 1: Analyze with lane logic ----
    // Increase live timeout to avoid premature abort.
    // You saw ~45s abort; we give it 120s for live.
    const LIVE_TIMEOUT_MS = 120_000;
    const CACHE_TIMEOUT_MS = 8_000;
    const OFFLINE_TIMEOUT_MS = 8_000;

    const analyzeUrl = `${origin}/api/analyze`;

    const mkAnalyzeInit = (mode: "live" | "cache" | "offline", bust: boolean): RequestInit => {
      const h: Record<string, string> = { "Content-Type": "application/json" };
      h["x-matrixmint-mode"] = mode;
      if (bust) h["x-matrixmint-bust-cache"] = "1";
      // forward clear-cache if present
      const clear = req.headers.get("x-matrixmint-clear-cache");
      if (clear) h["x-matrixmint-clear-cache"] = clear;

      return {
        method: "POST",
        headers: h,
        body: JSON.stringify({ rfpText, capabilityText, model }),
      };
    };

    const tryAnalyze = async (name: string, mode: "live" | "cache" | "offline", bust: boolean, timeoutMs: number) => {
      const t0 = Date.now();
      const r = await fetchJsonWithTimeout(analyzeUrl, mkAnalyzeInit(mode, bust), timeoutMs);
      const elapsedMs = Date.now() - t0;

      const httpStatus = r.res?.status ?? null;
      const ok = Boolean(r.res?.ok && r.json?.ok);

      attempts.push({
        name,
        ok,
        httpStatus,
        elapsedMs,
        aborted: Boolean(r.aborted),
        modelUsed: r.json?.meta?.modelUsed,
        errorPreview: ok ? undefined : String(r.json?.error || r.text || "").slice(0, 160),
      });

      return r;
    };

    let analyzeRes: any = null;

    if (reqMode === "offline") {
      analyzeRes = await tryAnalyze("offline_forced", "offline", false, OFFLINE_TIMEOUT_MS);
    } else if (reqMode === "cache") {
      analyzeRes = await tryAnalyze("cache_forced", "cache", false, CACHE_TIMEOUT_MS);
    } else {
      // live preferred, cache fallback only on timeout/retriable/non-ok
      const preferred = await tryAnalyze("preferred", "live", true, LIVE_TIMEOUT_MS);

      const preferredOk = Boolean(preferred.res?.ok && preferred.json?.ok);
      const preferredStatus = preferred.res?.status ?? null;
      const preferredTimedOut = Boolean(preferred.aborted);
      const preferredRetriable = typeof preferredStatus === "number" && isRetriableStatus(preferredStatus);

      if (preferredOk) {
        analyzeRes = preferred;
      } else {
        // fallback to cache to preserve judgeability
        // (but attempt log will clearly show why)
        const fallback = await tryAnalyze("cache_fallback", "cache", false, CACHE_TIMEOUT_MS);
        analyzeRes = fallback;
      }
    }

    if (!analyzeRes?.res?.ok || !analyzeRes?.json?.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Analyze failed",
          runId,
          attempts,
          details: {
            httpStatus: analyzeRes?.res?.status ?? null,
            responsePreview: String(analyzeRes?.text || "").slice(0, 500),
            out: analyzeRes?.json ?? null,
          },
          orchestrator: {
            runId,
            modeRequested: reqMode,
            modelRequested: model,
            startedAtIso: new Date(startedAt).toISOString(),
            finishedAtIso: nowIso(),
            elapsedMs: Date.now() - startedAt,
            ladderUsed: "none",
            modelUsed: undefined,
            cache: undefined,
            warnings: ["Analyze failed in all lanes."],
            attempts,
          },
        },
        { status: 502 }
      );
    }

    const analyzeOut = analyzeRes.json; // { ok:true, data, meta }
    const data = analyzeOut.data;
    const meta = analyzeOut.meta;

    // Determine ladderUsed + modelUsed
    const lastOkAttempt = attempts.slice().reverse().find((a) => a.ok);
    const ladderUsed = lastOkAttempt?.name?.includes("cache") ? "cache" : lastOkAttempt?.name?.includes("offline") ? "offline" : "live";

    // ---- Step 2: Bundle export ----
    const bundle = await fetchJson(`${origin}/api/export?format=bundle_json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result: data, meta }),
    });

    if (!bundle.res?.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Bundle export failed",
          runId,
          attempts,
          details: {
            httpStatus: bundle.res?.status ?? null,
            responsePreview: String(bundle.text || "").slice(0, 500),
          },
        },
        { status: 502 }
      );
    }

    const payload = bundle.json ?? {};

    payload.orchestrator = {
      runId,
      modeRequested: reqMode,
      modelRequested: model,
      startedAtIso: new Date(startedAt).toISOString(),
      finishedAtIso: nowIso(),
      elapsedMs: Date.now() - startedAt,
      ladderUsed,
      modelUsed: meta?.modelUsed ?? undefined,
      cache: meta?.cache ?? undefined,
      warnings: meta?.warnings ?? [],
      attempts, // judge-grade transparency
    };

    // Make proof fields explicit (non-breaking)
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
      // no-op
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
      {
        ok: false,
        error: String(err?.message ?? "Run failed"),
        runId,
        attempts,
      },
      { status: 500 }
    );
  }
}
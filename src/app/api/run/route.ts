import { NextRequest, NextResponse } from "next/server";

/**
 * /api/run
 * Orchestrates:
 *  1) /api/analyze (preferred lane, with timeout + fallback)
 *  2) /api/export?format=bundle_json
 *
 * Adds:
 *  - orchestrator metadata
 *  - runSummary proof fields (non-breaking)
 *  - stores the bundle in an in-memory run store (for /api/runs replay)
 *
 * Reliability upgrade:
 *  - Avoid https://localhost internal fetch failures (common behind proxies)
 *  - Fallback to loopback http://127.0.0.1:<port> for internal calls when safe
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

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const merged: RequestInit = { ...init, signal: ctrl.signal };
    const out = await fetchJson(url, merged);
    return { ...out, aborted: false as const, timeoutMs };
  } catch (e: unknown) {
    const msg = String((e as any)?.message ?? e);
    const aborted =
      msg.toLowerCase().includes("aborted") ||
      msg.toLowerCase().includes("aborterror") ||
      msg.toLowerCase().includes("this operation was aborted");
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

function modeFromReq(req: NextRequest): "live" | "cache" | "offline" {
  const m = (req.headers.get("x-matrixmint-mode") || "").toLowerCase();
  if (m === "cache") return "cache";
  if (m === "offline") return "offline";
  return "live";
}

/**
 * Compute a safe internal origin for server-to-server calls.
 *
 * Problem: When the incoming request is seen as https://localhost:3000 (proxy),
 * req.nextUrl.origin becomes https://localhost:3000. But local Next dev/prod server
 * is often plain HTTP, so internal fetch to https://localhost fails with "fetch failed".
 *
 * Fix: If origin is https://localhost (or https://127.0.0.1 / 0.0.0.0), coerce to http.
 * Also: If internal fetch still fails, fallback to loopback http://127.0.0.1:<port>
 * when host looks local.
 */
function getIncomingOrigin(req: NextRequest) {
  try {
    return req.nextUrl.origin;
  } catch {
    return "";
  }
}

function getHost(req: NextRequest) {
  return (req.headers.get("host") || "").trim();
}

function getPortFromHost(host: string) {
  // host could be "localhost:3000" or "127.0.0.1:3000"
  const m = host.match(/:(\d+)$/);
  return m?.[1] ? Number(m[1]) : null;
}

function coerceHttpsLocalhostToHttp(origin: string) {
  if (!origin) return origin;
  const lower = origin.toLowerCase();

  const isHttps = lower.startsWith("https://");
  const isLocal =
    lower.startsWith("https://localhost") ||
    lower.startsWith("https://127.0.0.1") ||
    lower.startsWith("https://0.0.0.0");

  if (isHttps && isLocal) return "http://" + origin.slice("https://".length);
  return origin;
}

function resolveInternalOrigin(req: NextRequest) {
  // Allow explicit override (useful for deployments / weird proxies)
  const env = process.env.MATRIXMINT_INTERNAL_ORIGIN?.trim();
  if (env) return env;

  // Default to what Next thinks the origin is
  const incoming = getIncomingOrigin(req);
  return coerceHttpsLocalhostToHttp(incoming) || "http://127.0.0.1:3000";
}

function shouldTryLoopbackFallback(req: NextRequest) {
  const host = getHost(req).toLowerCase();
  return host.includes("localhost") || host.includes("127.0.0.1") || host.includes("0.0.0.0");
}

function loopbackOrigin(req: NextRequest) {
  const host = getHost(req);
  const port = getPortFromHost(host) || Number(process.env.PORT || 3000);
  return `http://127.0.0.1:${port}`;
}

async function internalFetchJson(
  req: NextRequest,
  path: string,
  init?: RequestInit,
  timeoutMs?: number
): Promise<{ res: Response | null; text: string; json: any; aborted?: boolean; timeoutMs?: number; urlTried: string[] }> {
  const tried: string[] = [];

  const base1 = resolveInternalOrigin(req);
  const url1 = `${base1}${path}`;
  tried.push(url1);

  // 1) Try primary internal origin
  try {
    if (typeof timeoutMs === "number") {
      const out = await fetchJsonWithTimeout(url1, init || {}, timeoutMs);
      if (out.res) return { ...out, urlTried: tried };
      // fallthrough if res is null (network error)
    } else {
      const out = await fetchJson(url1, init);
      return { ...out, res: out.res, text: out.text, json: out.json, urlTried: tried };
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // continue to fallback below
    if (!timeoutMs) return { res: null, text: msg, json: null, urlTried: tried };
  }

  // 2) If local + proxy mismatch, try loopback http://127.0.0.1:<port>
  if (shouldTryLoopbackFallback(req)) {
    const base2 = loopbackOrigin(req);
    const url2 = `${base2}${path}`;
    if (!tried.includes(url2)) tried.push(url2);

    try {
      if (typeof timeoutMs === "number") {
        const out2 = await fetchJsonWithTimeout(url2, init || {}, timeoutMs);
        return { ...out2, urlTried: tried };
      } else {
        const out2 = await fetchJson(url2, init);
        return { ...out2, urlTried: tried };
      }
    } catch (e: any) {
      const msg2 = String(e?.message ?? e);
      return { res: null, text: msg2, json: null, urlTried: tried };
    }
  }

  // If we got here, both attempts failed
  return { res: null, text: "fetch failed", json: null, urlTried: tried };
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

  const incomingOrigin = getIncomingOrigin(req);
  const internalOrigin = resolveInternalOrigin(req);

  // Attempt logs for judge trust
  const attempts: Array<{
    name: string;
    ok: boolean;
    httpStatus: number | null;
    elapsedMs: number;
    aborted: boolean;
    modelUsed?: string;
    errorPreview?: string;
    urlTried?: string[];
  }> = [];

  try {
    const body = (await req.json().catch(() => null)) as RunBody | null;

    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "Missing JSON body" }, { status: 400 });
    }

    const model = body.model || "gemini-3-flash-preview";
    const reqMode = modeFromReq(req);

    let rfpText = body.rfpText;
    let capabilityText = body.capabilityText;

    if (body.sampleId) {
      const s = await internalFetchJson(req, "/api/samples", { method: "GET" });
      if (!s.res?.ok || !s.json?.samples?.length) {
        return NextResponse.json(
          {
            ok: false,
            error: "Failed to load samples",
            runId,
            attempts,
            details: {
              status: s.res?.status ?? null,
              preview: String(s.text || "").slice(0, 200),
              incomingOrigin,
              internalOrigin,
              urlTried: s.urlTried,
            },
          },
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
      return NextResponse.json({ ok: false, error: "Missing rfpText or capabilityText (or provide sampleId)" }, { status: 400 });
    }

    // ---- Step 1: Analyze with lane logic ----
    const LIVE_TIMEOUT_MS = 138_000;
    const CACHE_TIMEOUT_MS = 8_000;
    const OFFLINE_TIMEOUT_MS = 8_000;

    const mkAnalyzeInit = (mode: "live" | "cache" | "offline", bust: boolean): RequestInit => {
      const h: Record<string, string> = { "Content-Type": "application/json" };
      h["x-matrixmint-mode"] = mode;
      if (bust) h["x-matrixmint-bust-cache"] = "1";

      // Forward clear-cache if present
      const clear = req.headers.get("x-matrixmint-clear-cache");
      if (clear) h["x-matrixmint-clear-cache"] = clear;

      // Forward demo-break-proof if present
      const demo = req.headers.get("x-matrixmint-demo-break-proof");
      if (demo) h["x-matrixmint-demo-break-proof"] = demo;

      return {
        method: "POST",
        headers: h,
        body: JSON.stringify({ rfpText, capabilityText, model }),
      };
    };

    const tryAnalyze = async (name: string, mode: "live" | "cache" | "offline", bust: boolean, timeoutMs: number) => {
      const t0 = Date.now();
      const r = await internalFetchJson(req, "/api/analyze", mkAnalyzeInit(mode, bust), timeoutMs);
      const elapsedMs = Date.now() - t0;

      const httpStatus = r.res?.status ?? null;
      const ok = Boolean(r.res?.ok && r.json?.ok);

      attempts.push({
        name,
        ok,
        httpStatus,
        elapsedMs,
        aborted: Boolean((r as any).aborted),
        modelUsed: r.json?.meta?.modelUsed,
        errorPreview: ok ? undefined : String(r.json?.error || r.text || "").slice(0, 160),
        urlTried: (r as any).urlTried,
      });

      return r;
    };

    let analyzeRes: any = null;

    if (reqMode === "offline") {
      analyzeRes = await tryAnalyze("offline_forced", "offline", false, OFFLINE_TIMEOUT_MS);
    } else if (reqMode === "cache") {
      analyzeRes = await tryAnalyze("cache_forced", "cache", false, CACHE_TIMEOUT_MS);
    } else {
      const preferred = await tryAnalyze("preferred", "live", true, LIVE_TIMEOUT_MS);
      const preferredOk = Boolean(preferred.res?.ok && preferred.json?.ok);

      if (preferredOk) {
        analyzeRes = preferred;
      } else {
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
            incomingOrigin,
            internalOrigin,
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

    const lastOkAttempt = attempts.slice().reverse().find((a) => a.ok);
    const ladderUsed =
      lastOkAttempt?.name?.includes("cache") ? "cache" : lastOkAttempt?.name?.includes("offline") ? "offline" : "live";

    // ---- Step 2: Bundle export ----
    const bundle = await internalFetchJson(req, "/api/export?format=bundle_json", {
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
            incomingOrigin,
            internalOrigin,
            urlTried: (bundle as any).urlTried,
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
      attempts,
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
  } catch (err: unknown) {
    return NextResponse.json(
      {
        ok: false,
        error: String((err as any)?.message ?? "Run failed"),
        runId,
        attempts,
        details: { incomingOrigin, internalOrigin },
      },
      { status: 500 }
    );
  }
}
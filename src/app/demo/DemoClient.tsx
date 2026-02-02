"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";

type RunMode = "live" | "cache" | "offline";

type AttemptLog = {
  name: string;
  ok: boolean;
  httpStatus: number | null;
  elapsedMs: number;
  aborted: boolean;
  modelUsed?: string;
  errorPreview?: string;
};

type RunResponse = {
  ok: boolean;
  orchestrator?: {
    runId?: string;
    modeRequested?: RunMode;
    modelRequested?: string;
    ladderUsed?: "live" | "cache" | "offline" | "none";
    modelUsed?: string;
    elapsedMs?: number;
    warnings?: string[];
    attempts?: AttemptLog[];
    cache?: { hit?: boolean; key?: string; source?: string; lane?: string; ageSeconds?: number };
  };
  runSummary?: {
    coveragePercent?: number;
    proof?: string;
    total?: number;
    covered?: number;
    partial?: number;
    missing?: number;
    proofPercent?: number;
    proofVerifiedCount?: number;
    proofTotalEvidenceRefs?: number;
  };
  exports?: Record<string, string>;
  data?: any;
  error?: string;
  details?: any;
};

type HealthResult = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: string }>;
  hint?: string;
};

type JudgeFlowStage =
  | "idle"
  | "fast_running"
  | "fast_done"
  | "exports_ready"
  | "live_running"
  | "live_done"
  | "break_running"
  | "break_done"
  | "done"
  | "failed";

function downloadText(filename: string, text: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function parseFilenameFromContentDisposition(cd?: string | null) {
  if (!cd) return null;
  const m =
    cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i) ||
    cd.match(/filename\s*=\s*"([^"]+)"/i) ||
    cd.match(/filename\s*=\s*([^;]+)/i);
  const raw = m?.[1]?.trim();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw.replace(/^"+|"+$/g, ""));
  } catch {
    return raw.replace(/^"+|"+$/g, "");
  }
}

function fmtMs(ms?: number) {
  if (typeof ms !== "number") return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function round2(n?: number) {
  if (typeof n !== "number") return "—";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function isGeminiModelUsed(modelUsed?: string) {
  return typeof modelUsed === "string" && modelUsed.startsWith("gemini-");
}

function badgeStyle(kind: "live" | "cache" | "offline" | "none") {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    fontWeight: 900,
    fontSize: 12,
    border: "1px solid #ddd",
    background: "#f7f7f7",
    whiteSpace: "nowrap",
  };
  if (kind === "live") return { ...base, border: "1px solid #111", background: "#111", color: "#fff" };
  if (kind === "cache") return { ...base, border: "1px solid #444", background: "#f3f3f3", color: "#111" };
  if (kind === "offline") return { ...base, border: "1px solid #c7c7c7", background: "#fafafa", color: "#111" };
  return base;
}

function smallPillStyle(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 8px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    marginRight: 8,
    marginBottom: 8,
    background: "rgba(255,255,255,0.7)",
    fontWeight: 800,
    whiteSpace: "nowrap",
  };
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontWeight: 900, marginBottom: 6 }}>{children}</div>;
}

function bannerStyle(kind: "info" | "warn" | "error" | "success") {
  const base: React.CSSProperties = {
    borderRadius: 12,
    padding: 12,
    border: "1px solid #ddd",
    background: "#f7f7f7",
  };
  if (kind === "success") return { ...base, border: "1px solid #b9d9b9", background: "#f3fbf3" };
  if (kind === "warn") return { ...base, border: "1px solid #b9b9b9", background: "#faf7ef" };
  if (kind === "error") return { ...base, border: "1px solid #d4a1a1", background: "#fff4f4" };
  return base;
}

function laneExplainer(lane: "live" | "cache" | "offline" | "none") {
  if (lane === "live") return "LIVE: fresh Gemini execution (proof-worthy).";
  if (lane === "cache") return "CACHE: replay for stable demos and speed.";
  if (lane === "offline") return "OFFLINE: deterministic fallback for reliability.";
  return "—";
}

function safeJsonParse(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function extractHelpfulHint(parsed: any): string | null {
  const incomingOrigin = parsed?.details?.incomingOrigin;
  const internalOrigin = parsed?.details?.internalOrigin;
  if (typeof incomingOrigin === "string" && incomingOrigin.startsWith("https://localhost")) {
    return [
      "Likely cause: the request is coming from https://localhost, but your server is only listening on http.",
      "Fix (recommended): set MATRIXMINT_INTERNAL_ORIGIN=http://127.0.0.1:3000 (or your port) and make /api/run use it for internal fetches.",
      "Quick local workaround: open the app via http://127.0.0.1:3000 instead of https://localhost:3000.",
      internalOrigin ? `Internal origin detected: ${internalOrigin}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return null;
}

function StepDot({ ok, active }: { ok: boolean | null; active: boolean }) {
  const bg = ok === true ? "#111" : ok === false ? "#d11" : active ? "#666" : "#ddd";
  return <span style={{ width: 10, height: 10, borderRadius: 999, display: "inline-block", background: bg }} />;
}

export default function DemoClient() {
  // Inputs
  const [rfpText, setRfpText] = useState("");
  const [capabilityText, setCapabilityText] = useState("");

  // Default: fast + stable. Live proof is a separate action.
  const [mode, setMode] = useState<RunMode>("cache");
  const [model, setModel] = useState("gemini-3-flash-preview");

  // State
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<RunResponse | null>(null);

  // Judge Flow
  const [judgeFlowStage, setJudgeFlowStage] = useState<JudgeFlowStage>("idle");
  const [judgeFlowError, setJudgeFlowError] = useState<string>("");
  const [autoDownloadExports, setAutoDownloadExports] = useState(false);
  const [includeBreakProof, setIncludeBreakProof] = useState(true);

  // Health check
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  const lastRespRef = useRef<RunResponse | null>(null);
  lastRespRef.current = resp;

  const shouldUseSample = useMemo(() => !rfpText.trim() || !capabilityText.trim(), [rfpText, capabilityText]);

  const mkBody = useCallback(
    (download?: boolean) => ({
      rfpText: rfpText.trim() || undefined,
      capabilityText: capabilityText.trim() || undefined,
      sampleId: shouldUseSample ? "disaster-relief" : undefined,
      model,
      download: Boolean(download),
    }),
    [rfpText, capabilityText, shouldUseSample, model]
  );

  const dropdownHeaders = useMemo(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    h["x-matrixmint-mode"] = mode;
    if (mode === "live") h["x-matrixmint-bust-cache"] = "1";
    return h;
  }, [mode]);

  const runWithHeaders = useCallback(
    async (headers: Record<string, string>, label: string) => {
      setLoading(true);
      setResp(null);
      setJudgeFlowError("");

      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers,
          body: JSON.stringify(mkBody(false)),
        });

        const text = await res.text();
        const parsed = safeJsonParse(text);

        if (!res.ok) {
          // Make errors judge-readable.
          const hint = parsed ? extractHelpfulHint(parsed) : null;
          setResp({
            ok: false,
            error: "Request failed",
            details: {
              label,
              status: res.status,
              statusText: res.statusText || "",
              requestBody: mkBody(false),
              preview: text.slice(0, 1200),
              parsed,
              hint: hint || undefined,
            },
          });
          return;
        }

        if (!parsed || typeof parsed.ok !== "boolean") {
          setResp({ ok: false, error: `Unexpected response from ${label}.`, details: { preview: text.slice(0, 800) } });
          return;
        }

        setResp(parsed as RunResponse);
      } catch (e: any) {
        setResp({ ok: false, error: String(e?.message ?? e) });
      } finally {
        setLoading(false);
      }
    },
    [mkBody]
  );

  const runFast = useCallback(async () => {
    const h: Record<string, string> = { "Content-Type": "application/json", "x-matrixmint-mode": "cache" };
    await runWithHeaders(h, "FAST");
  }, [runWithHeaders]);

  const runLiveProof = useCallback(async () => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "x-matrixmint-mode": "live",
      "x-matrixmint-bust-cache": "1",
    };
    await runWithHeaders(h, "LIVE_PROOF");
  }, [runWithHeaders]);

  const runLiveBreakProof = useCallback(async () => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "x-matrixmint-mode": "live",
      "x-matrixmint-bust-cache": "1",
      "x-matrixmint-demo-break-proof": "1",
    };
    await runWithHeaders(h, "LIVE_BREAK_PROOF");
  }, [runWithHeaders]);

  const runDropdown = useCallback(async () => {
    await runWithHeaders(dropdownHeaders, "RUN");
  }, [runWithHeaders, dropdownHeaders]);

  const downloadServerBundle = useCallback(
    async (headers: Record<string, string>) => {
      try {
        setLoading(true);

        const res = await fetch("/api/run", {
          method: "POST",
          headers,
          body: JSON.stringify(mkBody(true)),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const parsed = safeJsonParse(text);
          setResp({
            ok: false,
            error: `Download failed (HTTP ${res.status})`,
            details: { preview: text.slice(0, 1200), parsed },
          });
          return;
        }

        const cd = res.headers.get("content-disposition");
        const fallbackName = `matrixmint-run-${Date.now()}.json`;
        const filename = parseFilenameFromContentDisposition(cd) || fallbackName;

        const blob = await res.blob();
        await downloadBlob(filename, blob);
      } catch (e: any) {
        setResp({ ok: false, error: String(e?.message ?? e) });
      } finally {
        setLoading(false);
      }
    },
    [mkBody]
  );

  const downloadServerBundleFast = useCallback(async () => {
    const h: Record<string, string> = { "Content-Type": "application/json", "x-matrixmint-mode": "cache" };
    await downloadServerBundle(h);
  }, [downloadServerBundle]);

  const downloadServerBundleLive = useCallback(async () => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "x-matrixmint-mode": "live",
      "x-matrixmint-bust-cache": "1",
    };
    await downloadServerBundle(h);
  }, [downloadServerBundle]);

  const orch = resp?.orchestrator;
  const sum = resp?.runSummary;

  const ladder = (orch?.ladderUsed || "none") as "live" | "cache" | "offline" | "none";
  const requested = (orch?.modeRequested || mode) as RunMode;
  const modelUsed = orch?.modelUsed;

  const liveConfirmed = requested === "live" && ladder === "live" && isGeminiModelUsed(modelUsed);
  const liveRequestedButNotConfirmed = requested === "live" && !liveConfirmed && Boolean(resp?.ok);

  const warnings = Array.isArray(orch?.warnings) ? orch!.warnings! : [];
  const topWarnings = warnings.slice(0, 3);

  const runId = orch?.runId || "run";
  const sampleLabel = shouldUseSample ? "Sample: disaster-relief" : "Custom input";

  // Export ordering (judge-friendly)
  const exportOrder = useMemo(
    () => ["proofpack_md", "bidpacket_md", "proposal_draft_md", "clarifications_email_md", "risks_csv"],
    []
  );

  const exportEntries = useMemo(() => {
    const obj = resp?.exports || {};
    const entries = Object.entries(obj);
    const idx = (k: string) => {
      const i = exportOrder.indexOf(k);
      return i === -1 ? 999 : i;
    };
    entries.sort((a, b) => idx(a[0]) - idx(b[0]) || a[0].localeCompare(b[0]));
    return entries;
  }, [resp?.exports, exportOrder]);

  const downloadAllExports = useCallback(async () => {
    if (!resp?.exports) return;
    const entries = exportEntries;
    if (!entries.length) return;

    for (const [k, v] of entries) {
      const ext = k.endsWith("_csv") ? "csv" : k.endsWith("_md") ? "md" : "txt";
      const mime =
        ext === "csv"
          ? "text/csv;charset=utf-8"
          : ext === "md"
          ? "text/markdown;charset=utf-8"
          : "text/plain;charset=utf-8";
      const fname = `matrixmint-${runId}-${k}.${ext}`;
      downloadText(fname, String(v ?? ""), mime);
      await new Promise((r) => setTimeout(r, 120));
    }
  }, [resp?.exports, exportEntries, runId]);

  const banner = useMemo(() => {
    if (!resp) return null;

    if (!resp.ok) {
      return {
        kind: "error" as const,
        title: "Run failed",
        body: resp.error || "Unknown error.",
      };
    }

    if (liveConfirmed) {
      return {
        kind: "success" as const,
        title: "Live execution confirmed",
        body: `Lane: LIVE • Model: ${modelUsed} • Elapsed: ${fmtMs(orch?.elapsedMs)}`,
      };
    }

    if (liveRequestedButNotConfirmed) {
      return {
        kind: "warn" as const,
        title: "Live requested, but a fallback lane was used",
        body: "Fallback can occur due to quota or timeouts. Run FAST first, then retry LIVE Proof for confirmation.",
      };
    }

    if (requested !== ladder && ladder !== "none") {
      return {
        kind: "info" as const,
        title: "Lane adjustment",
        body: `Requested: ${requested.toUpperCase()} • Used: ${ladder.toUpperCase()} • Model: ${modelUsed ?? "—"}`,
      };
    }

    return null;
  }, [resp, liveConfirmed, liveRequestedButNotConfirmed, requested, ladder, modelUsed, orch?.elapsedMs]);

  // Optional mini matrix preview (renders only if present)
  const miniRequirements = useMemo(() => {
    const rows = resp?.data?.requirements || resp?.data?.result?.requirements || resp?.data?.data?.requirements;
    return Array.isArray(rows) ? rows.slice(0, 10) : null;
  }, [resp?.data]);

  const showMiniMatrix = Boolean(miniRequirements && miniRequirements.length);

  // ============ Judge Flow ============
  const judgeFlow = useCallback(async () => {
    setJudgeFlowError("");
    setJudgeFlowStage("fast_running");

    const fastHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-matrixmint-mode": "cache",
    };

    try {
      // Step 1: FAST
      await runWithHeaders(fastHeaders, "FAST");
      const r1 = lastRespRef.current;

      if (!r1?.ok) {
        setJudgeFlowStage("failed");
        setJudgeFlowError("FAST failed. Fix backend reliability first (use Health Check below).");
        return;
      }
      setJudgeFlowStage("fast_done");

      // Step 2: Exports ready (from same response)
      const hasExports = Boolean(r1.exports && Object.keys(r1.exports).length);
      setJudgeFlowStage("exports_ready");

      if (autoDownloadExports && hasExports) {
        // download exports without re-running anything
        await (async () => {
          const entries = Object.entries(r1.exports || {});
          // Apply same ordering
          const idx = (k: string) => {
            const i = exportOrder.indexOf(k);
            return i === -1 ? 999 : i;
          };
          entries.sort((a, b) => idx(a[0]) - idx(b[0]) || a[0].localeCompare(b[0]));
          for (const [k, v] of entries) {
            const ext = k.endsWith("_csv") ? "csv" : k.endsWith("_md") ? "md" : "txt";
            const mime =
              ext === "csv"
                ? "text/csv;charset=utf-8"
                : ext === "md"
                ? "text/markdown;charset=utf-8"
                : "text/plain;charset=utf-8";
            const fname = `matrixmint-${r1.orchestrator?.runId || "run"}-${k}.${ext}`;
            downloadText(fname, String(v ?? ""), mime);
            await new Promise((r) => setTimeout(r, 120));
          }
        })();
      }

      // Step 3: LIVE proof
      setJudgeFlowStage("live_running");
      const liveHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "x-matrixmint-mode": "live",
        "x-matrixmint-bust-cache": "1",
      };

      await runWithHeaders(liveHeaders, "LIVE_PROOF");
      const r2 = lastRespRef.current;

      if (!r2?.ok) {
        setJudgeFlowStage("failed");
        setJudgeFlowError("LIVE Proof failed. This can be quota-related. Show FAST + exports and try again.");
        return;
      }
      setJudgeFlowStage("live_done");

      // Step 4 (optional): Break Proof demo (shows self-repair)
      if (includeBreakProof) {
        setJudgeFlowStage("break_running");
        const breakHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "x-matrixmint-mode": "live",
          "x-matrixmint-bust-cache": "1",
          "x-matrixmint-demo-break-proof": "1",
        };
        await runWithHeaders(breakHeaders, "LIVE_BREAK_PROOF");
        const r3 = lastRespRef.current;

        if (!r3?.ok) {
          setJudgeFlowStage("failed");
          setJudgeFlowError("Break-Proof run failed. Not critical — you can win without it if FAST+LIVE works.");
          return;
        }
        setJudgeFlowStage("break_done");
      }

      setJudgeFlowStage("done");
    } catch (e: any) {
      setJudgeFlowStage("failed");
      setJudgeFlowError(String(e?.message ?? e));
    }
  }, [autoDownloadExports, exportOrder, includeBreakProof, runWithHeaders]);

  const judgeFlowSteps = useMemo(() => {
    const stage = judgeFlowStage;

    const fastOk = stage === "fast_done" || stage === "exports_ready" || stage === "live_running" || stage === "live_done" || stage === "break_running" || stage === "break_done" || stage === "done";
    const exportsOk = stage === "exports_ready" || stage === "live_running" || stage === "live_done" || stage === "break_running" || stage === "break_done" || stage === "done";
    const liveOk = stage === "live_done" || stage === "break_running" || stage === "break_done" || stage === "done";
    const breakOk = includeBreakProof ? stage === "break_done" || stage === "done" : null;

    return [
      { name: "FAST (cache)", ok: stage === "failed" ? false : fastOk ? true : null, active: stage === "fast_running" },
      { name: "Exports ready", ok: stage === "failed" ? false : exportsOk ? true : null, active: stage === "exports_ready" },
      { name: "LIVE Proof", ok: stage === "failed" ? false : liveOk ? true : null, active: stage === "live_running" },
      ...(includeBreakProof
        ? [{ name: "Break Proof → Repair", ok: stage === "failed" ? false : breakOk ? true : null, active: stage === "break_running" }]
        : []),
    ];
  }, [judgeFlowStage, includeBreakProof]);

  // ============ Health Check ============
  const healthCheck = useCallback(async () => {
    setCheckingHealth(true);
    setHealth(null);

    const steps: HealthResult["steps"] = [];
    try {
      // 1) samples
      const s = await fetch("/api/samples");
      const sText = await s.text();
      if (!s.ok) {
        steps.push({ name: "GET /api/samples", ok: false, detail: `HTTP ${s.status}: ${sText.slice(0, 200)}` });
        setHealth({
          ok: false,
          steps,
          hint: "If /api/samples fails, your server routing is broken in prod/start mode.",
        });
        return;
      }
      steps.push({ name: "GET /api/samples", ok: true, detail: "OK" });

      // 2) run cache
      const r = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-matrixmint-mode": "cache" },
        body: JSON.stringify({ sampleId: "disaster-relief", model: model || "gemini-3-flash-preview", download: false }),
      });
      const rText = await r.text();
      const parsed = safeJsonParse(rText);

      if (!r.ok || !parsed?.ok) {
        const hint = parsed ? extractHelpfulHint(parsed) : null;
        steps.push({
          name: "POST /api/run (cache)",
          ok: false,
          detail: `HTTP ${r.status} • ${String(parsed?.error || rText || "failed").slice(0, 160)}`,
        });
        setHealth({
          ok: false,
          steps,
          hint:
            hint ||
            "If this fails only on /demo but curl works, your /demo request origin may be https://localhost (internal fetch mismatch).",
        });
        return;
      }

      steps.push({
        name: "POST /api/run (cache)",
        ok: true,
        detail: `OK • proof=${parsed?.runSummary?.proof || "—"} • coverage=${parsed?.runSummary?.coveragePercent ?? "—"}%`,
      });

      setHealth({ ok: true, steps, hint: "Backend OK. If judges see failures, it's likely an origin/proxy mismatch or an older build." });
    } catch (e: any) {
      steps.push({ name: "Health check", ok: false, detail: String(e?.message ?? e) });
      setHealth({ ok: false, steps, hint: "Network or server error. Re-run in production mode: npm run build && npm run start." });
    } finally {
      setCheckingHealth(false);
    }
  }, [model]);

  // ========= Derived UI info =========
  const proofString = useMemo(() => {
    if (!sum) return "—";
    if (typeof sum.proofVerifiedCount === "number" && typeof sum.proofTotalEvidenceRefs === "number") {
      const pct = typeof sum.proofPercent === "number" ? `${Math.round(sum.proofPercent)}%` : "—";
      return `${pct} (${sum.proofVerifiedCount}/${sum.proofTotalEvidenceRefs})`;
    }
    return sum.proof || "—";
  }, [sum]);

  const coveragePct = useMemo(() => {
    if (typeof sum?.coveragePercent !== "number") return "—";
    return `${round2(sum.coveragePercent)}%`;
  }, [sum?.coveragePercent]);

  const proofRepairInfo = useMemo(() => {
    const pr =
      (resp as any)?.meta?.proofRepair ||
      (resp as any)?.orchestrator?.proofRepair ||
      (resp as any)?.data?.meta?.proofRepair ||
      null;
    // /api/run in your curl shows meta.proofRepair in meta (server-side), but this client may see it as resp.meta or resp.data.meta.
    return pr;
  }, [resp]);

  const stickyBar: React.CSSProperties = {
    position: "sticky",
    top: 0,
    zIndex: 30,
    background: "rgba(255,255,255,0.92)",
    backdropFilter: "blur(10px)",
    border: "1px solid #eee",
    borderRadius: 12,
    padding: 12,
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Sticky Judge Scoreboard */}
      <div style={stickyBar}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 14 }}>Judge Scoreboard</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              One glance: lane + model + coverage + proof + exports + run id.
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={badgeStyle(ladder)}>Lane: {ladder.toUpperCase()}</span>
            <span style={smallPillStyle()}>Requested: {requested}</span>
            <span style={smallPillStyle()}>Model: {modelUsed ?? model}</span>
            <span style={smallPillStyle()}>Coverage: {coveragePct}</span>
            <span style={smallPillStyle()}>Proof: {proofString}</span>
            <span style={smallPillStyle()}>
              Exports: {exportEntries.length ? `${exportEntries.length} ready` : "—"}
            </span>

            <button
              onClick={() => navigator.clipboard?.writeText(runId).catch(() => {})}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #ddd",
                background: "#fff",
                cursor: "pointer",
                fontWeight: 900,
              }}
              title="Copy runId"
            >
              Copy runId
            </button>
          </div>
        </div>

        {/* Proof Repair Badge (if present) */}
        {proofRepairInfo?.triggered ? (
          <div style={{ marginTop: 10, ...bannerStyle("success") }}>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>Proof Repair Triggered (self-correcting)</div>
            <div style={{ opacity: 0.9, fontSize: 12, lineHeight: 1.5 }}>
              Attempts: {proofRepairInfo.attempts ?? "—"} • Fixed mismatches: {proofRepairInfo.fixedMismatches ?? "—"} •{" "}
              Before: {proofRepairInfo.beforeProofPercent ?? "—"}% → After: {proofRepairInfo.afterProofPercent ?? "—"}%
            </div>
            {Array.isArray(proofRepairInfo.notes) && proofRepairInfo.notes.length ? (
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                {proofRepairInfo.notes.slice(0, 2).map((n: string, i: number) => (
                  <div key={i}>• {n}</div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Recommended Demo (judge flow) */}
      <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, background: "#fafafa" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>Recommended Judge Flow</div>
            <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5 }}>
              Click <b>Run Judge Flow</b>: FAST (stable) → exports ready → LIVE Proof (Gemini execution) → optional Break-Proof (self-repair).
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={smallPillStyle()}>FAST = stability</span>
            <span style={smallPillStyle()}>LIVE = proof</span>
            <span style={smallPillStyle()}>Break-Proof = wow</span>
          </div>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button
            onClick={judgeFlow}
            disabled={loading || judgeFlowStage === "fast_running" || judgeFlowStage === "live_running" || judgeFlowStage === "break_running"}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid #111",
              background: loading ? "#eee" : "#111",
              color: loading ? "#111" : "#fff",
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 900,
            }}
            title="Runs the full judge narrative: FAST → LIVE Proof → Break Proof (optional)."
          >
            {loading ? "Running…" : "Run Judge Flow"}
          </button>

          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 800 }}>
            <input
              type="checkbox"
              checked={includeBreakProof}
              onChange={(e) => setIncludeBreakProof(Boolean(e.target.checked))}
            />
            Include Break-Proof demo (recommended)
          </label>

          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 800 }}>
            <input
              type="checkbox"
              checked={autoDownloadExports}
              onChange={(e) => setAutoDownloadExports(Boolean(e.target.checked))}
            />
            Auto-download exports during flow
          </label>

          <div style={{ flex: 1 }} />

          <button
            onClick={healthCheck}
            disabled={checkingHealth || loading}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid #ddd",
              background: "#fff",
              cursor: checkingHealth || loading ? "not-allowed" : "pointer",
              fontWeight: 900,
            }}
            title="Verifies /api/samples and /api/run (cache) from this page."
          >
            {checkingHealth ? "Checking…" : "Run Health Check"}
          </button>
        </div>

        {/* Judge Flow Timeline */}
        <div style={{ marginTop: 12, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          {judgeFlowSteps.map((s, i) => (
            <div key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <StepDot ok={s.ok} active={s.active} />
              <span style={{ fontSize: 12, fontWeight: 900, opacity: s.ok === true ? 0.95 : s.ok === false ? 0.95 : 0.7 }}>
                {s.name}
              </span>
            </div>
          ))}
          {judgeFlowStage === "failed" && judgeFlowError ? (
            <span style={{ marginLeft: 6, fontSize: 12, fontWeight: 900, color: "#b00020" }}>{judgeFlowError}</span>
          ) : null}
        </div>

        {/* Health result */}
        {health ? (
          <div style={{ marginTop: 12, ...bannerStyle(health.ok ? "success" : "warn") }}>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>{health.ok ? "Health Check: OK" : "Health Check: Issue detected"}</div>
            <div style={{ display: "grid", gap: 6, fontSize: 12, opacity: 0.9 }}>
              {health.steps.map((s, idx) => (
                <div key={idx}>
                  <b>{s.ok ? "✅" : "❌"} {s.name}:</b> <span style={{ opacity: 0.85 }}>{s.detail || "—"}</span>
                </div>
              ))}
            </div>
            {health.hint ? <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}><b>Hint:</b> {health.hint}</div> : null}
          </div>
        ) : null}
      </div>

      {/* Inputs */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={{ fontWeight: 800 }}>RFP Text</label>
          <textarea
            value={rfpText}
            onChange={(e) => setRfpText(e.target.value)}
            rows={10}
            placeholder="Paste RFP text here (or leave blank to use the sample)."
            style={{
              width: "100%",
              marginTop: 6,
              padding: 10,
              borderRadius: 10,
              border: "1px solid #ddd",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
            }}
          />
        </div>
        <div>
          <label style={{ fontWeight: 800 }}>Capability Statement</label>
          <textarea
            value={capabilityText}
            onChange={(e) => setCapabilityText(e.target.value)}
            rows={10}
            placeholder="Paste capability statement here (or leave blank to use the sample)."
            style={{
              width: "100%",
              marginTop: 6,
              padding: 10,
              borderRadius: 10,
              border: "1px solid #ddd",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
            }}
          />
        </div>
      </div>

      {/* Controls */}
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
          padding: 12,
          borderRadius: 12,
          border: "1px solid #eee",
          background: "#fafafa",
        }}
      >
        <button
          onClick={runFast}
          disabled={loading}
          title="Fast demo lane. Uses cache for stable, instant results."
          style={{
            padding: "10px 14px",
            borderRadius: 12,
            border: "1px solid #111",
            background: loading ? "#eee" : "#111",
            color: loading ? "#111" : "#fff",
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 900,
          }}
        >
          {loading ? "Running…" : "Run FAST (cache)"}
        </button>

        <button
          onClick={runLiveProof}
          disabled={loading}
          title="For proof: forces LIVE + cache bust to demonstrate live execution."
          style={{
            padding: "10px 14px",
            borderRadius: 12,
            border: "1px solid #111",
            background: loading ? "#eee" : "#fff",
            color: "#111",
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 900,
          }}
        >
          {loading ? "Running…" : "Run LIVE Proof"}
        </button>

        <button
          onClick={runLiveBreakProof}
          disabled={loading}
          title="Optional wow: triggers proof mismatch + auto-repair (if supported)."
          style={{
            padding: "10px 14px",
            borderRadius: 12,
            border: "1px solid #111",
            background: loading ? "#eee" : "#fff",
            color: "#111",
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 900,
          }}
        >
          {loading ? "Running…" : "Run Break-Proof (wow)"}
        </button>

        <button
          onClick={downloadServerBundleFast}
          disabled={loading}
          title="Downloads server bundle JSON (cache lane)."
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid #ddd",
            background: loading ? "#eee" : "#fff",
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 900,
          }}
        >
          Download bundle (cache)
        </button>

        <button
          onClick={downloadServerBundleLive}
          disabled={loading}
          title="Downloads server bundle JSON (live lane, cache-bust)."
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid #ddd",
            background: loading ? "#eee" : "#fff",
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 900,
          }}
        >
          Download bundle (live)
        </button>

        <span style={{ opacity: 0.75, fontWeight: 800 }}>Goal: stable demo + live proof + bid-ready exports.</span>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800 }}>Mode:</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as RunMode)}
            style={{ padding: 8, borderRadius: 10, border: "1px solid #ddd" }}
            title="Manual run mode"
          >
            <option value="cache">cache (fast)</option>
            <option value="live">live (slow)</option>
            <option value="offline">offline (fallback)</option>
          </select>

          {mode === "live" ? (
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 700 }}>Live may consume quota; use LIVE Proof only when needed.</span>
          ) : null}

          <span style={{ fontWeight: 800, marginLeft: 6 }}>Model:</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{
              padding: 8,
              borderRadius: 10,
              border: "1px solid #ddd",
              minWidth: 260,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
            }}
            title="Model string sent to /api/run"
          />

          <button
            onClick={runDropdown}
            disabled={loading}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid #ddd",
              background: loading ? "#eee" : "#fff",
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 900,
            }}
          >
            Run (selected mode)
          </button>
        </div>
      </div>

      {/* Banner */}
      {banner ? (
        <div style={bannerStyle(banner.kind)}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>{banner.title}</div>
          <div style={{ opacity: 0.9 }}>{banner.body}</div>
        </div>
      ) : null}

      {/* Summary + Exports */}
      <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div style={{ minWidth: 420, flex: 1 }}>
            <SectionTitle>Run Summary</SectionTitle>

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <span style={badgeStyle(ladder)}>
                Lane: {ladder.toUpperCase()}
                {ladder === "live" ? " (Live)" : ladder === "cache" ? " (Replay)" : ladder === "offline" ? " (Fallback)" : ""}
              </span>

              <span style={{ opacity: 0.8, fontWeight: 700 }}>{sampleLabel}</span>

              {resp ? (
                <span style={{ opacity: 0.8 }}>
                  <b>Status:</b> {resp.ok ? "OK" : "FAIL"}
                </span>
              ) : (
                <span style={{ opacity: 0.6 }}>Run something to see results</span>
              )}
            </div>

            <div style={{ display: "grid", gap: 6, opacity: 0.95 }}>
              <div>
                <b>Requested:</b> {requested} <span style={{ opacity: 0.75 }}>(selector: {mode})</span>
              </div>

              <div>
                <b>Model used:</b> {modelUsed ?? "—"}{" "}
                {resp?.ok ? (
                  liveConfirmed ? (
                    <span style={{ marginLeft: 8, fontWeight: 900 }}>✅ LIVE proof OK</span>
                  ) : isGeminiModelUsed(modelUsed) ? (
                    <span style={{ marginLeft: 8, fontWeight: 900 }}>✅ model</span>
                  ) : (
                    <span style={{ marginLeft: 8, fontWeight: 900 }}>↳ fallback</span>
                  )
                ) : null}
              </div>

              <div>
                <b>Elapsed:</b> {fmtMs(orch?.elapsedMs)} <span style={{ opacity: 0.75 }}>(runId: {runId})</span>
              </div>

              <div>
                <b>Coverage:</b> {round2(sum?.coveragePercent)}%
              </div>

              <div>
                <b>Proof:</b> {sum?.proof ?? "—"}
                {typeof sum?.proofVerifiedCount === "number" && typeof sum?.proofTotalEvidenceRefs === "number" ? (
                  <span style={{ opacity: 0.85 }}>
                    {" "}
                    (refs: {sum.proofVerifiedCount}/{sum.proofTotalEvidenceRefs})
                  </span>
                ) : null}
              </div>

              <div>
                <b>Counts:</b> total {sum?.total ?? "—"} / covered {sum?.covered ?? "—"} / partial {sum?.partial ?? "—"} / missing{" "}
                {sum?.missing ?? "—"}
              </div>

              <div>
                <b>Lane meaning:</b> <span style={{ opacity: 0.85 }}>{laneExplainer(ladder)}</span>
              </div>

              <div>
                <b>Warnings:</b> {topWarnings.length ? topWarnings.join(" | ") : "—"}
              </div>

              {orch?.cache ? (
                <div style={{ opacity: 0.9 }}>
                  <b>Cache:</b> hit {String(orch.cache.hit ?? "—")} / lane {orch.cache.lane ?? "—"} / source{" "}
                  {orch.cache.source ?? "—"}
                  {typeof orch.cache.ageSeconds === "number" ? ` / age ${orch.cache.ageSeconds}s` : ""}
                </div>
              ) : null}
            </div>

            {/* Client-side run JSON download */}
            {resp ? (
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() =>
                    downloadText(`matrixmint-run-${runId}.json`, JSON.stringify(resp, null, 2), "application/json;charset=utf-8")
                  }
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    cursor: "pointer",
                    fontWeight: 800,
                  }}
                  title="Downloads the current response shown on this page."
                >
                  Download run JSON (client)
                </button>
              </div>
            ) : null}

            {/* Optional mini matrix preview */}
            {showMiniMatrix ? (
              <div style={{ marginTop: 14, padding: 12, borderRadius: 12, border: "1px solid #eee", background: "#fafafa" }}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>Mini Matrix Preview (first 10)</div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr>
                        {["ID", "Status", "Category", "Evidence", "Risks"].map((h) => (
                          <th key={h} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {miniRequirements!.map((r: any, idx: number) => (
                        <tr key={idx}>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2", fontWeight: 900 }}>{String(r?.id ?? "—")}</td>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>{String(r?.status ?? "—")}</td>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>{String(r?.category ?? "—")}</td>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>
                            {Array.isArray(r?.evidenceIds) ? r.evidenceIds.length : 0}
                          </td>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>
                            {Array.isArray(r?.riskFlags) ? r.riskFlags.length : 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                  This preview appears only if the server includes requirements in the /api/run response.
                </div>
              </div>
            ) : null}
          </div>

          <div style={{ minWidth: 380, flex: 1 }}>
            <SectionTitle>Exports</SectionTitle>

            {!resp?.exports || exportEntries.length === 0 ? (
              <div style={{ opacity: 0.75 }}>—</div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                  <button
                    onClick={downloadAllExports}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid #111",
                      background: "#111",
                      color: "#fff",
                      cursor: "pointer",
                      fontWeight: 900,
                    }}
                    title="Downloads all exports sequentially (client-side)."
                  >
                    Download ALL exports
                  </button>

                  <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 700 }}>
                    Ordered: proofpack → bidpacket → proposal → clarifications → risks
                  </span>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {exportEntries.map(([k, v]) => {
                    const ext = k.endsWith("_csv") ? "csv" : k.endsWith("_md") ? "md" : "txt";
                    const mime =
                      ext === "csv"
                        ? "text/csv;charset=utf-8"
                        : ext === "md"
                        ? "text/markdown;charset=utf-8"
                        : "text/plain;charset=utf-8";
                    const fname = `matrixmint-${runId}-${k}.${ext}`;
                    return (
                      <button
                        key={k}
                        onClick={() => downloadText(fname, String(v ?? ""), mime)}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid #ddd",
                          cursor: "pointer",
                          fontWeight: 800,
                        }}
                      >
                        Download {k}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {/* Attempts panel (trust + diagnostics) */}
            {orch?.attempts?.length ? (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>Attempts (diagnostics)</summary>
                <div style={{ marginTop: 10, overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>name</th>
                        <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>ok</th>
                        <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>status</th>
                        <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>elapsed</th>
                        <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>aborted</th>
                        <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>modelUsed</th>
                        <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orch.attempts.map((a, idx) => (
                        <tr key={idx}>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2", fontWeight: 800 }}>{a.name}</td>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>{a.ok ? "✅" : "—"}</td>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>{a.httpStatus ?? "—"}</td>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>{fmtMs(a.elapsedMs)}</td>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>{a.aborted ? "yes" : "no"}</td>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2" }}>{a.modelUsed ?? "—"}</td>
                          <td style={{ padding: 8, borderBottom: "1px solid #f2f2f2", maxWidth: 320 }}>
                            <span style={{ opacity: 0.85 }}>{a.errorPreview ? String(a.errorPreview).slice(0, 140) : "—"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}
          </div>
        </div>

        {/* Error block */}
        {!resp?.ok && (resp?.error || resp?.details) ? (
          <pre style={{ marginTop: 14, background: "#f7f7f7", padding: 10, borderRadius: 10, overflowX: "auto" }}>
            {resp.error || "Run failed."}
            {resp.details ? `\n\nDETAILS:\n${JSON.stringify(resp.details, null, 2).slice(0, 3000)}` : ""}
          </pre>
        ) : null}
      </div>

      <div style={{ opacity: 0.75, fontSize: 12 }}>
        Notes: FAST uses cache for stable demos. LIVE Proof forces a fresh run. OFFLINE is a conservative fallback.
      </div>
    </div>
  );
}
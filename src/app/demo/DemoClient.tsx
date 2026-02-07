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

type DemoAction = "NONE" | "FAST" | "LIVE_PROOF" | "BREAK_PROOF" | "HEALTH" | "JUDGE_DEMO";

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

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
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
    border: "1px solid rgba(0,0,0,0.12)",
    background: "rgba(255,255,255,0.7)",
    whiteSpace: "nowrap",
  };
  if (kind === "live") return { ...base, border: "1px solid #111", background: "#111", color: "#fff" };
  if (kind === "cache") return { ...base, border: "1px solid rgba(0,0,0,0.25)" };
  if (kind === "offline") return { ...base, border: "1px solid rgba(0,0,0,0.18)", background: "#fafafa" };
  return base;
}

function bannerStyle(kind: "info" | "warn" | "error" | "success") {
  const base: React.CSSProperties = {
    borderRadius: 14,
    padding: 14,
    border: "1px solid rgba(0,0,0,0.12)",
    background: "rgba(255,255,255,0.8)",
  };
  if (kind === "success") return { ...base, border: "1px solid #b9d9b9", background: "#f3fbf3" };
  if (kind === "warn") return { ...base, border: "1px solid #d6c7a1", background: "#fff8e8" };
  if (kind === "error") return { ...base, border: "1px solid #d4a1a1", background: "#fff4f4" };
  return base;
}

function laneExplainer(lane: "live" | "cache" | "offline" | "none") {
  if (lane === "live") return "LIVE = fresh Gemini execution (proof-worthy).";
  if (lane === "cache") return "CACHE = replay for stable demo + speed.";
  if (lane === "offline") return "OFFLINE = deterministic fallback for reliability.";
  return "—";
}

function primaryBtn(disabled?: boolean): React.CSSProperties {
  return {
    padding: "12px 16px",
    borderRadius: 14,
    border: "1px solid #111",
    background: disabled ? "#eee" : "#111",
    color: disabled ? "#111" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 900,
  };
}

function secondaryBtn(disabled?: boolean): React.CSSProperties {
  return {
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,0.18)",
    background: disabled ? "#eee" : "#fff",
    color: "#111",
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 900,
  };
}

export default function DemoClient() {
  // Inputs (kept, but moved to Advanced)
  const [rfpText, setRfpText] = useState("");
  const [capabilityText, setCapabilityText] = useState("");

  // Defaults
  const [model, setModel] = useState("gemini-3-flash-preview");

  // UI state
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<DemoAction>("NONE");
  const [resp, setResp] = useState<RunResponse | null>(null);
  const [health, setHealth] = useState<HealthResult | null>(null);

  // Toggles
  const [autoDownloadExports, setAutoDownloadExports] = useState(true);
  const [includeBreakProof, setIncludeBreakProof] = useState(true);

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

  const runWithHeaders = useCallback(
    async (headers: Record<string, string>, label: DemoAction) => {
      setLoading(true);
      setAction(label);

      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers,
          body: JSON.stringify(mkBody(false)),
        });

        const text = await res.text();
        const parsed = safeJsonParse(text);

        if (!res.ok || !parsed || typeof parsed.ok !== "boolean") {
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
            },
          });
          return null;
        }

        setResp(parsed as RunResponse);
        return parsed as RunResponse;
      } catch (e: any) {
        setResp({ ok: false, error: String(e?.message ?? e) });
        return null;
      } finally {
        setLoading(false);
      }
    },
    [mkBody]
  );

  // Preflight: don’t scare judges; only show if it fails
  const preflight = useCallback(async (): Promise<boolean> => {
    const steps: HealthResult["steps"] = [];
    try {
      const s = await fetch("/api/samples");
      const sText = await s.text();
      if (!s.ok) {
        steps.push({ name: "GET /api/samples", ok: false, detail: `HTTP ${s.status}: ${sText.slice(0, 200)}` });
        setHealth({ ok: false, steps, hint: "Routing broken. Ensure production build is serving /api." });
        return false;
      }
      steps.push({ name: "GET /api/samples", ok: true, detail: "OK" });

      const r = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-matrixmint-mode": "cache" },
        body: JSON.stringify({ sampleId: "disaster-relief", model, download: false }),
      });
      const rText = await r.text();
      const parsed = safeJsonParse(rText);
      if (!r.ok || !parsed?.ok) {
        steps.push({
          name: "POST /api/run (cache)",
          ok: false,
          detail: `HTTP ${r.status} • ${String(parsed?.error || rText || "failed").slice(0, 180)}`,
        });
        setHealth({
          ok: false,
          steps,
          hint: "If curl works but browser fails: origin/proxy mismatch (https://localhost vs http://127.0.0.1).",
        });
        return false;
      }
      steps.push({
        name: "POST /api/run (cache)",
        ok: true,
        detail: `OK • proof=${parsed?.runSummary?.proof || "—"} • coverage=${parsed?.runSummary?.coveragePercent ?? "—"}%`,
      });

      setHealth({ ok: true, steps, hint: "Backend OK." });
      return true;
    } catch (e: any) {
      steps.push({ name: "Preflight", ok: false, detail: String(e?.message ?? e) });
      setHealth({ ok: false, steps, hint: "Network/server error. Run: npm run build && npm run start." });
      return false;
    }
  }, [model]);

  const orch = resp?.orchestrator;
  const sum = resp?.runSummary;

  const ladder = (orch?.ladderUsed || "none") as "live" | "cache" | "offline" | "none";
  const requested = (orch?.modeRequested || "cache") as RunMode;
  const modelUsed = orch?.modelUsed;

  const liveConfirmed = requested === "live" && ladder === "live" && isGeminiModelUsed(modelUsed);
  const runId = orch?.runId || "run";

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
    for (const [k, v] of exportEntries) {
      const ext = k.endsWith("_csv") ? "csv" : k.endsWith("_md") ? "md" : "txt";
      const mime =
        ext === "csv"
          ? "text/csv;charset=utf-8"
          : ext === "md"
          ? "text/markdown;charset=utf-8"
          : "text/plain;charset=utf-8";
      const fname = `matrixmint-${runId}-${k}.${ext}`;
      downloadText(fname, String(v ?? ""), mime);
      await sleep(120);
    }
  }, [resp?.exports, exportEntries, runId]);

  const copyRunId = useCallback(() => {
    navigator.clipboard?.writeText(runId).catch(() => {});
  }, [runId]);

  const copyRepro = useCallback(() => {
    const cmd = [
      `curl -s -X POST http://127.0.0.1:3000/api/run \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "x-matrixmint-mode: live" \\`,
      `  -H "x-matrixmint-bust-cache: 1" \\`,
      `  -d '{"sampleId":"disaster-relief","model":"${model}","download":false}' \\`,
      `| jq '.ok,.orchestrator.ladderUsed,.orchestrator.modelUsed,.runSummary.proof,.runSummary.coveragePercent'`,
    ].join("\n");
    navigator.clipboard?.writeText(cmd).catch(() => {});
  }, [model]);

  // The ONE button judges click.
  const runJudgeDemo = useCallback(async () => {
    setHealth(null);

    const ok = await preflight();
    if (!ok) return; // show health failure card only

    // FAST
    await runWithHeaders({ "Content-Type": "application/json", "x-matrixmint-mode": "cache" }, "FAST");
    const r1 = lastRespRef.current;
    if (!r1?.ok) return;

    // optional export download immediately (stable)
    if (autoDownloadExports && r1.exports && Object.keys(r1.exports).length) {
      const entries = Object.entries(r1.exports);
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
        downloadText(`matrixmint-${r1.orchestrator?.runId || "run"}-${k}.${ext}`, String(v ?? ""), mime);
        await sleep(120);
      }
    }

    // LIVE proof
    await runWithHeaders(
      { "Content-Type": "application/json", "x-matrixmint-mode": "live", "x-matrixmint-bust-cache": "1" },
      "LIVE_PROOF"
    );
    const r2 = lastRespRef.current;
    if (!r2?.ok) return;

    // optional WOW
    if (includeBreakProof) {
      await runWithHeaders(
        {
          "Content-Type": "application/json",
          "x-matrixmint-mode": "live",
          "x-matrixmint-bust-cache": "1",
          "x-matrixmint-demo-break-proof": "1",
        },
        "BREAK_PROOF"
      );
    }

    setAction("JUDGE_DEMO");
  }, [autoDownloadExports, exportOrder, includeBreakProof, preflight, runWithHeaders]);

  // Banner logic: show only meaningful messages
  const banner = useMemo(() => {
    if (!resp) return null;
    if (!resp.ok) {
      return { kind: "error" as const, title: "Run failed", body: resp.error || "Unknown error." };
    }
    if (action === "HEALTH") return { kind: "success" as const, title: "Health check OK", body: "Backend endpoints responded correctly." };
    if (liveConfirmed) {
      return {
        kind: "success" as const,
        title: "Live execution confirmed",
        body: `Lane: LIVE • Model: ${modelUsed} • Elapsed: ${fmtMs(orch?.elapsedMs)}`,
      };
    }
    return null;
  }, [resp, action, liveConfirmed, modelUsed, orch?.elapsedMs]);

  const stickyBar: React.CSSProperties = {
    position: "sticky",
    top: 0,
    zIndex: 30,
    background: "rgba(255,255,255,0.92)",
    backdropFilter: "blur(10px)",
    border: "1px solid rgba(0,0,0,0.08)",
    borderRadius: 16,
    padding: 14,
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Sticky Judge Scoreboard */}
      <div style={stickyBar}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 14 }}>Judge Scoreboard</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Lane • model • coverage • proof • exports • runId</div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={badgeStyle(ladder)}>Lane: {ladder.toUpperCase()}</span>
            <span style={badgeStyle("none")}>Model: {modelUsed ?? model}</span>
            <span style={badgeStyle("none")}>Coverage: {coveragePct}</span>
            <span style={badgeStyle("none")}>Proof: {proofString}</span>
            <span style={badgeStyle("none")}>Exports: {exportEntries.length ? `${exportEntries.length} ready` : "—"}</span>

            <button onClick={copyRunId} style={secondaryBtn(false)} title="Copy runId">
              Copy runId
            </button>

            <button onClick={copyRepro} style={secondaryBtn(false)} title="Copy a one-shot LIVE proof curl command">
              Copy repro
            </button>
          </div>
        </div>
      </div>

      {/* Main judge actions (minimal) */}
      <div style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: 16, padding: 16, background: "#fafafa" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 16 }}>Recommended Judge Demo</div>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
              One click runs: Preflight → FAST (stable) → LIVE Proof (fresh Gemini) → optional Break-Proof.
            </div>
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
              {laneExplainer(ladder)}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={runJudgeDemo} disabled={loading} style={primaryBtn(loading)}>
              {loading ? "Running…" : "Run Judge Demo"}
            </button>

            <button onClick={downloadAllExports} disabled={!resp?.exports || loading} style={secondaryBtn(!resp?.exports || loading)}>
              Download all exports
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 800 }}>
            <input type="checkbox" checked={includeBreakProof} onChange={(e) => setIncludeBreakProof(Boolean(e.target.checked))} />
            Include Break-Proof (wow)
          </label>

          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 800 }}>
            <input type="checkbox" checked={autoDownloadExports} onChange={(e) => setAutoDownloadExports(Boolean(e.target.checked))} />
            Auto-download exports
          </label>
        </div>

        {/* Health only shows when it matters */}
        {health && !health.ok ? (
          <div style={{ marginTop: 14, ...bannerStyle("warn") }}>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>Preflight issue detected</div>
            <div style={{ display: "grid", gap: 6, fontSize: 12, opacity: 0.9 }}>
              {health.steps.map((s, idx) => (
                <div key={idx}>
                  <b>{s.ok ? "✅" : "❌"} {s.name}:</b> <span style={{ opacity: 0.85 }}>{s.detail || "—"}</span>
                </div>
              ))}
            </div>
            {health.hint ? (
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9 }}>
                <b>Hint:</b> {health.hint}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Banner (only when meaningful) */}
      {banner ? (
        <div style={bannerStyle(banner.kind)}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>{banner.title}</div>
          <div style={{ opacity: 0.9 }}>{banner.body}</div>
        </div>
      ) : null}

      {/* Results (compact) */}
      {resp?.ok ? (
        <div style={{ border: "1px solid rgba(0,0,0,0.12)", borderRadius: 16, padding: 16 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "space-between" }}>
            <div style={{ minWidth: 360, flex: 1 }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>Run Summary</div>
              <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                <div><b>Status:</b> OK</div>
                <div><b>Lane:</b> {ladder.toUpperCase()} {ladder === "live" && liveConfirmed ? "✅ (LIVE proof OK)" : ""}</div>
                <div><b>Model used:</b> {modelUsed ?? "—"}</div>
                <div><b>Elapsed:</b> {fmtMs(orch?.elapsedMs)} <span style={{ opacity: 0.75 }}>(runId: {runId})</span></div>
                <div><b>Coverage:</b> {coveragePct}</div>
                <div><b>Proof:</b> {proofString}</div>
                <div>
                  <b>Counts:</b> total {sum?.total ?? "—"} / covered {sum?.covered ?? "—"} / partial {sum?.partial ?? "—"} / missing {sum?.missing ?? "—"}
                </div>
                {Array.isArray(orch?.warnings) && orch?.warnings?.length ? (
                  <div><b>Warnings:</b> {orch.warnings.slice(0, 2).join(" | ")}</div>
                ) : null}
              </div>

              <div style={{ marginTop: 12 }}>
                <button
                  onClick={() => downloadText(`matrixmint-run-${runId}.json`, JSON.stringify(resp, null, 2), "application/json;charset=utf-8")}
                  style={secondaryBtn(false)}
                >
                  Download run JSON
                </button>
              </div>
            </div>

            <div style={{ minWidth: 360, flex: 1 }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>Exports</div>
              {exportEntries.length ? (
                <>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                    <button onClick={downloadAllExports} style={primaryBtn(false)}>Download ALL exports</button>
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {exportEntries.map(([k, v]) => {
                      const ext = k.endsWith("_csv") ? "csv" : k.endsWith("_md") ? "md" : "txt";
                      const mime =
                        ext === "csv"
                          ? "text/csv;charset=utf-8"
                          : ext === "md"
                          ? "text/markdown;charset=utf-8"
                          : "text/plain;charset=utf-8";
                      return (
                        <button
                          key={k}
                          onClick={() => downloadText(`matrixmint-${runId}-${k}.${ext}`, String(v ?? ""), mime)}
                          style={secondaryBtn(false)}
                        >
                          Download {k}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div style={{ opacity: 0.75 }}>—</div>
              )}

              {/* Diagnostics moved under a disclosure to avoid clutter */}
              {orch?.attempts?.length ? (
                <details style={{ marginTop: 14 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 900 }}>Diagnostics (attempts)</summary>
                  <pre style={{ marginTop: 10, background: "#f7f7f7", padding: 12, borderRadius: 12, overflowX: "auto", fontSize: 12 }}>
                    {JSON.stringify(orch.attempts, null, 2).slice(0, 5000)}
                  </pre>
                </details>
              ) : null}
            </div>
          </div>
        </div>
      ) : resp && !resp.ok ? (
        <pre style={{ background: "#fff4f4", border: "1px solid #d4a1a1", padding: 14, borderRadius: 16, overflowX: "auto" }}>
          {resp.error || "Run failed."}
          {resp.details ? `\n\nDETAILS:\n${JSON.stringify(resp.details, null, 2).slice(0, 4000)}` : ""}
        </pre>
      ) : null}

      {/* Advanced section (kept, but hidden by default) */}
      <details style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: 16, padding: 14 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900 }}>Advanced (optional)</summary>

        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 800 }}>RFP Text</div>
            <textarea
              value={rfpText}
              onChange={(e) => setRfpText(e.target.value)}
              rows={10}
              placeholder="Paste RFP text here (or leave blank to use the sample)."
              style={{
                width: "100%",
                marginTop: 6,
                padding: 10,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.15)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 12,
              }}
            />
          </div>
          <div>
            <div style={{ fontWeight: 800 }}>Capability Statement</div>
            <textarea
              value={capabilityText}
              onChange={(e) => setCapabilityText(e.target.value)}
              rows={10}
              placeholder="Paste capability statement here (or leave blank to use the sample)."
              style={{
                width: "100%",
                marginTop: 6,
                padding: 10,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.15)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 12,
              }}
            />
          </div>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ fontWeight: 900 }}>Model:</div>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{
              padding: 10,
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.15)",
              minWidth: 260,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
            }}
          />
          <button
            onClick={async () => {
              setHealth(null);
              setAction("HEALTH");
              await preflight();
            }}
            disabled={loading}
            style={secondaryBtn(loading)}
          >
            Run Health Check
          </button>
        </div>
      </details>

      <div style={{ fontSize: 12, opacity: 0.7 }}>
        Tip: for judges, lead with <b>Run Judge Demo</b>, then <b>Download all exports</b>. Keep Advanced closed.
      </div>
    </div>
  );
}
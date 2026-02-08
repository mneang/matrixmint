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

type DemoStage =
  | "idle"
  | "preflight_running"
  | "preflight_ok"
  | "fast_running"
  | "fast_ok"
  | "live_running"
  | "live_ok"
  | "break_running"
  | "break_ok"
  | "done"
  | "failed";

function fmtMs(ms?: number) {
  if (typeof ms !== "number") return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function round2(n?: number) {
  if (typeof n !== "number") return "—";
  return (Math.round(n * 100) / 100).toFixed(2);
}

function safeJsonParse(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function isGeminiModelUsed(modelUsed?: string) {
  return typeof modelUsed === "string" && modelUsed.startsWith("gemini-");
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

function badgeStyle(kind: "live" | "cache" | "offline" | "none") {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "8px 12px",
    borderRadius: 999,
    fontWeight: 900,
    fontSize: 13,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "#fff",
    whiteSpace: "nowrap",
  };
  if (kind === "live") return { ...base, border: "1px solid #111", background: "#111", color: "#fff" };
  if (kind === "cache") return { ...base, border: "1px solid rgba(0,0,0,0.18)", background: "#fff", color: "#111" };
  if (kind === "offline") return { ...base, border: "1px solid rgba(0,0,0,0.12)", background: "#fafafa", color: "#111" };
  return base;
}

function pillStyle(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "8px 12px",
    borderRadius: 999,
    fontSize: 13,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "#fff",
    fontWeight: 900,
    whiteSpace: "nowrap",
  };
}

function panelStyle(bg?: string): React.CSSProperties {
  return {
    border: "1px solid rgba(0,0,0,0.10)",
    borderRadius: 16,
    padding: 16,
    background: bg || "#fff",
  };
}

function bannerStyle(kind: "success" | "warn" | "error" | "info") {
  const base: React.CSSProperties = {
    borderRadius: 16,
    padding: 14,
    border: "1px solid rgba(0,0,0,0.10)",
    background: "#fafafa",
  };
  if (kind === "success") return { ...base, border: "1px solid #b9d9b9", background: "#f3fbf3" };
  if (kind === "warn") return { ...base, border: "1px solid #d6c7a1", background: "#fff9eb" };
  if (kind === "error") return { ...base, border: "1px solid #d4a1a1", background: "#fff4f4" };
  return { ...base, border: "1px solid rgba(0,0,0,0.10)", background: "#f7f7f7" };
}

function StepDot({ state }: { state: "todo" | "active" | "ok" | "fail" }) {
  const bg =
    state === "ok" ? "#111" : state === "fail" ? "#b00020" : state === "active" ? "#666" : "rgba(0,0,0,0.20)";
  return <span style={{ width: 10, height: 10, borderRadius: 999, display: "inline-block", background: bg }} />;
}

function laneExplainer(lane: "live" | "cache" | "offline" | "none") {
  if (lane === "live") return "Fresh Gemini execution (proof-worthy).";
  if (lane === "cache") return "Stable replay for fast demos.";
  if (lane === "offline") return "Deterministic fallback for reliability.";
  return "—";
}

function extractHelpfulHint(parsed: any): string | null {
  const incomingOrigin = parsed?.details?.incomingOrigin;
  const internalOrigin = parsed?.details?.internalOrigin;
  if (typeof incomingOrigin === "string" && incomingOrigin.startsWith("https://localhost")) {
    return [
      "Likely cause: browser origin is https://localhost, but internal fetch is http.",
      "Fix: set MATRIXMINT_INTERNAL_ORIGIN=http://127.0.0.1:3000 (or your port) and use it for internal server fetches.",
      "Workaround: open app via http://127.0.0.1:3000 instead of https://localhost:3000.",
      internalOrigin ? `Internal origin detected: ${internalOrigin}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return null;
}

export default function DemoClient() {
  // Advanced inputs (collapsed by default)
  const [rfpText, setRfpText] = useState("");
  const [capabilityText, setCapabilityText] = useState("");
  const [model, setModel] = useState("gemini-3-flash-preview");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Submission toggles
  const [includeBreakHeal, setIncludeBreakHeal] = useState(true);
  const [autoDownloadPacket, setAutoDownloadPacket] = useState(true);

  // State
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<DemoStage>("idle");
  const [stageError, setStageError] = useState<string>("");

  // Results
  const [resp, setResp] = useState<RunResponse | null>(null);
  const [health, setHealth] = useState<HealthResult | null>(null);

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
    async (headers: Record<string, string>, label: string) => {
      setLoading(true);
      setStageError("");

      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers,
          body: JSON.stringify(mkBody(false)),
        });

        const text = await res.text();
        const parsed = safeJsonParse(text);

        if (!res.ok) {
          const hint = parsed ? extractHelpfulHint(parsed) : null;
          const fail: RunResponse = {
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
          };
          setResp(fail);
          return fail;
        }

        if (!parsed || typeof parsed.ok !== "boolean") {
          const fail: RunResponse = {
            ok: false,
            error: `Unexpected response from ${label}.`,
            details: { preview: text.slice(0, 800) },
          };
          setResp(fail);
          return fail;
        }

        setResp(parsed as RunResponse);
        return parsed as RunResponse;
      } catch (e: any) {
        const fail: RunResponse = { ok: false, error: String(e?.message ?? e) };
        setResp(fail);
        return fail;
      } finally {
        setLoading(false);
      }
    },
    [mkBody]
  );

  const downloadServerPacket = useCallback(
    async (headers: Record<string, string>, fallbackName: string) => {
      setLoading(true);
      try {
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
          return false;
        }

        const cd = res.headers.get("content-disposition");
        const filename = parseFilenameFromContentDisposition(cd) || fallbackName;

        const blob = await res.blob();
        await downloadBlob(filename, blob);
        return true;
      } catch (e: any) {
        setResp({ ok: false, error: String(e?.message ?? e) });
        return false;
      } finally {
        setLoading(false);
      }
    },
    [mkBody]
  );

  // ---------- Preflight ----------
  const preflight = useCallback(async () => {
    const steps: HealthResult["steps"] = [];
    setHealth(null);

    try {
      const s = await fetch("/api/samples");
      const sText = await s.text();
      if (!s.ok) {
        steps.push({ name: "GET /api/samples", ok: false, detail: `HTTP ${s.status}: ${sText.slice(0, 200)}` });
        const hr: HealthResult = {
          ok: false,
          steps,
          hint: "If /api/samples fails, routing is broken in production/start mode.",
        };
        setHealth(hr);
        return hr;
      }
      steps.push({ name: "GET /api/samples", ok: true, detail: "OK" });

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
          name: "POST /api/run (FAST)",
          ok: false,
          detail: `HTTP ${r.status} • ${String(parsed?.error || rText || "failed").slice(0, 160)}`,
        });
        const hr: HealthResult = {
          ok: false,
          steps,
          hint:
            hint ||
            "If curl works but browser fails, it’s likely an origin/proxy mismatch (https://localhost vs http) or blocked downloads.",
        };
        setHealth(hr);
        return hr;
      }

      steps.push({
        name: "POST /api/run (FAST)",
        ok: true,
        detail: `OK • proof=${parsed?.runSummary?.proof || "—"} • coverage=${parsed?.runSummary?.coveragePercent ?? "—"}%`,
      });

      const hr: HealthResult = {
        ok: true,
        steps,
        hint: "Preflight OK.",
      };
      setHealth(hr);
      return hr;
    } catch (e: any) {
      steps.push({ name: "Preflight", ok: false, detail: String(e?.message ?? e) });
      const hr: HealthResult = {
        ok: false,
        steps,
        hint: "Network/server error. Rebuild: npm run build && npm run start.",
      };
      setHealth(hr);
      return hr;
    }
  }, [model]);

  // ---------- One-click Submission Demo ----------
  const runSubmissionDemo = useCallback(async () => {
    setStageError("");
    setStage("preflight_running");
    setResp(null);

    // 1) Preflight
    const pf = await preflight();
    if (!pf.ok) {
      setStage("failed");
      setStageError("Preflight failed in browser. Backend may be OK via curl — likely origin/proxy mismatch.");
      return;
    }
    setStage("preflight_ok");

    // 2) FAST (cache)
    setStage("fast_running");
    const fastHeaders: Record<string, string> = { "Content-Type": "application/json", "x-matrixmint-mode": "cache" };
    const r1 = await runWithHeaders(fastHeaders, "FAST");
    if (!r1.ok) {
      setStage("failed");
      setStageError("FAST failed in browser. Check /api/run routing and origin mismatch.");
      return;
    }
    setStage("fast_ok");

    // 3) LIVE Proof (fresh)
    setStage("live_running");
    const liveHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-matrixmint-mode": "live",
      "x-matrixmint-bust-cache": "1",
    };
    const r2 = await runWithHeaders(liveHeaders, "LIVE_PROOF");
    if (!r2.ok) {
      setStage("failed");
      setStageError("LIVE Proof failed. If quota hits, show FAST result and retry LIVE once.");
      return;
    }
    setStage("live_ok");

    // 4) Break+Heal (optional wow)
    if (includeBreakHeal) {
      setStage("break_running");
      const breakHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "x-matrixmint-mode": "live",
        "x-matrixmint-bust-cache": "1",
        "x-matrixmint-demo-break-proof": "1",
      };
      const r3 = await runWithHeaders(breakHeaders, "BREAK_HEAL");
      if (!r3.ok) {
        setStage("done");
        setStageError("Break+Heal failed (optional). LIVE proof still stands.");
      } else {
        setStage("break_ok");
      }
    }

    setStage("done");

    if (autoDownloadPacket) {
      await downloadServerPacket(
        {
          "Content-Type": "application/json",
          "x-matrixmint-mode": "live",
          "x-matrixmint-bust-cache": "1",
        },
        `matrixmint-submission-packet-live-${Date.now()}.json`
      );
    }
  }, [autoDownloadPacket, downloadServerPacket, includeBreakHeal, preflight, runWithHeaders]);

  // ---------- Derived view ----------
  const orch = resp?.orchestrator;
  const sum = resp?.runSummary;

  const ladder = (orch?.ladderUsed || "none") as "live" | "cache" | "offline" | "none";
  const modelUsed = orch?.modelUsed;
  const runId = orch?.runId || "—";
  const liveConfirmed = Boolean(resp?.ok && ladder === "live" && isGeminiModelUsed(modelUsed));

  const coveragePct = useMemo(() => (typeof sum?.coveragePercent === "number" ? `${round2(sum.coveragePercent)}%` : "—"), [sum]);
  const proofString = useMemo(() => sum?.proof || "—", [sum]);

  const warnings = Array.isArray(orch?.warnings) ? orch!.warnings! : [];
  const topWarnings = warnings.slice(0, 2);

  const exportsObj = resp?.exports || {};
  const exportKeys = Object.keys(exportsObj);

  const curlRepro = useMemo(() => {
    return `curl -s -X POST http://127.0.0.1:3000/api/run \\
  -H "Content-Type: application/json" \\
  -H "x-matrixmint-mode: live" \\
  -H "x-matrixmint-bust-cache: 1" \\
  -d '{"sampleId":"disaster-relief","model":"${model || "gemini-3-flash-preview"}","download":false}' \\
| jq '.ok,.orchestrator.ladderUsed,.orchestrator.modelUsed,.runSummary.proof,.runSummary.coveragePercent,.orchestrator.warnings'`;
  }, [model]);

  const steps = useMemo(() => {
    const s: Array<{ name: string; state: "todo" | "active" | "ok" | "fail" }> = [
      { name: "Preflight", state: "todo" },
      { name: "FAST", state: "todo" },
      { name: "LIVE Proof", state: "todo" },
      ...(includeBreakHeal ? [{ name: "Break+Heal", state: "todo" as const }] : []),
    ];

    const mark = (idx: number, state: "todo" | "active" | "ok" | "fail") => {
      if (s[idx]) s[idx] = { ...s[idx], state };
    };

    if (stage === "idle") return s;

    if (stage === "preflight_running") mark(0, "active");
    if (stage === "preflight_ok") mark(0, "ok");

    if (stage === "fast_running") {
      mark(0, "ok");
      mark(1, "active");
    }
    if (stage === "fast_ok") {
      mark(0, "ok");
      mark(1, "ok");
    }

    if (stage === "live_running") {
      mark(0, "ok");
      mark(1, "ok");
      mark(2, "active");
    }
    if (stage === "live_ok") {
      mark(0, "ok");
      mark(1, "ok");
      mark(2, "ok");
    }

    if (includeBreakHeal) {
      const breakIdx = 3;
      if (stage === "break_running") {
        mark(0, "ok");
        mark(1, "ok");
        mark(2, "ok");
        mark(breakIdx, "active");
      }
      if (stage === "break_ok" || stage === "done") {
        mark(0, "ok");
        mark(1, "ok");
        mark(2, "ok");
        mark(breakIdx, stage === "break_ok" ? "ok" : stageError ? "fail" : "ok");
      }
    }

    if (stage === "failed") {
      mark(0, health?.ok ? "ok" : "fail");
      if (!health?.ok) return s;
      mark(1, "fail");
    }

    return s;
  }, [includeBreakHeal, stage, stageError, health?.ok]);

  const primaryBtnLabel =
    loading || stage === "preflight_running" || stage === "fast_running" || stage === "live_running" || stage === "break_running"
      ? "Running…"
      : "Run One-Click Demo";

  const canClick = !loading;

  const downloadPacketFast = useCallback(async () => {
    await downloadServerPacket(
      { "Content-Type": "application/json", "x-matrixmint-mode": "cache" },
      `matrixmint-submission-packet-fast-${Date.now()}.json`
    );
  }, [downloadServerPacket]);

  const downloadPacketLive = useCallback(async () => {
    await downloadServerPacket(
      { "Content-Type": "application/json", "x-matrixmint-mode": "live", "x-matrixmint-bust-cache": "1" },
      `matrixmint-submission-packet-live-${Date.now()}.json`
    );
  }, [downloadServerPacket]);

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto", padding: 18, display: "grid", gap: 14 }}>
      {/* Hero */}
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ fontSize: 40, fontWeight: 1000, letterSpacing: -0.5, lineHeight: 1.05 }}>Live Proof Demo</div>
        <div style={{ fontSize: 15, opacity: 0.85, lineHeight: 1.45 }}>
          Generates a compliance matrix anchored to evidence, verifies proof, and produces export-ready artifacts.
        </div>
      </div>

      {/* Run Summary (compact, judge-readable) */}
      <div style={panelStyle()}>
        <div style={{ fontWeight: 950, fontSize: 18, marginBottom: 10 }}>Run Summary</div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <span style={badgeStyle(ladder)}>Lane: {ladder.toUpperCase()}</span>
          <span style={pillStyle()}>Model: {modelUsed ?? model}</span>
          <span style={pillStyle()}>Coverage: {coveragePct}</span>
          <span style={pillStyle()}>Proof: {proofString}</span>
          <span style={pillStyle()}>Exports: {exportKeys.length ? `${exportKeys.length} ready` : "—"}</span>

          <div style={{ flex: 1 }} />

          <button
            onClick={() => navigator.clipboard?.writeText(runId).catch(() => {})}
            style={{
              padding: "10px 14px",
              borderRadius: 14,
              border: "1px solid rgba(0,0,0,0.18)",
              background: "#fff",
              cursor: "pointer",
              fontWeight: 950,
            }}
            title="Copy runId"
          >
            Copy runId
          </button>

          <button
            onClick={() => navigator.clipboard?.writeText(curlRepro).catch(() => {})}
            style={{
              padding: "10px 14px",
              borderRadius: 14,
              border: "1px solid rgba(0,0,0,0.18)",
              background: "#fff",
              cursor: "pointer",
              fontWeight: 950,
            }}
            title="Copy curl repro"
          >
            Copy curl
          </button>
        </div>

        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
          {liveConfirmed ? "✅ Live execution confirmed." : resp?.ok ? "Run LIVE Proof to confirm fresh Gemini execution." : "Run the demo to generate a proof-locked result."}
        </div>

        {topWarnings.length ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
            <b>Warnings:</b> {topWarnings.join(" | ")}
          </div>
        ) : null}
      </div>

      {/* One-click flow (minimal controls) */}
      <div style={panelStyle("#fafafa")}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ minWidth: 360 }}>
            <div style={{ fontWeight: 1000, fontSize: 20, marginBottom: 6 }}>One-Click Submission Flow</div>
            <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.5 }}>
              Runs: <b>Preflight</b> → <b>FAST</b> → <b>LIVE Proof</b> → optional <b>Break+Heal</b>.
              <div style={{ marginTop: 6 }}>
                The <b>Submission Packet</b> is a single JSON file containing the run receipt + all export documents (Proof Pack, Bid Packet, Clarifications Email, Risks CSV, Proposal Draft).
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button
              onClick={runSubmissionDemo}
              disabled={!canClick}
              style={{
                padding: "12px 16px",
                borderRadius: 16,
                border: "1px solid #111",
                background: !canClick ? "#eee" : "#111",
                color: !canClick ? "#111" : "#fff",
                cursor: !canClick ? "not-allowed" : "pointer",
                fontWeight: 1000,
                minWidth: 220,
              }}
              title="Runs the full narrative with live proof."
            >
              {primaryBtnLabel}
            </button>

            <button
              onClick={downloadPacketLive}
              disabled={!canClick}
              style={{
                padding: "12px 16px",
                borderRadius: 16,
                border: "1px solid rgba(0,0,0,0.18)",
                background: "#fff",
                cursor: !canClick ? "not-allowed" : "pointer",
                fontWeight: 1000,
              }}
              title="Downloads the single-file packet (live lane)."
            >
              Download Submission Packet (LIVE)
            </button>

            <button
              onClick={downloadPacketFast}
              disabled={!canClick}
              style={{
                padding: "12px 16px",
                borderRadius: 16,
                border: "1px solid rgba(0,0,0,0.18)",
                background: "#fff",
                cursor: !canClick ? "not-allowed" : "pointer",
                fontWeight: 1000,
              }}
              title="Downloads the single-file packet (fast lane)."
            >
              Download Submission Packet (FAST)
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 13, fontWeight: 900 }}>
            <input type="checkbox" checked={includeBreakHeal} onChange={(e) => setIncludeBreakHeal(Boolean(e.target.checked))} />
            Include Break+Heal
          </label>

          <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 13, fontWeight: 900 }}>
            <input type="checkbox" checked={autoDownloadPacket} onChange={(e) => setAutoDownloadPacket(Boolean(e.target.checked))} />
            Auto-download packet
          </label>
        </div>

        {/* Stepper */}
        <div style={{ marginTop: 12, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <StepDot state={s.state} />
              <span style={{ fontSize: 13, fontWeight: 950, opacity: s.state === "todo" ? 0.55 : 0.95 }}>{s.name}</span>
            </div>
          ))}
          {stage === "failed" && stageError ? (
            <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 950, color: "#b00020" }}>{stageError}</span>
          ) : null}
        </div>

        {/* Preflight panel */}
        {health ? (
          <div style={{ marginTop: 12, ...bannerStyle(health.ok ? "success" : "warn") }}>
            <div style={{ fontWeight: 1000, marginBottom: 8 }}>{health.ok ? "Preflight: OK" : "Preflight: Issue detected"}</div>
            <div style={{ display: "grid", gap: 8, fontSize: 13, opacity: 0.92 }}>
              {health.steps.map((s, idx) => (
                <div key={idx}>
                  <b>{s.ok ? "✅" : "❌"} {s.name}:</b> <span style={{ opacity: 0.85 }}>{s.detail || "—"}</span>
                </div>
              ))}
            </div>
            {health.hint ? (
              <div style={{ marginTop: 10, fontSize: 13, opacity: 0.9 }}>
                <b>Hint:</b> {health.hint}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Result banner */}
      {resp ? (
        <div style={bannerStyle(resp.ok ? (liveConfirmed ? "success" : "info") : "error")}>
          <div style={{ fontWeight: 1000, marginBottom: 6 }}>
            {resp.ok ? (liveConfirmed ? "Live proof verified" : "Run completed") : "Run failed"}
          </div>
          <div style={{ fontSize: 13, opacity: 0.9 }}>
            {resp.ok ? `Lane: ${ladder.toUpperCase()} • Model: ${modelUsed ?? model} • Elapsed: ${fmtMs(orch?.elapsedMs)}` : resp.error || "Unknown error."}
          </div>
        </div>
      ) : null}

      {/* Details kept out of the way */}
      <div style={panelStyle()}>
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 1000 }}>Details (exports + diagnostics)</summary>

          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            <div style={{ fontSize: 13, opacity: 0.85 }}>
              <b>Exports inside packet:</b> {exportKeys.length ? exportKeys.join(", ") : "—"}
            </div>

            {orch?.attempts?.length ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr>
                      {["name", "ok", "status", "elapsed", "aborted", "modelUsed", "error"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orch.attempts.map((a, idx) => (
                      <tr key={idx}>
                        <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.06)", fontWeight: 900 }}>{a.name}</td>
                        <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>{a.ok ? "✅" : "—"}</td>
                        <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>{a.httpStatus ?? "—"}</td>
                        <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>{fmtMs(a.elapsedMs)}</td>
                        <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>{a.aborted ? "yes" : "no"}</td>
                        <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.06)" }}>{a.modelUsed ?? "—"}</td>
                        <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.06)", maxWidth: 420 }}>
                          <span style={{ opacity: 0.85 }}>{a.errorPreview ? String(a.errorPreview).slice(0, 160) : "—"}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {!resp?.ok && (resp?.error || resp?.details) ? (
              <pre style={{ marginTop: 6, background: "#f7f7f7", padding: 12, borderRadius: 14, overflowX: "auto" }}>
                {resp.error || "Run failed."}
                {resp.details ? `\n\nDETAILS:\n${JSON.stringify(resp.details, null, 2).slice(0, 3500)}` : ""}
              </pre>
            ) : null}
          </div>
        </details>
      </div>

      {/* Advanced (optional) */}
      <div style={panelStyle("#fff")}>
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          style={{
            width: "100%",
            textAlign: "left",
            padding: "10px 12px",
            borderRadius: 14,
            border: "1px solid rgba(0,0,0,0.12)",
            background: "#fff",
            cursor: "pointer",
            fontWeight: 1000,
            fontSize: 15,
          }}
        >
          {advancedOpen ? "▼ Advanced (optional)" : "▶ Advanced (optional)"}
        </button>

        {advancedOpen ? (
          <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ fontWeight: 900 }}>RFP Text</label>
                <textarea
                  value={rfpText}
                  onChange={(e) => setRfpText(e.target.value)}
                  rows={10}
                  placeholder="Paste RFP text here (or leave blank to use the sample)."
                  style={{
                    width: "100%",
                    marginTop: 8,
                    padding: 12,
                    borderRadius: 14,
                    border: "1px solid rgba(0,0,0,0.14)",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontSize: 12,
                  }}
                />
              </div>
              <div>
                <label style={{ fontWeight: 900 }}>Capability Statement (evidence only)</label>
                <textarea
                  value={capabilityText}
                  onChange={(e) => setCapabilityText(e.target.value)}
                  rows={10}
                  placeholder="Paste capability statement here (or leave blank to use the sample)."
                  style={{
                    width: "100%",
                    marginTop: 8,
                    padding: 12,
                    borderRadius: 14,
                    border: "1px solid rgba(0,0,0,0.14)",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontSize: 12,
                  }}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontWeight: 900 }}>Model:</span>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={{
                  padding: 10,
                  borderRadius: 14,
                  border: "1px solid rgba(0,0,0,0.14)",
                  minWidth: 300,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: 12,
                }}
              />

              <button
                onClick={async () => {
                  setStage("preflight_running");
                  const pf = await preflight();
                  setStage(pf.ok ? "preflight_ok" : "failed");
                }}
                disabled={loading}
                style={{
                  padding: "10px 14px",
                  borderRadius: 14,
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "#fff",
                  cursor: loading ? "not-allowed" : "pointer",
                  fontWeight: 1000,
                }}
              >
                Run Preflight
              </button>

              <div style={{ opacity: 0.75, fontSize: 13 }}>
                Using sample when inputs are blank: <b>{shouldUseSample ? "YES" : "NO"}</b>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ opacity: 0.7, fontSize: 12 }}>
        Notes: FAST uses cache for stability. LIVE Proof forces fresh Gemini execution. OFFLINE is a conservative fallback.
      </div>
    </div>
  );
}
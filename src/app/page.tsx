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
  meta?: any;
};

type HealthResult = {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: string }>;
  hint?: string;
};

type Stage =
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
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
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

function isGeminiModelUsed(modelUsed?: string) {
  return typeof modelUsed === "string" && modelUsed.startsWith("gemini-");
}

function badgeStyle(kind: "live" | "cache" | "offline" | "none") {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 999,
    fontWeight: 950,
    fontSize: 13,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "white",
    whiteSpace: "nowrap",
  };
  if (kind === "live") return { ...base, border: "1px solid #111", background: "#111", color: "#fff" };
  if (kind === "cache") return { ...base, border: "1px solid rgba(0,0,0,0.14)", background: "#fff", color: "#111" };
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
    background: "white",
    fontWeight: 900,
    whiteSpace: "nowrap",
  };
}

function bannerStyle(kind: "success" | "warn" | "error" | "info") {
  const base: React.CSSProperties = {
    borderRadius: 14,
    padding: 14,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "white",
  };
  if (kind === "success") return { ...base, border: "1px solid rgba(16,185,129,0.35)", background: "rgba(16,185,129,0.08)" };
  if (kind === "warn") return { ...base, border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.10)" };
  if (kind === "error") return { ...base, border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.10)" };
  return { ...base, border: "1px solid rgba(0,0,0,0.12)", background: "rgba(0,0,0,0.03)" };
}

function StepDot({ state }: { state: "off" | "on" | "done" | "fail" }) {
  const bg =
    state === "done"
      ? "#111"
      : state === "fail"
      ? "#b00020"
      : state === "on"
      ? "rgba(0,0,0,0.55)"
      : "rgba(0,0,0,0.18)";
  return <span style={{ width: 10, height: 10, borderRadius: 999, display: "inline-block", background: bg }} />;
}

function extractHelpfulHint(parsed: any): string | null {
  const incomingOrigin = parsed?.details?.incomingOrigin;
  const internalOrigin = parsed?.details?.internalOrigin;
  if (typeof incomingOrigin === "string" && incomingOrigin.startsWith("https://localhost")) {
    return [
      "Likely cause: request is coming from https://localhost, but internal fetch is expecting http.",
      "Fix: set MATRIXMINT_INTERNAL_ORIGIN=http://127.0.0.1:3000 (or your port), and ensure /api/run uses it for internal fetches.",
      "Quick workaround: open the app via http://127.0.0.1:3000 instead of https://localhost:3000.",
      internalOrigin ? `Internal origin detected: ${internalOrigin}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return null;
}

export default function Page() {
  // Inputs (default: sample)
  const [rfpText, setRfpText] = useState("");
  const [capabilityText, setCapabilityText] = useState("");

  // Model
  const [model, setModel] = useState("gemini-3-flash-preview");

  // Toggles
  const [includeBreakHeal, setIncludeBreakHeal] = useState(true);
  const [autoDownloadPacketAfterLive, setAutoDownloadPacketAfterLive] = useState(true);

  // UI state
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<RunResponse | null>(null);

  // Flow
  const [stage, setStage] = useState<Stage>("idle");
  const [flowError, setFlowError] = useState("");

  // Preflight
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [showHealth, setShowHealth] = useState(false);

  // Advanced
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // anchors for auto-scroll
  const resultAnchorRef = useRef<HTMLDivElement | null>(null);

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

  const orch = resp?.orchestrator;
  const sum = resp?.runSummary;

  const ladder = (orch?.ladderUsed || "none") as "live" | "cache" | "offline" | "none";
  const modelUsed = orch?.modelUsed ?? model;
  const runId = orch?.runId || "run";

  const liveConfirmed = ladder === "live" && isGeminiModelUsed(orch?.modelUsed);

  const proofString = useMemo(() => {
    if (!sum) return "—";
    if (typeof sum.proofVerifiedCount === "number" && typeof sum.proofTotalEvidenceRefs === "number") {
      const pct = typeof sum.proofPercent === "number" ? `${Math.round(sum.proofPercent)}%` : "—";
      return `${pct} (${sum.proofVerifiedCount}/${sum.proofTotalEvidenceRefs})`;
    }
    return sum.proof || "—";
  }, [sum]);

  const coverageString = useMemo(() => {
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

  const scrollToResults = useCallback(() => {
    const el = resultAnchorRef.current;
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      // ignore
    }
  }, []);

  // ---------- Core runner ----------
  const runWithHeaders = useCallback(
    async (headers: Record<string, string>, label: string) => {
      setLoading(true);
      setFlowError("");

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
              preview: text.slice(0, 1400),
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
            details: { preview: text.slice(0, 1000) },
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

  // ---------- Packet download (single file) ----------
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
          const fail: RunResponse = {
            ok: false,
            error: `Download failed (HTTP ${res.status})`,
            details: { preview: text.slice(0, 1400), parsed },
          };
          setResp(fail);
          return;
        }

        const cd = res.headers.get("content-disposition");
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

  const downloadPacketLive = useCallback(async () => {
    await downloadServerPacket(
      {
        "Content-Type": "application/json",
        "x-matrixmint-mode": "live",
        "x-matrixmint-bust-cache": "1",
      },
      `matrixmint-submission-packet-live-${Date.now()}.json`
    );
  }, [downloadServerPacket]);

  const downloadPacketFast = useCallback(async () => {
    await downloadServerPacket(
      { "Content-Type": "application/json", "x-matrixmint-mode": "cache" },
      `matrixmint-submission-packet-fast-${Date.now()}.json`
    );
  }, [downloadServerPacket]);

  // ---------- Preflight ----------
  const preflight = useCallback(async (): Promise<HealthResult> => {
    const steps: HealthResult["steps"] = [];

    try {
      const s = await fetch("/api/samples");
      const sText = await s.text();
      if (!s.ok) {
        steps.push({ name: "GET /api/samples", ok: false, detail: `HTTP ${s.status}: ${sText.slice(0, 220)}` });
        return {
          ok: false,
          steps,
          hint: "If /api/samples fails, routing/build is broken. Run: npm run build && npm run start.",
        };
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
          detail: `HTTP ${r.status} • ${String(parsed?.error || rText || "failed").slice(0, 220)}`,
        });
        return {
          ok: false,
          steps,
          hint: hint || "If curl works but browser fails, it’s likely origin/proxy mismatch (https localhost) or blocked downloads.",
        };
      }

      const proof = parsed?.runSummary?.proof || "—";
      const cov = parsed?.runSummary?.coveragePercent ?? "—";
      steps.push({ name: "POST /api/run (FAST)", ok: true, detail: `OK • proof=${proof} • coverage=${cov}%` });

      return { ok: true, steps, hint: "Backend OK." };
    } catch (e: any) {
      steps.push({ name: "Preflight", ok: false, detail: String(e?.message ?? e) });
      return { ok: false, steps, hint: "Network/server error. Run prod build: npm run build && npm run start." };
    }
  }, [model]);

  // ---------- Copy helper ----------
  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // ignore
    }
  }, []);

  const curlSnippet = useMemo(() => {
    const baseLocal = "http://127.0.0.1:3000/api/run";
    const body = JSON.stringify({ sampleId: "disaster-relief", model: model || "gemini-3-flash-preview", download: false });

    const fast = `curl -s -X POST ${baseLocal} \\\n  -H "Content-Type: application/json" \\\n  -H "x-matrixmint-mode: cache" \\\n  -d '${body}' \\\n| jq '.ok,.orchestrator.ladderUsed,.orchestrator.modelUsed,.runSummary.proof,.runSummary.coveragePercent'`;

    const live = `curl -s -X POST ${baseLocal} \\\n  -H "Content-Type: application/json" \\\n  -H "x-matrixmint-mode: live" \\\n  -H "x-matrixmint-bust-cache: 1" \\\n  -d '${body}' \\\n| jq '.ok,.orchestrator.ladderUsed,.orchestrator.modelUsed,.runSummary.proof,.runSummary.coveragePercent,.orchestrator.warnings'`;

    return `# Local (recommended)\n${fast}\n\n${live}`;
  }, [model]);

  // ---------- One-click flow ----------
  const runOneClickDemo = useCallback(async () => {
    setFlowError("");
    setShowHealth(false);
    setHealth(null);

    setStage("preflight_running");
    const h = await preflight();
    setHealth(h);

    if (!h.ok) {
      setStage("failed");
      setShowHealth(true);
      setFlowError("Preflight failed. Fix routing/origin first (hint below).");
      scrollToResults();
      return;
    }

    setStage("preflight_ok");

    // FAST
    setStage("fast_running");
    const r1 = await runWithHeaders({ "Content-Type": "application/json", "x-matrixmint-mode": "cache" }, "FAST");
    if (!r1?.ok) {
      setStage("failed");
      setShowHealth(true);
      setFlowError("FAST failed in browser. Preflight says backend OK → likely origin/proxy mismatch.");
      scrollToResults();
      return;
    }
    setStage("fast_ok");

    // LIVE Proof
    setStage("live_running");
    const r2 = await runWithHeaders(
      { "Content-Type": "application/json", "x-matrixmint-mode": "live", "x-matrixmint-bust-cache": "1" },
      "LIVE_PROOF"
    );
    if (!r2?.ok) {
      setStage("failed");
      setShowHealth(true);
      setFlowError("LIVE failed. Not fatal for a walkthrough — show FAST + preflight + curl proof.");
      scrollToResults();
      return;
    }
    setStage("live_ok");

    // Break+Heal (optional)
    if (includeBreakHeal) {
      setStage("break_running");
      const r3 = await runWithHeaders(
        {
          "Content-Type": "application/json",
          "x-matrixmint-mode": "live",
          "x-matrixmint-bust-cache": "1",
          "x-matrixmint-demo-break-proof": "1",
        },
        "BREAK_HEAL"
      );

      if (!r3?.ok) {
        setStage("live_ok");
        setFlowError("Break+Heal failed (optional). LIVE proof still stands.");
      } else {
        setStage("break_ok");
      }
    }

    // Auto-download packet after LIVE
    if (autoDownloadPacketAfterLive) {
      await downloadServerPacket(
        { "Content-Type": "application/json", "x-matrixmint-mode": "live", "x-matrixmint-bust-cache": "1" },
        `matrixmint-submission-packet-live-${Date.now()}.json`
      );
    }

    setStage("done");
    scrollToResults();
  }, [
    autoDownloadPacketAfterLive,
    downloadServerPacket,
    includeBreakHeal,
    preflight,
    runWithHeaders,
    scrollToResults,
  ]);

  const runPreflightOnly = useCallback(async () => {
    setFlowError("");
    setLoading(true);
    try {
      const h = await preflight();
      setHealth(h);
      setShowHealth(true);
      if (!h.ok) setFlowError("Preflight failed. See hint below.");
      else setFlowError("");
    } finally {
      setLoading(false);
    }
  }, [preflight]);

  // Step dots
  const stepStates = useMemo(() => {
    const s = stage;
    const preflight =
      s === "preflight_ok" ||
      s === "fast_running" ||
      s === "fast_ok" ||
      s === "live_running" ||
      s === "live_ok" ||
      s === "break_running" ||
      s === "break_ok" ||
      s === "done"
        ? "done"
        : s === "preflight_running"
        ? "on"
        : s === "failed"
        ? "fail"
        : "off";

    const fast =
      s === "fast_ok" || s === "live_running" || s === "live_ok" || s === "break_running" || s === "break_ok" || s === "done"
        ? "done"
        : s === "fast_running"
        ? "on"
        : s === "failed" && flowError.includes("FAST")
        ? "fail"
        : "off";

    const live =
      s === "live_ok" || s === "break_running" || s === "break_ok" || s === "done"
        ? "done"
        : s === "live_running"
        ? "on"
        : s === "failed" && flowError.includes("LIVE")
        ? "fail"
        : "off";

    const breakHeal =
      !includeBreakHeal
        ? "off"
        : s === "break_ok" || s === "done"
        ? "done"
        : s === "break_running"
        ? "on"
        : s === "failed" && flowError.toLowerCase().includes("break")
        ? "fail"
        : "off";

    return { preflight, fast, live, breakHeal };
  }, [stage, flowError, includeBreakHeal]);

  // Banner
  const topBanner = useMemo(() => {
    if (!resp) return null;
    if (!resp.ok) {
      return { kind: "error" as const, title: "Run failed", body: resp.error || "Unknown error." };
    }
    if (liveConfirmed) {
      return {
        kind: "success" as const,
        title: "Live proof verified",
        body: `Lane: LIVE • Model: ${orch?.modelUsed} • Elapsed: ${fmtMs(orch?.elapsedMs)}`,
      };
    }
    if (orch?.ladderUsed && orch.ladderUsed !== "none") {
      return {
        kind: "info" as const,
        title: "Run complete",
        body: `Lane: ${orch.ladderUsed.toUpperCase()} • Model: ${orch.modelUsed ?? "—"} • Elapsed: ${fmtMs(orch.elapsedMs)}`,
      };
    }
    return null;
  }, [resp, liveConfirmed, orch?.elapsedMs, orch?.ladderUsed, orch?.modelUsed]);

  // proof repair info (optional server meta)
  const proofRepairInfo = useMemo(() => {
    const pr =
      (resp as any)?.meta?.proofRepair ||
      (resp as any)?.orchestrator?.proofRepair ||
      (resp as any)?.data?.meta?.proofRepair ||
      null;
    return pr;
  }, [resp]);

  // Styles
  const page: React.CSSProperties = {
    maxWidth: 1120,
    margin: "0 auto",
    padding: "26px 20px 70px 20px",
  };

  const card: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.12)",
    borderRadius: 18,
    padding: 16,
    background: "rgba(255,255,255,0.75)",
    boxShadow: "0 6px 18px rgba(0,0,0,0.06)",
  };

  const h1: React.CSSProperties = { fontSize: 44, fontWeight: 980, letterSpacing: -0.6, margin: 0 };
  const subtitle: React.CSSProperties = { marginTop: 10, marginBottom: 0, opacity: 0.9, fontSize: 16, lineHeight: 1.45 };

  const primaryBtn: React.CSSProperties = {
    padding: "12px 18px",
    borderRadius: 14,
    border: "1px solid #111",
    background: "#111",
    color: "white",
    fontWeight: 950,
    cursor: "pointer",
    minWidth: 220,
  };

  const secondaryBtn: React.CSSProperties = {
    padding: "12px 18px",
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,0.18)",
    background: "white",
    color: "#111",
    fontWeight: 950,
    cursor: "pointer",
    minWidth: 220,
  };

  const ghostBtn: React.CSSProperties = {
    padding: "12px 18px",
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,0.18)",
    background: "rgba(255,255,255,0.75)",
    color: "#111",
    fontWeight: 950,
    cursor: "pointer",
  };

  const label: React.CSSProperties = { fontSize: 12, fontWeight: 950, opacity: 0.8, marginBottom: 8 };

  const textarea: React.CSSProperties = {
    width: "100%",
    minHeight: 180,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,0.18)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.5,
    resize: "vertical",
    background: "white",
  };

  const busy =
    loading ||
    stage === "preflight_running" ||
    stage === "fast_running" ||
    stage === "live_running" ||
    stage === "break_running";

  return (
    <div style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.04), rgba(0,0,0,0))", minHeight: "100vh" }}>
      <div style={page}>
        <div>
          <h1 style={h1}>MatrixMint — Submission Mode</h1>
          <p style={subtitle}>
            Analyze → evidence-locked matrix → proof verification → bid-ready exports. <span style={{ fontWeight: 950 }}>No invented capabilities.</span>
          </p>
        </div>

        {/* Scoreboard */}
        <div style={{ marginTop: 18, ...card }}>
          <div style={{ fontWeight: 980, fontSize: 18, marginBottom: 8 }}>Run Summary</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 12 }}>Lane • model • coverage • proof • exports • runId</div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span style={badgeStyle(ladder)}>Lane: {ladder.toUpperCase()}</span>
            <span style={pillStyle()}>Model: {orch?.modelUsed ?? modelUsed}</span>
            <span style={pillStyle()}>Coverage: {coverageString}</span>
            <span style={pillStyle()}>Proof: {proofString}</span>
            <span style={pillStyle()}>Exports: {exportEntries.length ? `${exportEntries.length} ready` : "—"}</span>

            <div style={{ flex: 1 }} />

            <button onClick={() => copyText(runId)} style={ghostBtn} title="Copy runId">
              Copy runId
            </button>
            <button onClick={() => copyText(curlSnippet)} style={ghostBtn} title="Copy reproducible curl commands">
              Copy curl
            </button>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.78 }}>
            {liveConfirmed ? "✅ Live proof verified." : resp?.ok ? "Run LIVE Proof to verify fresh Gemini execution." : "Run the one-click flow to generate a proof-locked result."}
          </div>
        </div>

        {/* One-click narrative */}
        <div style={{ marginTop: 14, ...card }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 980, fontSize: 20, marginBottom: 8 }}>One-Click Demo</div>
              <div style={{ fontSize: 14, opacity: 0.85, lineHeight: 1.5 }}>
                Runs: <b>Preflight</b> → <b>FAST</b> → <b>LIVE Proof</b> → optional <b>Break+Heal</b>.
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
                  Download <b>Submission Packet (1 file)</b> for a judge-friendly artifact (contains all exports + run receipt).
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={runOneClickDemo}
                disabled={busy}
                style={{
                  ...primaryBtn,
                  background: busy ? "rgba(0,0,0,0.55)" : "#111",
                  borderColor: "#111",
                  cursor: busy ? "not-allowed" : "pointer",
                }}
                title="Runs the full narrative with preflight first."
              >
                {busy
                  ? stage === "live_running"
                    ? "Running LIVE…"
                    : stage === "fast_running"
                    ? "Running FAST…"
                    : stage === "preflight_running"
                    ? "Preflight…"
                    : "Running…"
                  : "Run One-Click Demo"}
              </button>

              <button onClick={downloadPacketLive} disabled={busy} style={secondaryBtn} title="Downloads ONE packet (live lane).">
                Download Packet (LIVE)
              </button>
            </div>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 900 }}>
              <input type="checkbox" checked={includeBreakHeal} onChange={(e) => setIncludeBreakHeal(Boolean(e.target.checked))} />
              Include Break+Heal
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 900 }}>
              <input
                type="checkbox"
                checked={autoDownloadPacketAfterLive}
                onChange={(e) => setAutoDownloadPacketAfterLive(Boolean(e.target.checked))}
              />
              Auto-download packet after LIVE
            </label>

            <div style={{ flex: 1 }} />

            <button onClick={downloadPacketFast} disabled={busy} style={secondaryBtn} title="Downloads ONE packet (fast lane).">
              Download Packet (FAST)
            </button>
          </div>

          {/* Step dots */}
          <div style={{ marginTop: 14, display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <StepDot state={stepStates.preflight as any} />
              <span style={{ fontWeight: 950, opacity: stepStates.preflight === "off" ? 0.6 : 0.95 }}>Preflight</span>
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <StepDot state={stepStates.fast as any} />
              <span style={{ fontWeight: 950, opacity: stepStates.fast === "off" ? 0.6 : 0.95 }}>FAST</span>
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <StepDot state={stepStates.live as any} />
              <span style={{ fontWeight: 950, opacity: stepStates.live === "off" ? 0.6 : 0.95 }}>LIVE Proof</span>
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <StepDot state={stepStates.breakHeal as any} />
              <span style={{ fontWeight: 950, opacity: includeBreakHeal ? 0.95 : 0.45 }}>Break+Heal</span>
            </div>

            {stage === "failed" && flowError ? <span style={{ fontWeight: 950, color: "#b00020" }}>{flowError}</span> : null}
          </div>

          {/* Preflight panel */}
          {(showHealth || stage === "failed" || stage === "preflight_running") && health ? (
            <div style={{ marginTop: 14, ...bannerStyle(health.ok ? "success" : "warn") }}>
              <div style={{ fontWeight: 980, fontSize: 16, marginBottom: 8 }}>{health.ok ? "Preflight: OK" : "Preflight: Issue detected"}</div>
              <div style={{ display: "grid", gap: 6, fontSize: 13, opacity: 0.92 }}>
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

              <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button onClick={runPreflightOnly} disabled={busy} style={secondaryBtn}>
                  Run Preflight only
                </button>
                <button onClick={() => setShowHealth((v) => !v)} disabled={busy} style={ghostBtn}>
                  {showHealth ? "Hide" : "Show"} Preflight panel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={runPreflightOnly} disabled={busy} style={secondaryBtn}>
                Run Preflight only
              </button>
            </div>
          )}
        </div>

        {/* Results banner anchor */}
        <div ref={resultAnchorRef} style={{ height: 1 }} />

        {/* Result banner */}
        {topBanner ? (
          <div style={{ marginTop: 14, ...bannerStyle(topBanner.kind) }}>
            <div style={{ fontWeight: 980, fontSize: 16, marginBottom: 6 }}>{topBanner.title}</div>
            <div style={{ opacity: 0.92 }}>{topBanner.body}</div>

            {proofRepairInfo?.triggered ? (
              <div style={{ marginTop: 10, fontSize: 13, opacity: 0.92 }}>
                <b>Break+Heal signal:</b>{" "}
                {`fixed=${proofRepairInfo.fixedMismatches ?? "—"} • passes=${proofRepairInfo.attempts ?? "—"} • ${proofRepairInfo.beforeProofPercent ?? "—"}% → ${proofRepairInfo.afterProofPercent ?? "—"}%`}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Run summary + exports */}
        <div style={{ marginTop: 14, ...card }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div style={{ minWidth: 360, flex: 1 }}>
              <div style={{ fontWeight: 980, fontSize: 18, marginBottom: 10 }}>Details</div>

              {resp ? (
                <div style={{ display: "grid", gap: 8, fontSize: 14, opacity: 0.95 }}>
                  <div><b>Status:</b> {resp.ok ? "OK" : "FAIL"}</div>
                  <div><b>Lane:</b> {ladder.toUpperCase()}</div>
                  <div>
                    <b>Model used:</b> {orch?.modelUsed ?? "—"}{" "}
                    {resp.ok && liveConfirmed ? <span style={{ marginLeft: 8, fontWeight: 950 }}>✅ LIVE proof OK</span> : null}
                  </div>
                  <div><b>Elapsed:</b> {fmtMs(orch?.elapsedMs)} <span style={{ opacity: 0.75 }}>(runId: {runId})</span></div>
                  <div><b>Coverage:</b> {coverageString}</div>
                  <div><b>Proof:</b> {proofString}</div>
                  <div><b>Counts:</b> total {sum?.total ?? "—"} / covered {sum?.covered ?? "—"} / partial {sum?.partial ?? "—"} / missing {sum?.missing ?? "—"}</div>
                  {orch?.warnings?.length ? <div><b>Warnings:</b> {orch.warnings.slice(0, 3).join(" | ")}</div> : null}
                </div>
              ) : (
                <div style={{ opacity: 0.7 }}>Run the one-click demo to populate results.</div>
              )}

              {!resp?.ok && resp?.details ? (
                <pre style={{ marginTop: 14, background: "rgba(0,0,0,0.04)", padding: 12, borderRadius: 14, overflowX: "auto" }}>
                  {resp.error || "Run failed."}
                  {"\n\n"}
                  {JSON.stringify(resp.details, null, 2).slice(0, 3600)}
                </pre>
              ) : null}
            </div>

            <div style={{ minWidth: 360, flex: 1 }}>
              <div style={{ fontWeight: 980, fontSize: 18, marginBottom: 10 }}>Submission Artifacts</div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button onClick={downloadPacketLive} disabled={busy} style={primaryBtn} title="Recommended: one packet with exports + metadata">
                  Download Packet (LIVE)
                </button>
                <button onClick={downloadPacketFast} disabled={busy} style={secondaryBtn}>
                  Download Packet (FAST)
                </button>
              </div>

              <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8 }}>
                Packet = one file (judge-friendly). Individual files are available if needed.
              </div>

              {resp?.exports && exportEntries.length ? (
                <div style={{ marginTop: 12 }}>
                  <details>
                    <summary style={{ cursor: "pointer", fontWeight: 950, fontSize: 14 }}>Show individual files</summary>
                    <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                      {exportEntries.map(([k, v]) => (
                        <button
                          key={k}
                          onClick={() => {
                            const ext = k.endsWith("_csv") ? "csv" : k.endsWith("_md") ? "md" : "txt";
                            const mime =
                              ext === "csv"
                                ? "text/csv;charset=utf-8"
                                : ext === "md"
                                ? "text/markdown;charset=utf-8"
                                : "text/plain;charset=utf-8";
                            const blob = new Blob([String(v ?? "")], { type: mime });
                            downloadBlob(`matrixmint-${runId}-${k}.${ext}`, blob);
                          }}
                          style={secondaryBtn}
                        >
                          Download {k}
                        </button>
                      ))}
                    </div>
                  </details>
                </div>
              ) : null}

              {orch?.attempts?.length ? (
                <div style={{ marginTop: 12 }}>
                  <details>
                    <summary style={{ cursor: "pointer", fontWeight: 950, fontSize: 14 }}>Diagnostics (attempts)</summary>
                    <div style={{ marginTop: 10, overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead>
                          <tr>
                            {["name", "ok", "status", "elapsed", "aborted", "modelUsed", "error"].map((h) => (
                              <th key={h} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid rgba(0,0,0,0.10)" }}>
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {orch.attempts.map((a, idx) => (
                            <tr key={idx}>
                              <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.08)", fontWeight: 900 }}>{a.name}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>{a.ok ? "✅" : "—"}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>{a.httpStatus ?? "—"}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>{fmtMs(a.elapsedMs)}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>{a.aborted ? "yes" : "no"}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>{a.modelUsed ?? "—"}</td>
                              <td style={{ padding: 8, borderBottom: "1px solid rgba(0,0,0,0.08)", maxWidth: 340 }}>
                                <span style={{ opacity: 0.85 }}>{a.errorPreview ? String(a.errorPreview).slice(0, 160) : "—"}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </div>
              ) : null}
            </div>
          </div>

          {/* Advanced (closed by default) */}
          <div style={{ marginTop: 18 }}>
            <details open={advancedOpen} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
              <summary style={{ cursor: "pointer", fontWeight: 980, fontSize: 16 }}>Advanced (optional)</summary>

              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <div style={label}>RFP Text</div>
                  <textarea
                    value={rfpText}
                    onChange={(e) => setRfpText(e.target.value)}
                    placeholder="Leave blank to use sample (disaster-relief)."
                    style={textarea}
                  />
                </div>
                <div>
                  <div style={label}>Capability Statement</div>
                  <textarea
                    value={capabilityText}
                    onChange={(e) => setCapabilityText(e.target.value)}
                    placeholder="Leave blank to use sample (disaster-relief)."
                    style={textarea}
                  />
                </div>
              </div>

              <div style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ fontWeight: 950, opacity: 0.85 }}>Model:</div>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  style={{
                    padding: "12px 14px",
                    borderRadius: 14,
                    border: "1px solid rgba(0,0,0,0.18)",
                    minWidth: 320,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontSize: 12,
                    fontWeight: 900,
                    background: "white",
                  }}
                  title="Model string sent to /api/run"
                />

                <div style={{ flex: 1 }} />

                <button onClick={runPreflightOnly} disabled={busy} style={secondaryBtn}>
                  Run Preflight
                </button>

                <button
                  onClick={() => runWithHeaders({ "Content-Type": "application/json", "x-matrixmint-mode": "cache" }, "FAST_MANUAL")}
                  disabled={busy}
                  style={secondaryBtn}
                >
                  Run FAST
                </button>

                <button
                  onClick={() =>
                    runWithHeaders(
                      { "Content-Type": "application/json", "x-matrixmint-mode": "live", "x-matrixmint-bust-cache": "1" },
                      "LIVE_MANUAL"
                    )
                  }
                  disabled={busy}
                  style={secondaryBtn}
                >
                  Run LIVE Proof
                </button>
              </div>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                Advanced is for debugging or custom inputs. For demos: click <b>Run One-Click Demo</b> then <b>Download Packet (LIVE)</b>.
              </div>
            </details>
          </div>
        </div>

        <div style={{ marginTop: 16, fontSize: 12, opacity: 0.7 }}>
          Notes: FAST uses cache for stability. LIVE Proof forces fresh Gemini execution. OFFLINE is a conservative fallback.
        </div>
      </div>
    </div>
  );
}
"use client";

import React, { useCallback, useMemo, useState } from "react";

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

  // Optional payload: if your /api/run ever includes full result data, we can preview safely.
  data?: any;

  error?: string;
  details?: any;
};

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
    fontWeight: 800,
    fontSize: 12,
    border: "1px solid #ddd",
    background: "#f7f7f7",
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
  if (lane === "live") return "LIVE: fresh Gemini execution (judge proof).";
  if (lane === "cache") return "CACHE: replay for stable demos and speed.";
  if (lane === "offline") return "OFFLINE: conservative deterministic fallback for reliability.";
  return "—";
}

export default function DemoClient() {
  // Inputs
  const [rfpText, setRfpText] = useState("");
  const [capabilityText, setCapabilityText] = useState("");

  // Default: fast + stable. Live proof is a separate button.
  const [mode, setMode] = useState<RunMode>("cache");
  const [model, setModel] = useState("gemini-3-flash-preview");

  // State
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<RunResponse | null>(null);

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

    // Only bust cache automatically when user explicitly selects LIVE in dropdown.
    if (mode === "live") h["x-matrixmint-bust-cache"] = "1";

    return h;
  }, [mode]);

  const runWithHeaders = useCallback(
    async (headers: Record<string, string>, label: string) => {
      setLoading(true);
      setResp(null);

      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers,
          body: JSON.stringify(mkBody(false)),
        });

        const text = await res.text();
        let j: any = null;
        try {
          j = text ? JSON.parse(text) : null;
        } catch {
          j = null;
        }

        if (!j || typeof j.ok !== "boolean") {
          setResp({ ok: false, error: `Unexpected response from ${label}.` });
        } else {
          setResp(j as RunResponse);
        }
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
          setResp({ ok: false, error: `Download failed (HTTP ${res.status})`, details: { preview: text.slice(0, 800) } });
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

    // Sequential downloads (simple + reliable; no zip dependency)
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

      // Tiny delay helps browsers not drop downloads when many are triggered quickly
      // (safe + minimal)
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
        body:
          "Fallback can occur due to quota or timeouts. For judges: run FAST first, then retry LIVE Proof for confirmation.",
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

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Recommended Demo (judge flow) */}
      <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, background: "#fafafa" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>Recommended Demo (Judges)</div>
            <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5 }}>
              ① Run <b>FAST</b> for instant stable results → ② Download exports (bid-ready artifacts) → ③ Run <b>LIVE Proof</b> to confirm Gemini execution.
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={smallPillStyle()}>FAST = stability</span>
            <span style={smallPillStyle()}>LIVE = proof</span>
            <span style={smallPillStyle()}>Exports = deliverables</span>
          </div>
        </div>
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

        <span style={{ opacity: 0.75, fontWeight: 800 }}>目標: fast demo + live proof + exports. きっと勝つ。</span>

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
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 700 }}>
              Live may consume quota; use LIVE Proof when needed.
            </span>
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
                <b>Counts:</b> total {sum?.total ?? "—"} / covered {sum?.covered ?? "—"} / partial{" "}
                {sum?.partial ?? "—"} / missing {sum?.missing ?? "—"}
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
            {resp.details ? `\n\nDETAILS:\n${JSON.stringify(resp.details, null, 2).slice(0, 2000)}` : ""}
          </pre>
        ) : null}
      </div>

      <div style={{ opacity: 0.75, fontSize: 12 }}>
        Notes: FAST uses cache for stable demos. LIVE Proof forces a fresh run. OFFLINE is a conservative fallback.
      </div>
    </div>
  );
}
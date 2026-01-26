"use client";

import React, { useMemo, useState } from "react";

type RunMode = "live" | "cache" | "offline";

type RunResponse = {
  ok: boolean;
  orchestrator?: {
    runId?: string;
    modelRequested?: string;
    modelUsed?: string;
    elapsedMs?: number;
    warnings?: string[];
    cache?: { hit?: boolean; key?: string; source?: string; lane?: string; ageSeconds?: number };
  };
  runSummary?: {
    coveragePercent?: number;
    proof?: string;
    total?: number;
    covered?: number;
    partial?: number;
    missing?: number;
  };
  exports?: Record<string, string>;
  error?: string;
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

export default function DemoClient() {
  const [rfpText, setRfpText] = useState("");
  const [capabilityText, setCapabilityText] = useState("");
  const [mode, setMode] = useState<RunMode>("live");
  const [model, setModel] = useState("gemini-3-flash-preview");
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<RunResponse | null>(null);

  const headers = useMemo(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    h["x-matrixmint-mode"] = mode;

    // Judge-style: when live, we often want a fresh run.
    // If you want to conserve quota later, you can remove this line.
    if (mode === "live") h["x-matrixmint-bust-cache"] = "1";

    return h;
  }, [mode]);

  async function run() {
    setLoading(true);
    setResp(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers,
        body: JSON.stringify({
          rfpText: rfpText.trim() || undefined,
          capabilityText: capabilityText.trim() || undefined,
          // If either is missing, fall back to the known sample for speed.
          sampleId: (!rfpText.trim() || !capabilityText.trim()) ? "disaster-relief" : undefined,
          model,
        }),
      });

      const j = (await res.json()) as RunResponse;
      setResp(j);
    } catch (e: any) {
      setResp({ ok: false, error: String(e?.message ?? e) });
    } finally {
      setLoading(false);
    }
  }

  const orch = resp?.orchestrator;
  const sum = resp?.runSummary;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={{ fontWeight: 600 }}>RFP Text</label>
          <textarea
            value={rfpText}
            onChange={(e) => setRfpText(e.target.value)}
            rows={10}
            placeholder="Paste RFP text here (or leave blank to use sample)."
            style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
          />
        </div>
        <div>
          <label style={{ fontWeight: 600 }}>Capability Statement</label>
          <textarea
            value={capabilityText}
            onChange={(e) => setCapabilityText(e.target.value)}
            rows={10}
            placeholder="Paste capability statement here (or leave blank to use sample)."
            style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontWeight: 600 }}>Mode:</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as RunMode)} style={{ padding: 8, borderRadius: 10 }}>
            <option value="live">live</option>
            <option value="cache">cache</option>
            <option value="offline">offline</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontWeight: 600 }}>Model:</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{ padding: 8, borderRadius: 10, border: "1px solid #ddd", minWidth: 240 }}
          />
        </div>

        <button
          onClick={run}
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: 12,
            border: "1px solid #111",
            background: loading ? "#eee" : "#111",
            color: loading ? "#111" : "#fff",
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 700,
          }}
        >
          {loading ? "Running…" : "Run Orchestrator"}
        </button>

        <span style={{ opacity: 0.75 }}>
          目標: One-click run → exports → proof. 勝つ。
        </span>
      </div>

      <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Run Summary</div>
            <div style={{ opacity: 0.9 }}>
              <div><b>Status:</b> {resp ? (resp.ok ? "OK" : "FAIL") : "—"}</div>
              <div><b>Model used:</b> {orch?.modelUsed ?? "—"}</div>
              <div><b>Warnings:</b> {orch?.warnings?.slice(0, 2).join(" | ") || "—"}</div>
              <div><b>Coverage:</b> {sum?.coveragePercent ?? "—"}</div>
              <div><b>Proof:</b> {sum?.proof ?? "—"}</div>
              <div><b>Counts:</b> total {sum?.total ?? "—"} / covered {sum?.covered ?? "—"} / partial {sum?.partial ?? "—"} / missing {sum?.missing ?? "—"}</div>
            </div>
          </div>

          <div style={{ minWidth: 300 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Exports</div>
            {!resp?.exports || Object.keys(resp.exports).length === 0 ? (
              <div style={{ opacity: 0.75 }}>—</div>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {Object.entries(resp.exports).map(([k, v]) => {
                  const ext = k.endsWith("_csv") ? "csv" : k.endsWith("_md") ? "md" : "txt";
                  const mime =
                    ext === "csv" ? "text/csv;charset=utf-8" : ext === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
                  const fname = `matrixmint-${k}.${ext}`;
                  return (
                    <button
                      key={k}
                      onClick={() => downloadText(fname, String(v ?? ""), mime)}
                      style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
                    >
                      Download {k}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {!resp?.ok && resp?.error ? (
          <pre style={{ marginTop: 12, background: "#f7f7f7", padding: 10, borderRadius: 10, overflowX: "auto" }}>
            {resp.error}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
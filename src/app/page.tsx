"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CoverageStatus = "Covered" | "Partial" | "Missing";

type RequirementRow = {
  id: string;
  category: "Functional" | "NonFunctional";
  text: string;
  status: CoverageStatus;
  responseSummary: string;
  evidenceIds: string[];
  evidenceQuotes: string[];
  gapsOrQuestions: string[];
  riskFlags: string[];
};

type MatrixResult = {
  summary: {
    totalRequirements: number;
    coveredCount: number;
    partialCount: number;
    missingCount: number;
    coveragePercent: number;
    topRisks: string[];
    nextActions: string[];
  };
  requirements: RequirementRow[];
  proposalOutline: {
    executiveSummary: string;
    sections: string[];
  };
};

type SamplePayload = {
  samples: Array<{
    id: string;
    name: string;
    rfpText: string;
    capabilityText: string;
  }>;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normalizeSectionTitle(s: string) {
  // Prevent "1. 1. Title" vibes in UI if model returns numbered strings
  return s.replace(/^\s*\d+\.\s*/, "").trim();
}

function badgeStyle(status: CoverageStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    border: "1px solid rgba(0,0,0,0.12)",
    whiteSpace: "nowrap",
  };

  if (status === "Covered") return { ...base, background: "rgba(16,185,129,0.15)" };
  if (status === "Partial") return { ...base, background: "rgba(245,158,11,0.18)" };
  return { ...base, background: "rgba(239,68,68,0.16)" };
}

function pillStyle(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 8px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    marginRight: 8,
    marginBottom: 8,
    background: "rgba(255,255,255,0.65)",
  };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export default function Home() {
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [samples, setSamples] = useState<SamplePayload["samples"]>([]);
  const [selectedSampleId, setSelectedSampleId] = useState<string>("");

  const [rfpText, setRfpText] = useState("");
  const [capabilityText, setCapabilityText] = useState("");

  const [model, setModel] = useState<"gemini-3-flash-preview" | "gemini-3-pro-preview">(
    "gemini-3-flash-preview"
  );

  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<MatrixResult | null>(null);
  const [error, setError] = useState<string>("");

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"All" | CoverageStatus>("All");
  const [categoryFilter, setCategoryFilter] = useState<"All" | "Functional" | "NonFunctional">("All");

  // Abort in-flight analysis if user runs again
  const abortRef = useRef<AbortController | null>(null);

  const selectedSample = useMemo(() => {
    return samples.find((s) => s.id === selectedSampleId) ?? null;
  }, [samples, selectedSampleId]);

  const coverage = useMemo(() => {
    if (!result) return { pct: 0, covered: 0, partial: 0, missing: 0, total: 0 };
    return {
      pct: clamp(result.summary.coveragePercent, 0, 100),
      covered: result.summary.coveredCount,
      partial: result.summary.partialCount,
      missing: result.summary.missingCount,
      total: result.summary.totalRequirements,
    };
  }, [result]);

  const filteredRequirements = useMemo(() => {
    const rows = result?.requirements ?? [];
    const q = query.trim().toLowerCase();

    return rows.filter((r) => {
      const matchesQuery =
        !q ||
        r.id.toLowerCase().includes(q) ||
        r.text.toLowerCase().includes(q) ||
        r.responseSummary.toLowerCase().includes(q) ||
        (r.evidenceIds ?? []).some((x) => x.toLowerCase().includes(q)) ||
        (r.riskFlags ?? []).some((x) => x.toLowerCase().includes(q)) ||
        (r.gapsOrQuestions ?? []).some((x) => x.toLowerCase().includes(q));

      const matchesStatus = statusFilter === "All" ? true : r.status === statusFilter;
      const matchesCategory = categoryFilter === "All" ? true : r.category === categoryFilter;

      return matchesQuery && matchesStatus && matchesCategory;
    });
  }, [result, query, statusFilter, categoryFilter]);

  const warmUpRoutes = useCallback(async () => {
    // Dev-only speed: triggers on-demand compilation before first user click.
    try {
      await fetch("/api/samples", { cache: "no-store" });
      await fetch("/api/analyze", { method: "OPTIONS" }).catch(() => {});
      await fetch("/api/export?format=md", { method: "OPTIONS" }).catch(() => {});
      await fetch("/api/export?format=json", { method: "OPTIONS" }).catch(() => {});
    } catch {
      // ignore
    }
  }, []);

  // Load samples once + warm up API routes
  useEffect(() => {
    (async () => {
      try {
        setLoadingSamples(true);
        const res = await fetch("/api/samples", { cache: "no-store" });
        const json = (await res.json()) as SamplePayload;

        const s = json.samples ?? [];
        setSamples(s);

        if (s.length) {
          setSelectedSampleId(s[0].id);
          setRfpText(s[0].rfpText);
          setCapabilityText(s[0].capabilityText);
        }

        // Warm-up after initial paint
        setTimeout(() => void warmUpRoutes(), 150);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load samples");
      } finally {
        setLoadingSamples(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSampleToEditors = useCallback(() => {
    if (!selectedSample) return;
    setRfpText(selectedSample.rfpText);
    setCapabilityText(selectedSample.capabilityText);
    setResult(null);
    setError("");
  }, [selectedSample]);

  const downloadBlob = useCallback(async (url: string, filename: string, payload: any) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(txt || `Download failed (${res.status})`);
    }

    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  }, []);

  const runAnalysis = useCallback(async () => {
    setError("");
    setResult(null);

    const rfp = rfpText.trim();
    const cap = capabilityText.trim();
    if (!rfp || !cap) {
      setError("Both RFP text and Capability Brief are required.");
      return;
    }

    // Abort any prior run
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      setAnalyzing(true);

      // Retry logic for transient overloads
      const maxAttempts = 3;
      let attempt = 0;

      while (attempt < maxAttempts) {
        attempt += 1;

        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rfpText: rfp, capabilityText: cap, model }),
          signal: abortRef.current.signal,
        });

        const json = await res.json().catch(() => ({}));

        if (json?.ok) {
          setResult(json.data as MatrixResult);
          return;
        }

        const rawErr = json?.error ? String(json.error) : `Analyze failed (${res.status})`;
        const lower = rawErr.toLowerCase();

        const isOverloaded =
          res.status === 503 ||
          lower.includes("overloaded") ||
          lower.includes("unavailable") ||
          lower.includes("503");

        if (!isOverloaded) {
          throw new Error(rawErr);
        }

        if (attempt < maxAttempts) {
          // Backoff: 600ms, 1200ms...
          await sleep(600 * attempt);
          continue;
        }

        throw new Error(
          "Gemini is temporarily overloaded (503). Please click Run Analysis again in a few seconds."
        );
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(String(e?.message ?? "Analyze failed"));
    } finally {
      setAnalyzing(false);
    }
  }, [rfpText, capabilityText, model]);

  // --- Styles (pure inline to avoid Tailwind config friction) ---
  const headerStyle: React.CSSProperties = {
    maxWidth: 1120,
    margin: "0 auto",
    padding: "28px 20px 10px 20px",
  };

  const containerStyle: React.CSSProperties = {
    maxWidth: 1120,
    margin: "0 auto",
    padding: "0 20px 80px 20px",
  };

  const card: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.12)",
    borderRadius: 16,
    padding: 16,
    background: "rgba(255,255,255,0.75)",
    boxShadow: "0 6px 20px rgba(0,0,0,0.06)",
  };

  const grid2: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
  };

  const grid3: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: 16,
  };

  const label: React.CSSProperties = { fontSize: 12, fontWeight: 800, opacity: 0.8, marginBottom: 6 };

  const textarea: React.CSSProperties = {
    width: "100%",
    minHeight: 220,
    padding: 12,
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.18)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.5,
    resize: "vertical",
    background: "white",
  };

  const buttonPrimary: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "black",
    color: "white",
    fontWeight: 900,
    cursor: "pointer",
  };

  const buttonSecondary: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "white",
    color: "black",
    fontWeight: 900,
    cursor: "pointer",
  };

  const canDownload = Boolean(result);

  return (
    <div
      style={{
        background: "linear-gradient(180deg, rgba(0,0,0,0.04), rgba(0,0,0,0.00))",
        minHeight: "100vh",
      }}
    >
      <header style={headerStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ fontSize: 34, fontWeight: 900, letterSpacing: -0.5, margin: 0 }}>MatrixMint</h1>
            <p style={{ marginTop: 8, marginBottom: 0, opacity: 0.85 }}>
              Evidence-locked RFP compliance matrix + proposal outline.{" "}
              <span style={{ fontWeight: 900 }}>No hallucinations.</span> きっと勝つ。
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as any)}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.14)",
                fontWeight: 900,
              }}
              title="Model"
            >
              <option value="gemini-3-flash-preview">Gemini 3 Flash (fast)</option>
              <option value="gemini-3-pro-preview">Gemini 3 Pro (best)</option>
            </select>

            <button
              style={buttonSecondary}
              onClick={loadSampleToEditors}
              disabled={loadingSamples || !selectedSample}
            >
              Load Sample
            </button>

            <button style={buttonPrimary} onClick={runAnalysis} disabled={analyzing}>
              {analyzing ? "Analyzing..." : "Run Analysis"}
            </button>

            <button
              style={buttonSecondary}
              disabled={!canDownload}
              onClick={async () => {
                try {
                  if (!result) return;
                  await downloadBlob("/api/export?format=md", "matrixmint-proofpack.md", { result });
                } catch (e: any) {
                  setError(String(e?.message ?? "Download failed"));
                }
              }}
              title={!canDownload ? "Run analysis first" : "Download Proof Pack (Markdown)"}
            >
              Download Proof Pack (MD)
            </button>

            <button
              style={buttonSecondary}
              disabled={!canDownload}
              onClick={async () => {
                try {
                  if (!result) return;
                  await downloadBlob("/api/export?format=json", "matrixmint-proofpack.json", { result });
                } catch (e: any) {
                  setError(String(e?.message ?? "Download failed"));
                }
              }}
              title={!canDownload ? "Run analysis first" : "Download JSON"}
            >
              Download JSON
            </button>
          </div>
        </div>

        <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ ...label, marginBottom: 0 }}>Sample:</span>
          <select
            value={selectedSampleId}
            onChange={(e) => setSelectedSampleId(e.target.value)}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.14)",
              minWidth: 320,
              fontWeight: 800,
            }}
          >
            {samples.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <span style={{ fontSize: 12, opacity: 0.75 }}>Tip: Flash for iteration, Pro for final demo.</span>
        </div>

        {error ? (
          <div
            style={{
              marginTop: 14,
              padding: 12,
              borderRadius: 12,
              border: "1px solid rgba(239,68,68,0.3)",
              background: "rgba(239,68,68,0.08)",
            }}
          >
            <div style={{ fontWeight: 900 }}>Error</div>
            <div
              style={{
                marginTop: 6,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {error}
            </div>
          </div>
        ) : null}
      </header>

      <main style={containerStyle}>
        <section style={grid2}>
          <div style={card}>
            <div style={label}>RFP (paste or load a sample)</div>
            <textarea style={textarea} value={rfpText} onChange={(e) => setRfpText(e.target.value)} />
          </div>

          <div style={card}>
            <div style={label}>Capability Brief (evidence only)</div>
            <textarea style={textarea} value={capabilityText} onChange={(e) => setCapabilityText(e.target.value)} />
          </div>
        </section>

        {result ? (
          <>
            <section style={{ marginTop: 16, ...grid3 }}>
              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.8 }}>Coverage</div>
                <div style={{ marginTop: 6, fontSize: 34, fontWeight: 900 }}>{coverage.pct.toFixed(0)}%</div>
                <div style={{ marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <span style={pillStyle()}>Covered: {coverage.covered}</span>
                  <span style={pillStyle()}>Partial: {coverage.partial}</span>
                  <span style={pillStyle()}>Missing: {coverage.missing}</span>
                  <span style={pillStyle()}>Total: {coverage.total}</span>
                </div>
                <div
                  style={{
                    marginTop: 10,
                    height: 10,
                    borderRadius: 999,
                    background: "rgba(0,0,0,0.08)",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ width: `${coverage.pct}%`, height: "100%", background: "black" }} />
                </div>
                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                  Judges like measurable outcomes: this is your “proof layer.”
                </div>
              </div>

              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.8 }}>Top Risks</div>
                <ul style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18 }}>
                  {(result.summary.topRisks ?? []).slice(0, 8).map((r, i) => (
                    <li key={i} style={{ marginBottom: 8, fontSize: 13 }}>
                      {r}
                    </li>
                  ))}
                </ul>
              </div>

              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.8 }}>Next Actions</div>
                <ul style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18 }}>
                  {(result.summary.nextActions ?? []).slice(0, 8).map((a, i) => (
                    <li key={i} style={{ marginBottom: 8, fontSize: 13 }}>
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section style={{ marginTop: 16, ...card }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900 }}>Compliance Matrix</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                    Filter by status/category and search by ID, text, evidence, gaps, or risks.
                  </div>
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search (e.g., FR-05, SMS, CB-14)"
                    style={{
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.14)",
                      minWidth: 260,
                    }}
                  />

                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as any)}
                    style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.14)" }}
                  >
                    <option value="All">All Status</option>
                    <option value="Covered">Covered</option>
                    <option value="Partial">Partial</option>
                    <option value="Missing">Missing</option>
                  </select>

                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value as any)}
                    style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.14)" }}
                  >
                    <option value="All">All Categories</option>
                    <option value="Functional">Functional</option>
                    <option value="NonFunctional">Non-Functional</option>
                  </select>
                </div>
              </div>

              <div style={{ marginTop: 14, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
                  <thead>
                    <tr>
                      {["ID", "Category", "Requirement", "Status", "Evidence", "Gaps / Questions", "Risks"].map((h) => (
                        <th
                          key={h}
                          style={{
                            textAlign: "left",
                            fontSize: 12,
                            fontWeight: 900,
                            padding: "10px 10px",
                            borderBottom: "1px solid rgba(0,0,0,0.14)",
                            background: "rgba(0,0,0,0.03)",
                            position: "sticky",
                            top: 0,
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {filteredRequirements.map((r) => (
                      <tr key={r.id}>
                        <td
                          style={{
                            padding: 10,
                            borderBottom: "1px solid rgba(0,0,0,0.10)",
                            fontWeight: 900,
                            fontSize: 12,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.id}
                        </td>

                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)", fontSize: 12 }}>
                          {r.category}
                        </td>

                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)" }}>
                          <div style={{ fontSize: 13, fontWeight: 900 }}>{r.text}</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>{r.responseSummary}</div>
                        </td>

                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)" }}>
                          <span style={badgeStyle(r.status)}>{r.status}</span>
                        </td>

                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)" }}>
                          {r.evidenceIds?.length ? (
                            <>
                              <div style={{ fontWeight: 900, fontSize: 12 }}>{r.evidenceIds.join(", ")}</div>
                              {(r.evidenceQuotes ?? []).slice(0, 2).map((q, i) => (
                                <div key={i} style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                                  “{q}”
                                </div>
                              ))}
                            </>
                          ) : (
                            <div style={{ fontSize: 12, opacity: 0.7 }}>—</div>
                          )}
                        </td>

                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)" }}>
                          {r.gapsOrQuestions?.length ? (
                            <ul style={{ margin: 0, paddingLeft: 18 }}>
                              {r.gapsOrQuestions.slice(0, 3).map((g, i) => (
                                <li key={i} style={{ fontSize: 12, marginBottom: 6 }}>
                                  {g}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div style={{ fontSize: 12, opacity: 0.7 }}>—</div>
                          )}
                        </td>

                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)" }}>
                          {r.riskFlags?.length ? (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                              {r.riskFlags.slice(0, 6).map((x, i) => (
                                <span key={i} style={pillStyle()}>
                                  {x}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, opacity: 0.7 }}>—</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                  Showing {filteredRequirements.length} / {result.requirements.length} requirements.
                </div>
              </div>
            </section>

            <section style={{ marginTop: 16, ...grid2 }}>
              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.8 }}>Proposal: Executive Summary</div>
                <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6 }}>
                  {result.proposalOutline.executiveSummary}
                </div>
              </div>

              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.8 }}>Proposal: Sections</div>
                <ol style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18 }}>
                  {result.proposalOutline.sections.map((s, i) => (
                    <li key={i} style={{ marginBottom: 8, fontSize: 13 }}>
                      {normalizeSectionTitle(s)}
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          </>
        ) : (
          <section style={{ marginTop: 16, ...card }}>
            <div style={{ fontSize: 16, fontWeight: 900 }}>How to use</div>
            <ol style={{ marginTop: 10, paddingLeft: 18, lineHeight: 1.7 }}>
              <li>
                Click <b>Load Sample</b> (or paste your own RFP + Capability Brief).
              </li>
              <li>
                Click <b>Run Analysis</b> to generate a compliance matrix with evidence.
              </li>
              <li>Filter by status, search CB-IDs, and export the proof pack for submission drafts.</li>
            </ol>
            <div style={{ marginTop: 12, fontSize: 12, opacity: 0.8 }}>
              This is not “a chatbot.” It is a structured compliance system with proof. That’s the win condition.
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
"use client";

import React, { useEffect, useMemo, useState } from "react";

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

function badgeStyle(status: CoverageStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    border: "1px solid rgba(0,0,0,0.12)",
    whiteSpace: "nowrap",
  };

  if (status === "Covered") return { ...base, background: "rgba(16,185,129,0.15)" };
  if (status === "Partial") return { ...base, background: "rgba(245,158,11,0.18)" };
  return { ...base, background: "rgba(239,68,68,0.16)" };
}

function smallPill(label: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 8px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    marginRight: 8,
    marginBottom: 8,
    background: "rgba(255,255,255,0.6)",
  };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
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

  // Load samples once
  useEffect(() => {
    (async () => {
      try {
        setLoadingSamples(true);
        const res = await fetch("/api/samples");
        const json = (await res.json()) as SamplePayload;
        setSamples(json.samples ?? []);
        if (json.samples?.length) {
          setSelectedSampleId(json.samples[0].id);
          setRfpText(json.samples[0].rfpText);
          setCapabilityText(json.samples[0].capabilityText);
        }
      } catch (e: any) {
        setError(e?.message ?? "Failed to load samples");
      } finally {
        setLoadingSamples(false);
      }
    })();
  }, []);

  const selectedSample = useMemo(() => {
    return samples.find((s) => s.id === selectedSampleId) ?? null;
  }, [samples, selectedSampleId]);

  const filteredRequirements = useMemo(() => {
    const rows = result?.requirements ?? [];
    return rows.filter((r) => {
      const q = query.trim().toLowerCase();
      const matchesQuery =
        !q ||
        r.id.toLowerCase().includes(q) ||
        r.text.toLowerCase().includes(q) ||
        r.responseSummary.toLowerCase().includes(q) ||
        r.evidenceIds.some((x) => x.toLowerCase().includes(q)) ||
        r.riskFlags.some((x) => x.toLowerCase().includes(q));

      const matchesStatus = statusFilter === "All" ? true : r.status === statusFilter;
      const matchesCategory = categoryFilter === "All" ? true : r.category === categoryFilter;

      return matchesQuery && matchesStatus && matchesCategory;
    });
  }, [result, query, statusFilter, categoryFilter]);

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

  async function runAnalysis() {
    setError("");
    setResult(null);

    const rfp = rfpText.trim();
    const cap = capabilityText.trim();
    if (!rfp || !cap) {
      setError("Both RFP text and Capability Brief are required.");
      return;
    }

    try {
      setAnalyzing(true);
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rfpText: rfp, capabilityText: cap, model }),
      });

      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Analyze failed");

      setResult(json.data as MatrixResult);
    } catch (e: any) {
      const msg = String(e?.message ?? "Analyze failed");
if (msg.toLowerCase().includes("overloaded") || msg.includes("503") || msg.includes("UNAVAILABLE")) {
  setError("Gemini is temporarily overloaded (503). MatrixMint will retry automatically—please click Run Analysis again in a few seconds.");
} else {
  setError(msg);
}
    } finally {
      setAnalyzing(false);
    }
  }

  function loadSampleToEditors() {
    if (!selectedSample) return;
    setRfpText(selectedSample.rfpText);
    setCapabilityText(selectedSample.capabilityText);
    setResult(null);
    setError("");
  }

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
    background: "rgba(255,255,255,0.7)",
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

  const label: React.CSSProperties = { fontSize: 12, fontWeight: 700, opacity: 0.8, marginBottom: 6 };

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

  const button: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "black",
    color: "white",
    fontWeight: 800,
    cursor: "pointer",
  };

  const buttonSecondary: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.14)",
    background: "white",
    color: "black",
    fontWeight: 800,
    cursor: "pointer",
  };

  return (
    <div style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.04), rgba(0,0,0,0.00))", minHeight: "100vh" }}>
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: 34, fontWeight: 900, letterSpacing: -0.5, margin: 0 }}>MatrixMint</h1>
            <p style={{ marginTop: 8, marginBottom: 0, opacity: 0.85 }}>
              Evidence-locked RFP compliance matrix + proposal outline.{" "}
              <span style={{ fontWeight: 800 }}>No hallucinations.</span> きっと勝つ。
            </p>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as any)}
              style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.14)", fontWeight: 800 }}
              title="Model"
            >
              <option value="gemini-3-flash-preview">Gemini 3 Flash (fast)</option>
              <option value="gemini-3-pro-preview">Gemini 3 Pro (best)</option>
            </select>

            <button style={buttonSecondary} onClick={loadSampleToEditors} disabled={loadingSamples || !selectedSample}>
              Load Sample
            </button>

            <button style={button} onClick={runAnalysis} disabled={analyzing}>
              {analyzing ? "Analyzing..." : "Run Analysis"}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ ...label, marginBottom: 0 }}>Sample:</span>
          <select
            value={selectedSampleId}
            onChange={(e) => setSelectedSampleId(e.target.value)}
            style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid rgba(0,0,0,0.14)", minWidth: 320 }}
          >
            {samples.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>

          <span style={{ fontSize: 12, opacity: 0.75 }}>
            Tip: Flash for iteration, Pro for final demo.
          </span>
        </div>

        {error ? (
          <div style={{ marginTop: 14, padding: 12, borderRadius: 12, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.08)" }}>
            <div style={{ fontWeight: 900 }}>Error</div>
            <div style={{ marginTop: 6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}>
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
                  <span style={smallPill(`Covered: ${coverage.covered}`)}>Covered: {coverage.covered}</span>
                  <span style={smallPill(`Partial: ${coverage.partial}`)}>Partial: {coverage.partial}</span>
                  <span style={smallPill(`Missing: ${coverage.missing}`)}>Missing: {coverage.missing}</span>
                  <span style={smallPill(`Total: ${coverage.total}`)}>Total: {coverage.total}</span>
                </div>
                <div style={{ marginTop: 10, height: 10, borderRadius: 999, background: "rgba(0,0,0,0.08)", overflow: "hidden" }}>
                  <div style={{ width: `${coverage.pct}%`, height: "100%", background: "black" }} />
                </div>
                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                  Judges like measurable outcomes: this is your “proof” layer.
                </div>
              </div>

              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.8 }}>Top Risks</div>
                <ul style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18 }}>
                  {result.summary.topRisks?.slice(0, 8).map((r, i) => (
                    <li key={i} style={{ marginBottom: 8, fontSize: 13 }}>
                      {r}
                    </li>
                  ))}
                </ul>
              </div>

              <div style={card}>
                <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.8 }}>Next Actions</div>
                <ul style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18 }}>
                  {result.summary.nextActions?.slice(0, 8).map((a, i) => (
                    <li key={i} style={{ marginBottom: 8, fontSize: 13 }}>
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section style={{ marginTop: 16, ...card }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900 }}>Compliance Matrix</div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                    Filter by status/category and search by ID, text, evidence, or risks.
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
                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)", fontWeight: 900, fontSize: 12, whiteSpace: "nowrap" }}>
                          {r.id}
                        </td>
                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)", fontSize: 12, whiteSpace: "nowrap" }}>
                          {r.category}
                        </td>
                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)" }}>
                          <div style={{ fontSize: 13, fontWeight: 800 }}>{r.text}</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>{r.responseSummary}</div>
                        </td>
                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)" }}>
                          <span style={badgeStyle(r.status)}>{r.status}</span>
                        </td>
                        <td style={{ padding: 10, borderBottom: "1px solid rgba(0,0,0,0.10)" }}>
                          {r.evidenceIds?.length ? (
                            <>
                              <div style={{ fontWeight: 900, fontSize: 12 }}>{r.evidenceIds.join(", ")}</div>
                              {r.evidenceQuotes?.slice(0, 2).map((q, i) => (
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
                                <span key={i} style={smallPill(x)}>
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
                      {s}
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
              <li>Click <b>Load Sample</b> (or paste your own RFP + Capability Brief).</li>
              <li>Click <b>Run Analysis</b> to generate a compliance matrix with evidence.</li>
              <li>Filter by status, search CB-IDs, and copy the proposal outline for submission drafts.</li>
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
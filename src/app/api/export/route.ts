import { NextRequest, NextResponse } from "next/server";

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

    proofPercent?: number;
    proofVerifiedCount?: number;
    proofTotalEvidenceRefs?: number;
    proofNotes?: string[];
  };
  requirements: RequirementRow[];
  proposalOutline?: {
    executiveSummary?: string;
    sections?: string[];
  };
};

type AnalyzeMeta = {
  modelRequested?: string;
  modelUsed?: string;
  fallbackUsed?: string;
  warnings?: string[];
  cache?: any;
  quota?: any;
};

type ExportFormat =
  | "proofpack_md"
  | "bidpacket_md"
  | "clarifications_email_md"
  | "risks_csv"
  | "proposal_draft_md"
  | "json"
  | "bundle_json";

function safeArray<T>(x: any): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

function safeString(x: any, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}

function safeNumber(x: any, fallback = 0): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function uniqStrings(arr: any[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr ?? []) {
    const v = String(x ?? "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function nowISODate() {
  return new Date().toISOString().slice(0, 10);
}

function mdEscapeCell(s: string) {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r/g, "")
    .replace(/\n/g, "<br/>");
}

function computeStats(result: MatrixResult) {
  const reqs = safeArray<RequirementRow>(result.requirements);
  const total = reqs.length || safeNumber((result.summary as any)?.totalRequirements, 0);

  let covered = 0,
    partial = 0,
    missing = 0;

  for (const r of reqs) {
    if (r.status === "Covered") covered++;
    else if (r.status === "Partial") partial++;
    else if (r.status === "Missing") missing++;
  }

  const coveragePct =
    total > 0 ? (covered / total) * 100 : safeNumber((result.summary as any)?.coveragePercent, 0);

  const proofPercent =
    typeof (result.summary as any)?.proofPercent === "number" ? (result.summary as any).proofPercent : undefined;
  const proofVerifiedCount =
    typeof (result.summary as any)?.proofVerifiedCount === "number"
      ? (result.summary as any).proofVerifiedCount
      : undefined;
  const proofTotalEvidenceRefs =
    typeof (result.summary as any)?.proofTotalEvidenceRefs === "number"
      ? (result.summary as any).proofTotalEvidenceRefs
      : undefined;

  const proofLabel =
    typeof proofPercent === "number" &&
    typeof proofVerifiedCount === "number" &&
    typeof proofTotalEvidenceRefs === "number"
      ? `${Math.round(proofPercent)}% (${proofVerifiedCount}/${proofTotalEvidenceRefs})`
      : null;

  return { total, covered, partial, missing, coveragePct, proofLabel };
}

function mdHeading(title: string) {
  return `## ${title}\n`;
}

function mdList(items: string[]) {
  if (!items.length) return "- —\n";
  return items.map((x) => `- ${x}`).join("\n") + "\n";
}

function escapeCsvCell(s: string) {
  const v = s ?? "";
  const needs = v.includes(",") || v.includes('"') || v.includes("\n") || v.includes("\r");
  if (!needs) return v;
  return `"${v.replace(/"/g, '""')}"`;
}

function formatProofPack(result: MatrixResult) {
  const d = nowISODate();
  const stats = computeStats(result);
  const topRisks = safeArray<string>((result.summary as any)?.topRisks).slice(0, 10);
  const nextActions = safeArray<string>((result.summary as any)?.nextActions).slice(0, 10);
  const reqs = safeArray<RequirementRow>((result as any).requirements);

  let out = "";
  out += `# MatrixMint — Compliance Proof Pack\n\n`;
  out += `## Summary\n`;
  out += `- **Date:** ${d}\n`;
  out += `- **Coverage:** ${stats.coveragePct.toFixed(0)}%\n`;
  out += `- **Total:** ${stats.total}\n`;
  out += `- **Covered:** ${stats.covered}\n`;
  out += `- **Partial:** ${stats.partial}\n`;
  out += `- **Missing:** ${stats.missing}\n`;
  out += stats.proofLabel ? `- **Proof:** ${stats.proofLabel}\n` : `- **Proof:** —\n`;

  const proofNotes = safeArray<string>((result.summary as any)?.proofNotes);
  if (proofNotes.length) {
    out += `- **Proof Notes:**\n`;
    out += proofNotes.map((x) => `  - ${x}`).join("\n") + "\n";
  }

  out += `\n`;
  out += mdHeading("Top Risks");
  out += mdList(topRisks);
  out += `\n`;
  out += mdHeading("Next Actions");
  out += mdList(nextActions);
  out += `\n`;

  out += mdHeading("Compliance Matrix");
  out += `| ID | Category | Status | Requirement | Response Summary | Evidence IDs | Gaps / Questions | Risk Flags |\n`;
  out += `|---|---|---|---|---|---|---|---|\n`;

  for (const r of reqs) {
    const evidenceIds = safeArray<string>((r as any).evidenceIds).join(", ") || "—";
    const gaps = safeArray<string>((r as any).gapsOrQuestions);
    const risks = safeArray<string>((r as any).riskFlags);

    out += `| ${mdEscapeCell(safeString(r.id))} | ${mdEscapeCell(safeString(r.category))} | ${mdEscapeCell(
      safeString(r.status)
    )} | ${mdEscapeCell(safeString(r.text))} | ${mdEscapeCell(safeString(r.responseSummary))} | ${mdEscapeCell(
      evidenceIds
    )} | ${mdEscapeCell(gaps.length ? gaps.join("\n") : "—")} | ${mdEscapeCell(
      risks.length ? risks.join("\n") : "—"
    )} |\n`;
  }

  out += `\n`;
  return out;
}

function formatBidPacket(result: MatrixResult) {
  const d = nowISODate();
  const stats = computeStats(result);
  const reqs = safeArray<RequirementRow>((result as any).requirements);

  const nonCovered = reqs.filter((r) => r.status !== "Covered");

  const clarifications: Array<{ id: string; q: string }> = [];
  for (const r of reqs) {
    for (const q of safeArray<string>((r as any).gapsOrQuestions)) {
      clarifications.push({ id: r.id, q });
    }
  }

  const riskRows = reqs
    .filter((r) => safeArray<string>((r as any).riskFlags).length > 0)
    .map((r) => ({ id: r.id, flags: safeArray<string>((r as any).riskFlags) }));

  const execSummary =
    safeString((result as any).proposalOutline?.executiveSummary) ||
    "MatrixMint provides a proof-locked compliance analysis that maps each requirement to verifiable capability evidence, producing bid-ready artifacts and reducing procurement risk.";

  let out = "";
  out += `# MatrixMint — Bid-Ready Packet (MD)\n`;
  out += `_Date: ${d}_\n\n`;

  out += `## 1) Executive Snapshot\n`;
  out += `**Coverage:** ${stats.coveragePct.toFixed(0)}% — Covered ${stats.covered} / Partial ${stats.partial} / Missing ${stats.missing} (Total ${stats.total})  \n`;
  out += `**Proof:** ${stats.proofLabel ?? "—"}\n\n`;

  out += `## 2) Proposal Executive Summary (Draft)\n`;
  out += `${execSummary}\n\n`;

  out += `## 3) Compliance Highlights (Non-Covered / Risk Areas)\n`;
  if (!nonCovered.length) out += `- —\n\n`;
  else {
    for (const r of nonCovered) out += `- **${r.id}** (${r.status}): ${r.text}\n`;
    out += `\n`;
  }

  out += `## 4) Clarifications & Questions Log\n`;
  if (!clarifications.length) out += `- —\n\n`;
  else {
    for (const item of clarifications) out += `- **${item.id}** — ${item.q}\n`;
    out += `\n`;
  }

  out += `## 5) Risk Register\n`;
  if (!riskRows.length) out += `- —\n\n`;
  else {
    for (const rr of riskRows) {
      const flags = rr.flags;
      const sev =
        flags.includes("Evidence mismatch")
          ? "High"
          : flags.includes("Third-party dependency")
          ? "Medium"
          : flags.includes("Ambiguity")
          ? "Medium"
          : flags.includes("Weak evidence")
          ? "Low"
          : "Low";
      out += `- **${sev}** — ${flags.join(", ")} _(Req: ${rr.id})_\n`;
    }
    out += `\n`;
  }

  out += `## 6) 30 / 60 / 90 Day Plan (Derived from Next Actions)\n`;
  const actions = safeArray<string>((result.summary as any)?.nextActions);
  if (!actions.length) out += `- —\n\n`;
  else {
    const a0 = actions.slice(0, 2);
    const a1 = actions.slice(2, 4);
    const a2 = actions.slice(4);

    out += `### Days 0–30\n${mdList(a0)}\n`;
    out += `### Days 31–60\n${mdList(a1)}\n`;
    out += `### Days 61–90\n${mdList(a2)}\n`;
  }

  out += `## 7) RFP Response Section Skeleton\n`;
  const sections = safeArray<string>((result as any).proposalOutline?.sections);
  if (!sections.length) {
    out += mdList([
      "Solution Overview",
      "Compliance Matrix & Technical Specifications",
      "Implementation Roadmap (30/60/90)",
      "Pricing & Licensing",
      "Risk Management & Mitigations",
      "Support, Training, and Adoption",
    ]);
  } else {
    out += sections.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n";
  }
  out += `\n`;

  out += `## 8) Proof Appendix (Requirement → Evidence)\n`;
  out += `| Requirement | Evidence ID | Evidence Quote |\n|---|---|---|\n`;
  for (const r of reqs) {
    const ids = safeArray<string>((r as any).evidenceIds);
    const quotes = safeArray<string>((r as any).evidenceQuotes);
    if (!ids.length || !quotes.length) continue;

    const maxRows = Math.min(2, Math.max(ids.length, quotes.length));
    for (let i = 0; i < maxRows; i++) {
      const eid = ids[i] ?? ids[0];
      const q = quotes[i] ?? quotes[0];
      out += `| ${mdEscapeCell(r.id)} | ${mdEscapeCell(eid)} | ${mdEscapeCell(q)} |\n`;
    }
  }

  out += `\n`;
  return out;
}

function formatClarificationsEmail(result: MatrixResult) {
  const d = nowISODate();
  const reqs = safeArray<RequirementRow>((result as any).requirements);

  const items: Array<{ id: string; status: CoverageStatus; q: string }> = [];
  for (const r of reqs) {
    for (const q of safeArray<string>((r as any).gapsOrQuestions)) {
      items.push({ id: r.id, status: r.status, q });
    }
  }

  // keep it deterministic + readable (top 20)
  const normalized = uniqStrings(items.map((x) => `${x.id}|||${x.status}|||${x.q}`))
    .map((s) => {
      const [id, status, q] = s.split("|||");
      return { id, status: status as CoverageStatus, q };
    })
    .slice(0, 20);

  let out = "";
  out += `# Clarifications Email (MD)\n`;
  out += `_Date: ${d}_\n\n`;
  out += `Subject: Clarifications for RapidRelief RFP — Requirements & Integration Details\n\n`;
  out += `Hello RapidRelief Team,\n\n`;
  out += `Thank you for the opportunity to respond. To ensure our proposal is fully aligned and implementation-ready, we would appreciate clarification on the items below:\n\n`;

  if (!normalized.length) out += `- No clarification questions at this time.\n\n`;
  else {
    for (const it of normalized) out += `- **${it.id}** (${it.status}) — ${it.q}\n`;
    out += `\n`;
  }

  out += `Thank you,\nMatrixMint Solutions\n`;
  return out;
}

function formatRisksCsv(result: MatrixResult) {
  const reqs = safeArray<RequirementRow>((result as any).requirements);
  const header = ["RequirementID", "Status", "RiskFlags", "GapsOrQuestions", "EvidenceIDs"].join(",");
  const lines = [header];

  for (const r of reqs) {
    const riskFlags = safeArray<string>((r as any).riskFlags).join("; ");
    const gaps = safeArray<string>((r as any).gapsOrQuestions).join("; ");
    const eids = safeArray<string>((r as any).evidenceIds).join("; ");

    if (!riskFlags && !gaps) continue;

    lines.push(
      [
        escapeCsvCell(safeString(r.id)),
        escapeCsvCell(safeString(r.status)),
        escapeCsvCell(riskFlags),
        escapeCsvCell(gaps),
        escapeCsvCell(eids),
      ].join(",")
    );
  }

  return lines.join("\n") + "\n";
}

function formatProposalDraft(result: MatrixResult) {
  const d = nowISODate();
  const exec = safeString((result as any).proposalOutline?.executiveSummary) || "—";
  const sections = safeArray<string>((result as any).proposalOutline?.sections);

  let out = "";
  out += `# MatrixMint — Proposal Draft (MD)\n`;
  out += `_Date: ${d}_\n\n`;
  out += `## Executive Summary\n${exec}\n\n`;
  out += `## Sections\n`;
  if (!sections.length) {
    out += `1. Solution Overview\n2. Compliance Matrix & Technical Specifications\n3. Implementation Plan (30/60/90)\n4. Pricing & Licensing\n5. Risks & Mitigations\n6. Support & Training\n\n`;
  } else {
    out += sections.map((s, i) => `${i + 1}. ${s}`).join("\n") + "\n\n";
  }
  out += `## Notes\n`;
  out += `- This draft is generated from the analyzed compliance result and is intended to be refined with customer-specific context (pricing, deployment, SLAs).\n`;
  out += `- All capability statements should remain evidence-anchored.\n\n`;
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const format = (searchParams.get("format") || "proofpack_md") as ExportFormat;

    const body = await req.json().catch(() => null);
    const result = (body?.result ?? null) as MatrixResult | null;
    const meta = (body?.meta ?? null) as AnalyzeMeta | null;

    if (!result || typeof result !== "object") {
      return NextResponse.json({ error: "Missing result payload" }, { status: 400 });
    }

    // minimal shape hardening
    (result as any).requirements = safeArray<RequirementRow>((result as any).requirements);
    (result as any).summary = (result as any).summary ?? {};

    // bundle_json: one payload containing all exports (judge-friendly)
    if (format === "bundle_json") {
      const stats = computeStats(result);
      const payload = {
        ok: true,
        generatedAt: new Date().toISOString(),
        runSummary: {
          coveragePercent: Number(stats.coveragePct.toFixed(2)),
          proof: stats.proofLabel ?? "—",
          total: stats.total,
          covered: stats.covered,
          partial: stats.partial,
          missing: stats.missing,
        },
        meta: meta ?? undefined,
        result,
        exports: {
          proofpack_md: formatProofPack(result),
          bidpacket_md: formatBidPacket(result),
          clarifications_email_md: formatClarificationsEmail(result),
          risks_csv: formatRisksCsv(result),
          proposal_draft_md: formatProposalDraft(result),
        },
      };

      const json = JSON.stringify(payload, null, 2);
      const filename = `matrixmint-bundle-${nowISODate()}.json`;
      return new NextResponse(json, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "x-matrixmint-filename": filename,
        },
      });
    }

    if (format === "json") {
      const json = JSON.stringify(result, null, 2);
      const filename = `matrixmint-${nowISODate()}.json`;
      return new NextResponse(json, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "x-matrixmint-filename": filename,
        },
      });
    }

    if (format === "risks_csv") {
      const csv = formatRisksCsv(result);
      const filename = `matrixmint-risks-${nowISODate()}.csv`;
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "x-matrixmint-filename": filename,
        },
      });
    }

    let content = "";
    let filename = "matrixmint-export.md";

    if (format === "proofpack_md") {
      content = formatProofPack(result);
      filename = `matrixmint-proofpack-${nowISODate()}.md`;
    } else if (format === "bidpacket_md") {
      content = formatBidPacket(result);
      filename = `matrixmint-bid-ready-${nowISODate()}.md`;
    } else if (format === "clarifications_email_md") {
      content = formatClarificationsEmail(result);
      filename = `matrixmint-clarifications-email-${nowISODate()}.md`;
    } else if (format === "proposal_draft_md") {
      content = formatProposalDraft(result);
      filename = `matrixmint-proposal-draft-${nowISODate()}.md`;
    } else {
      return NextResponse.json({ error: `Unknown export format: ${format}` }, { status: 400 });
    }

    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "x-matrixmint-filename": filename,
      },
    });
  } catch (err: any) {
    const msg = String(err?.message ?? "Export failed");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
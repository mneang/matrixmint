import { NextResponse } from "next/server";

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

function toMarkdown(result: MatrixResult) {
  const s = result.summary;

  // Evidence map: CB-xx -> req IDs
  const evidenceMap = new Map<string, Set<string>>();
  for (const r of result.requirements) {
    for (const ev of r.evidenceIds ?? []) {
      if (!evidenceMap.has(ev)) evidenceMap.set(ev, new Set());
      evidenceMap.get(ev)!.add(r.id);
    }
  }

  const evidenceLines = Array.from(evidenceMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cb, reqs]) => `- **${cb}** → ${Array.from(reqs).sort().join(", ")}`);

  const matrixRows = result.requirements
    .map((r) => {
      const evidence = (r.evidenceIds?.length ? r.evidenceIds.join(", ") : "—").replace(/\|/g, "\\|");
      const reqText = r.text.replace(/\|/g, "\\|");
      const summary = r.responseSummary.replace(/\|/g, "\\|");
      const risks = (r.riskFlags?.length ? r.riskFlags.join("; ") : "—").replace(/\|/g, "\\|");
      const gaps = (r.gapsOrQuestions?.length ? r.gapsOrQuestions.join("; ") : "—").replace(/\|/g, "\\|");
      return `| ${r.id} | ${r.category} | ${r.status} | ${reqText} | ${summary} | ${evidence} | ${gaps} | ${risks} |`;
    })
    .join("\n");

  return `# MatrixMint — Compliance Proof Pack

## Summary
- **Coverage:** ${Math.round(s.coveragePercent)}%
- **Total:** ${s.totalRequirements}
- **Covered:** ${s.coveredCount}
- **Partial:** ${s.partialCount}
- **Missing:** ${s.missingCount}

## Top Risks
${(s.topRisks ?? []).map((x) => `- ${x}`).join("\n") || "- (none)"}

## Next Actions
${(s.nextActions ?? []).map((x) => `- ${x}`).join("\n") || "- (none)"}

## Evidence Map (Capability Brief → Requirements)
${evidenceLines.join("\n") || "- (no evidence links)"}

## Compliance Matrix
| ID | Category | Status | Requirement | Response Summary | Evidence IDs | Gaps / Questions | Risk Flags |
|---|---|---|---|---|---|---|---|
${matrixRows}

## Proposal Outline — Executive Summary
${result.proposalOutline.executiveSummary}

## Proposal Outline — Sections
${(result.proposalOutline.sections ?? []).map((x, i) => `${i + 1}. ${x}`).join("\n")}
`;
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const format = (url.searchParams.get("format") ?? "md").toLowerCase();

    const body = (await req.json()) as { result: MatrixResult };
    const result = body?.result;

    if (!result) {
      return NextResponse.json({ ok: false, error: "Missing result payload" }, { status: 400 });
    }

    if (format === "json") {
      return NextResponse.json(result, {
        headers: {
          "Content-Disposition": `attachment; filename="matrixmint-proofpack.json"`,
        },
      });
    }

    const md = toMarkdown(result);
    return new NextResponse(md, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="matrixmint-proofpack.md"`,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "Export failed" }, { status: 500 });
  }
}
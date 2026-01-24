import { z } from "zod";

export const coverageStatusSchema = z.enum(["Covered", "Partial", "Missing"]);

export const requirementSchema = z.object({
  id: z.string().describe("Requirement ID (e.g., FR-01, NFR-02). If missing in input, generate GEN-01, GEN-02, etc."),
  category: z.enum(["Functional", "NonFunctional"]).describe("Functional vs non-functional requirement."),
  text: z.string().describe("The requirement text, minimally rewritten for clarity."),
  status: coverageStatusSchema.describe("Coverage status based on the capability brief."),
  responseSummary: z.string().describe("1–3 sentences describing how the vendor meets (or partially meets) the requirement."),
  evidenceIds: z.array(z.string()).describe("List of capability brief evidence IDs used (e.g., CB-03). Empty if Missing."),
  evidenceQuotes: z.array(z.string()).describe("Short supporting quotes/paraphrases aligned to evidenceIds."),
  gapsOrQuestions: z.array(z.string()).describe("Questions/missing info needed to fully comply. Empty if Covered."),
  riskFlags: z.array(z.string()).describe("Risk flags: overpromise risk, third-party dependency, ambiguity, etc."),
});

export const matrixResultSchema = z.object({
  summary: z.object({
    totalRequirements: z.number().int(),
    coveredCount: z.number().int(),
    partialCount: z.number().int(),
    missingCount: z.number().int(),
    coveragePercent: z.number().min(0).max(100),
    topRisks: z.array(z.string()).describe("Top 3–6 risks discovered."),
    nextActions: z.array(z.string()).describe("Top 3–6 next actions to close gaps."),
    proofVerifiedCount: z.number(),
    proofTotalEvidenceRefs: z.number(),
    proofPercent: z.number(),
    proofNotes: z.array(z.string()),
  }),
  requirements: z.array(requirementSchema),
  proposalOutline: z.object({
    executiveSummary: z.string().describe("Short executive summary tailored to the RFP."),
    sections: z.array(z.string()).describe("Proposal section headings."),
    evidenceVerified: z.boolean(),
    evidenceVerificationNotes: z.array(z.string()),
  }),
});
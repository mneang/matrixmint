import { z } from "zod";

/**
 * Minimal schema used by /api/analyze to validate the analyzer output.
 * Keep this conservative so it doesn't break runs if fields evolve.
 */
export const matrixResultSchema = z.object({
  summary: z
    .object({
      totalRequirements: z.number().optional(),
      coveredCount: z.number().optional(),
      partialCount: z.number().optional(),
      missingCount: z.number().optional(),
      coveragePercent: z.number().optional(),
      topRisks: z.array(z.string()).optional(),
      nextActions: z.array(z.string()).optional(),
      proofVerifiedCount: z.number().optional(),
      proofTotalEvidenceRefs: z.number().optional(),
      proofPercent: z.number().optional(),
      proofNotes: z.array(z.string()).optional(),
    })
    .optional(),
  requirements: z
    .array(
      z.object({
        id: z.string(),
        category: z.string().optional(),
        text: z.string(),
        status: z.enum(["Covered", "Partial", "Missing"]).or(z.string()),
        responseSummary: z.string().optional(),
        evidenceIds: z.array(z.string()).optional(),
        evidenceQuotes: z.array(z.string()).optional(),
        gapsOrQuestions: z.array(z.string()).optional(),
        riskFlags: z.array(z.string()).optional(),
      })
    )
    .optional(),
  proposalOutline: z
    .object({
      executiveSummary: z.string().optional(),
      sections: z.array(z.string()).optional(),
      evidenceVerified: z.boolean().optional(),
      evidenceVerificationNotes: z.array(z.string()).optional(),
    })
    .optional(),
});
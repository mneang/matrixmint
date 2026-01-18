import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { matrixResultSchema } from "@/lib/matrixSchema";

// ThinkingLevel enum availability varies across SDK builds.
// This keeps TS happy and runtime stable.
let THINKING_LEVEL: any = "HIGH";
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@google/genai");
  if (mod?.ThinkingLevel?.HIGH) THINKING_LEVEL = mod.ThinkingLevel.HIGH;
} catch {
  // ignore
}

type AnalyzeBody = {
  rfpText: string;
  capabilityText: string;
  model?: "gemini-3-flash-preview" | "gemini-3-pro-preview";
};

function buildPrompt(rfpText: string, capabilityText: string) {
  return `
You are MatrixMint, an RFP compliance analyst.

MISSION:
Given (A) an RFP and (B) a Capability Brief (CB-xx statements),
produce a compliance matrix + proposal outline as STRICT JSON.

NON-NEGOTIABLE RULES:
1) The Capability Brief is the ONLY source of truth. Never invent capabilities.
2) "Covered" requires:
   - evidenceIds is non-empty
   - evidenceQuotes aligns with those CB-xx IDs
3) If requirement mentions SMS reminders and Capability Brief says "not included by default",
   status MUST be "Partial" and riskFlags must include "Third-party dependency".
4) Extract all requirements:
   - Prefer explicit IDs: FR-01.., NFR-01..
   - If no ID, generate GEN-01, GEN-02...
5) For Partial/Missing: include 1–3 gapsOrQuestions.
6) responseSummary: 1–3 short, business-readable sentences.
7) proposalOutline must align to the RFP response format and be actionable.

QUALITY BAR:
- Be conservative. When unclear, choose Partial with a question.
- Keep evidenceQuotes short; reference CB-xx precisely.
- Avoid fluff. Precision wins.

INPUTS:
=== RFP TEXT ===
${rfpText}

=== CAPABILITY BRIEF (Evidence Only) ===
${capabilityText}
`;
}

function safeJsonParse(raw: string) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new Error("Empty model response");

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return JSON.parse(trimmed);

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }

  return JSON.parse(trimmed);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<AnalyzeBody>;
    const rfpText = (body.rfpText ?? "").trim();
    const capabilityText = (body.capabilityText ?? "").trim();
    const model = body.model ?? "gemini-3-flash-preview";

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { ok: false, error: "Missing GEMINI_API_KEY" },
        { status: 500 }
      );
    }
    if (!rfpText || !capabilityText) {
      return NextResponse.json(
        { ok: false, error: "rfpText and capabilityText are required" },
        { status: 400 }
      );
    }
    console.log("MatrixMint key suffix:", process.env.GEMINI_API_KEY?.slice(-4));
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Zod v4 native JSON Schema conversion (no zod-to-json-schema needed)
    const jsonSchema = z.toJSONSchema(matrixResultSchema);

    const prompt = buildPrompt(rfpText, capabilityText);

// Try chosen model first with retries.
// If still overloaded, auto-fallback to the other model (also with retries).
let response;
try {
  response = await generateWithRetries({
    ai,
    model,
    prompt,
    jsonSchema,
    thinkingLevel: THINKING_LEVEL,
  });
} catch (err: any) {
  if (isOverloadedError(err)) {
    const fallback =
      model === "gemini-3-flash-preview" ? "gemini-3-pro-preview" : "gemini-3-flash-preview";

    console.log(`MatrixMint: falling back to ${fallback} due to overload`);
    response = await generateWithRetries({
      ai,
      model: fallback,
      prompt,
      jsonSchema,
      thinkingLevel: THINKING_LEVEL,
    });
  } else {
    throw err;
  }
}

    const raw = response.text ?? "";
    const json = safeJsonParse(raw);

    function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isOverloadedError(err: any) {
  const msg = String(err?.message ?? "");
  const status = err?.status || err?.error?.status;
  const code = err?.code || err?.error?.code;

  // We mainly see 503 UNAVAILABLE "model is overloaded"
  return (
    status === "UNAVAILABLE" ||
    code === 503 ||
    msg.includes("overloaded") ||
    msg.includes("UNAVAILABLE") ||
    msg.includes("503")
  );
}

async function generateWithRetries(params: {
  ai: GoogleGenAI;
  model: "gemini-3-flash-preview" | "gemini-3-pro-preview";
  prompt: string;
  jsonSchema: any;
  thinkingLevel: any;
}) {
  const { ai, model, prompt, jsonSchema, thinkingLevel } = params;

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema as any,
          thinkingConfig: { thinkingLevel },
        },
      });
    } catch (err: any) {
      if (!isOverloadedError(err) || attempt === maxAttempts) throw err;

      // Exponential backoff: 400ms, 900ms, 1600ms...
      const wait = 250 + attempt * attempt * 150;
      console.log(`MatrixMint: ${model} overloaded. Retry ${attempt}/${maxAttempts} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error("Retry loop fell through unexpectedly");
}

    const parsed = matrixResultSchema.parse(json);
    return NextResponse.json({ ok: true, data: parsed });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
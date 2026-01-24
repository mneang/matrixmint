export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import crypto from "crypto";
import path from "path";
import { promises as fs } from "fs";
import { matrixResultSchema } from "@/lib/matrixSchema";

// ThinkingLevel enum availability varies across SDK builds.
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
  proposalOutline: {
    executiveSummary: string;
    sections: string[];
  };
};

type CacheMeta = {
  hit: boolean;
  key?: string;
  ageSeconds?: number;
  source?: "memory" | "disk" | "none";
};

type QuotaMeta = {
  blocked: boolean;
  blockedUntilUnixMs: number;
  retryAfterSeconds: number;
  lastError: string;
};

type AnalyzeMeta = {
  modelRequested: string;
  modelUsed: string;
  fallbackUsed?: "none" | "flash" | "cache" | "offline";
  warnings?: string[];
  cache?: CacheMeta;
  quota?: QuotaMeta;
};

const RESULT_CACHE = new Map<string, { data: MatrixResult; savedAt: number }>();

const CACHE_DIR = path.join(process.cwd(), ".matrixmint_cache");
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// IMPORTANT: bump this if you change offline logic, proof verifier rules, prompt rules, schema, etc.
// Keeps cache deterministic & avoids "poisoned" old cache after logic changes.
const CACHE_VERSION = "v3.1";

let QUOTA_BLOCKED_UNTIL_MS = 0;
let QUOTA_LAST_ERROR = "";

function nowMs() {
  return Date.now();
}

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function uniqStrings(arr: any[]) {
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

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function cachePathForKey(key: string) {
  return path.join(CACHE_DIR, `${key}.json`);
}

async function readDiskCache(key: string): Promise<{ data: MatrixResult; savedAt: number } | null> {
  try {
    await ensureCacheDir();
    const p = cachePathForKey(key);
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.data || typeof parsed?.savedAt !== "number") return null;

    if (nowMs() - parsed.savedAt > CACHE_TTL_MS) return null;

    matrixResultSchema.parse(parsed.data);
    return { data: parsed.data as MatrixResult, savedAt: parsed.savedAt as number };
  } catch {
    return null;
  }
}

async function writeDiskCache(key: string, data: MatrixResult) {
  await ensureCacheDir();
  const p = cachePathForKey(key);
  const tmp = `${p}.tmp`;
  const payload = JSON.stringify({ savedAt: nowMs(), data }, null, 2);
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, p);
}

function normalizeForMatch(s: string) {
  return (s ?? "")
    .replace(/\r/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[‐-–—]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function quoteExistsInText(quote: string, text: string) {
  const t = normalizeForMatch(text);
  if (!t) return false;

  let q = normalizeForMatch(quote);
  if (!q) return false;

  q = q.replace(/^"+|"+$/g, "").trim();

  const hasEllipsis = q.includes("...") || q.includes("…");
  if (hasEllipsis) {
    const parts = q
      .split(/\.{3}|…/g)
      .map((p) => p.trim())
      .filter(Boolean);

    if (!parts.length) return false;

    let idx = 0;
    for (const part of parts) {
      const found = t.indexOf(part, idx);
      if (found === -1) return false;
      idx = found + part.length;
    }
    return true;
  }

  if (t.includes(q)) return true;

  const q2 = q.replace(/\.$/, "").trim();
  if (q2 && t.includes(q2)) return true;

  return false;
}

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
8) Outputs must be English.
9) OUTPUT MUST BE A SINGLE JSON OBJECT. No markdown. No commentary.

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

function buildStrictRetryPrompt(basePrompt: string) {
  return (
    basePrompt +
    `

STRICT MODE:
- Return ONLY valid JSON (single object).
- Do not wrap in \`\`\`.
- Do not include any extra keys outside the required structure.
- If uncertain, still return the full structure with conservative values.
`
  );
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isOverloadedError(err: any) {
  const msg = String(err?.message ?? "");
  const status = err?.status || err?.error?.status;
  const code = err?.code || err?.error?.code;

  return (
    status === "UNAVAILABLE" ||
    code === 503 ||
    msg.includes("overloaded") ||
    msg.includes("UNAVAILABLE") ||
    msg.includes("503")
  );
}

function isQuotaExceededError(err: any) {
  const msg = String(err?.message ?? "");
  const status = err?.status || err?.error?.status;
  const code = err?.code || err?.error?.code;

  return (
    status === "RESOURCE_EXHAUSTED" ||
    code === 429 ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.toLowerCase().includes("quota exceeded") ||
    msg.toLowerCase().includes("exceeded your current quota") ||
    msg.toLowerCase().includes("rate limit")
  );
}

function parseRetryAfterSecondsFromError(err: any): number {
  // Gemini error often embeds retryDelay like "33s" or "15s" in details.
  try {
    const raw = err?.message ?? err?.error?.message ?? "";
    const s = String(raw);

    // direct "Please retry in 15.47s"
    const m1 = s.match(/retry in\s+([\d.]+)s/i);
    if (m1) return Math.max(1, Math.ceil(Number(m1[1])));

    // google.rpc.RetryInfo: retryDelay:"33s"
    const m2 = s.match(/retryDelay"\s*:\s*"(\d+)s/i);
    if (m2) return Math.max(1, Number(m2[1]));

    // sometimes the stringified JSON is attached in meta.quota.lastError
    const m3 = s.match(/"retryDelay"\s*:\s*"(\d+)s"/i);
    if (m3) return Math.max(1, Number(m3[1]));
  } catch {
    // ignore
  }
  return 0;
}

function setQuotaCooldownFromError(err: any) {
  const retryAfter = parseRetryAfterSecondsFromError(err);
  const cooldownMs =
    retryAfter > 0
      ? (retryAfter + 2) * 1000 // small buffer so we don't hammer at boundary
      : 2 * 60 * 1000; // fallback if Gemini didn't give a retry delay: 2 minutes

  QUOTA_BLOCKED_UNTIL_MS = Math.max(QUOTA_BLOCKED_UNTIL_MS, nowMs() + cooldownMs);
  QUOTA_LAST_ERROR = safeStringifyErr(err);
}

function safeStringifyErr(err: any) {
  try {
    if (typeof err === "string") return err;
    if (err?.message && typeof err.message === "string") return err.message;
    return JSON.stringify(err);
  } catch {
    return String(err ?? "");
  }
}

function getQuotaMeta(): QuotaMeta {
  const blocked = nowMs() < QUOTA_BLOCKED_UNTIL_MS;
  const retryAfterSeconds = blocked ? Math.max(0, Math.ceil((QUOTA_BLOCKED_UNTIL_MS - nowMs()) / 1000)) : 0;
  return {
    blocked,
    blockedUntilUnixMs: blocked ? QUOTA_BLOCKED_UNTIL_MS : 0,
    retryAfterSeconds,
    lastError: QUOTA_LAST_ERROR || "",
  };
}

async function extractResponseText(resp: any): Promise<string> {
  if (!resp) return "";
  if (typeof resp.text === "string") return resp.text;

  if (typeof resp.text === "function") {
    try {
      const v = resp.text();
      const s = typeof (v as any)?.then === "function" ? await v : v;
      if (typeof s === "string") return s;
    } catch {
      // continue
    }
  }

  const partsA = resp?.candidates?.[0]?.content?.parts;
  if (Array.isArray(partsA)) {
    const joined = partsA.map((p: any) => p?.text).filter(Boolean).join("");
    if (joined) return joined;
  }

  const partsB = resp?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(partsB)) {
    const joined = partsB.map((p: any) => p?.text).filter(Boolean).join("");
    if (joined) return joined;
  }

  return "";
}

async function generateWithRetries(params: {
  ai: GoogleGenAI;
  model: "gemini-3-flash-preview" | "gemini-3-pro-preview";
  prompt: string;
  jsonSchema: any;
  thinkingLevel: any;
}) {
  const { ai, model, prompt, jsonSchema, thinkingLevel } = params;

  const maxAttempts = Number(process.env.MAX_RETRIES ?? "4");
  const baseDelay = Number(process.env.RETRY_BASE_MS ?? "250");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema as any,
          thinkingConfig: { thinkingLevel },
          temperature: 0.2,
          topP: 0.9,
          candidateCount: 1,
        } as any,
      });
    } catch (err: any) {
      if (isQuotaExceededError(err)) {
        setQuotaCooldownFromError(err);
        throw err;
      }
      if (!isOverloadedError(err) || attempt === maxAttempts) throw err;

      const wait = baseDelay + attempt * attempt * 150; // quadratic backoff
      console.log(`MatrixMint: ${model} overloaded. Retry ${attempt}/${maxAttempts} in ${wait}ms`);
      await sleep(wait);
    }
  }

  throw new Error("Retry loop fell through unexpectedly");
}

function computeProof(parsed: any, capabilityText: string): MatrixResult {
  const result = parsed as MatrixResult;

  let totalRefs = 0;
  let verifiedRefs = 0;

  const updatedReqs: RequirementRow[] = (result.requirements ?? []).map((r) => {
    const evidenceIds = Array.isArray(r.evidenceIds) ? r.evidenceIds.map(String) : [];
    const evidenceQuotes = Array.isArray(r.evidenceQuotes) ? r.evidenceQuotes.map(String) : [];
    const baseFlags = Array.isArray(r.riskFlags) ? r.riskFlags.map(String) : [];

    const riskFlags = uniqStrings(baseFlags.filter((f) => String(f) !== "Evidence mismatch"));

    if (evidenceIds.length > 0) {
      const expectedRefs = Math.max(evidenceIds.length, evidenceQuotes.length, 1);
      totalRefs += expectedRefs;

      for (const q of evidenceQuotes) {
        if (quoteExistsInText(q, capabilityText)) {
          verifiedRefs += 1;
        } else {
          if (!riskFlags.includes("Evidence mismatch")) riskFlags.push("Evidence mismatch");
        }
      }

      if (evidenceQuotes.length < evidenceIds.length) {
        if (!riskFlags.includes("Evidence mismatch")) riskFlags.push("Evidence mismatch");
      }
    }

    return {
      ...r,
      evidenceIds,
      evidenceQuotes,
      riskFlags: uniqStrings(riskFlags),
    };
  });

  const proofPercent = totalRefs === 0 ? 100 : Math.round((verifiedRefs / totalRefs) * 100);

  const summary = result.summary ?? ({} as MatrixResult["summary"]);
  const proofNotes = uniqStrings([
    ...(Array.isArray((summary as any).proofNotes) ? ((summary as any).proofNotes as string[]) : []),
    "Proof verifier checks evidenceQuotes against the Capability Brief text (normalized matching; ellipsis wildcard supported).",
    'The "Evidence mismatch" flag is verifier-owned and is only added/removed by the proof verifier.',
    "Proof totals count unpaired evidence IDs (IDs without quotes) as unverified references (conservative scoring).",
  ]);

  return {
    ...result,
    requirements: updatedReqs,
    summary: {
      ...summary,
      proofPercent,
      proofVerifiedCount: verifiedRefs,
      proofTotalEvidenceRefs: totalRefs,
      proofNotes,
    },
  };
}

async function generateParseValidate(params: {
  ai: GoogleGenAI;
  model: "gemini-3-flash-preview" | "gemini-3-pro-preview";
  prompt: string;
  jsonSchema: any;
  thinkingLevel: any;
}) {
  const resp = await generateWithRetries(params);
  const raw = (await extractResponseText(resp)) ?? "";
  const json = safeJsonParse(raw);
  const parsed = matrixResultSchema.parse(json);
  return parsed as MatrixResult;
}

function offlineAnalyze(rfpText: string, capabilityText: string): MatrixResult {
  const rfp = rfpText.replace(/\r/g, "");
  const cap = capabilityText.replace(/\r/g, "");

  const reqLines = rfp.split("\n").map((l) => l.trim()).filter(Boolean);

  const reqs: Array<{ id: string; text: string; category: "Functional" | "NonFunctional" }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < reqLines.length; i++) {
    const line = reqLines[i];
    const m = line.match(/\b(FR-\d+|NFR-\d+)\b/);
    if (!m) continue;

    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);

    let text = line;
    const after = line.split(id)[1]?.trim() ?? "";
    if (after && after.length >= 10) text = after.replace(/^[:\-|]\s*/, "").trim();

    if (!text || text.length < 10) {
      const next = reqLines[i + 1] ?? "";
      if (next && next.length >= 10) text = next;
    }

    const category = id.startsWith("NFR-") ? "NonFunctional" : "Functional";
    reqs.push({ id, text, category });
  }

  if (!reqs.length) {
    const shallLines = reqLines.filter((l) => /\bshall\b/i.test(l));
    let idx = 1;
    for (const l of shallLines.slice(0, 30)) {
      const id = `GEN-${String(idx).padStart(2, "0")}`;
      reqs.push({ id, text: l, category: "Functional" });
      idx += 1;
    }
  }

  const cbBlocks: Array<{ id: string; snippet: string }> = [];
  const cbMatches = Array.from(cap.matchAll(/\bCB-\d{2}\b/g))
    .map((m) => m.index ?? -1)
    .filter((x) => x >= 0);

  if (cbMatches.length) {
    for (const idx of cbMatches) {
      const id = cap.slice(idx, idx + 5);
      const start = idx;
      const end = cap.indexOf("\n", start);
      const line = (end === -1 ? cap.slice(start) : cap.slice(start, end)).trim();

      let snippet = line;
      if (snippet === id) snippet = cap.slice(start, start + 240).replace(/\s+/g, " ").trim();

      cbBlocks.push({ id, snippet });
    }
  } else {
    cbBlocks.push({ id: "CB-00", snippet: cap.slice(0, 300).replace(/\s+/g, " ").trim() });
  }

  function tokenize(s: string) {
    return normalizeForMatch(s)
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((w) => w.length >= 3)
      .filter((w) => !["the", "and", "for", "with", "that", "this", "shall", "will", "are", "not", "into"].includes(w));
  }

  function bestEvidenceFor(reqText: string) {
    const rt = new Set(tokenize(reqText));
    let best: { id: string; snippet: string; score: number } | null = null;

    for (const b of cbBlocks) {
      const bt = tokenize(b.snippet);
      let score = 0;
      for (const w of bt) if (rt.has(w)) score += 1;
      if (!best || score > best.score) best = { id: b.id, snippet: b.snippet, score };
    }
    return best;
  }

  const capNorm = normalizeForMatch(capabilityText);

  const rows: RequirementRow[] = reqs.map((r) => {
    const reqText = r.text || r.id;
    const reqNorm = normalizeForMatch(reqText);

    const mentionsSms = reqNorm.includes("sms");
    const capSaysNotIncluded = capNorm.includes("sms") && capNorm.includes("not included");

    const ev = bestEvidenceFor(reqText);
    const score = ev?.score ?? 0;

    let status: CoverageStatus = "Partial";
    let evidenceIds: string[] = [];
    let evidenceQuotes: string[] = [];
    let riskFlags: string[] = [];
    let gapsOrQuestions: string[] = [];

    if (mentionsSms && capSaysNotIncluded) {
      status = "Partial";
      riskFlags.push("Third-party dependency");
      gapsOrQuestions.push("Which third-party SMS provider will be used for integration?");
      gapsOrQuestions.push("Will the organization provide API credentials for the SMS provider?");
      const smsEv = cbBlocks.find((b) => normalizeForMatch(b.snippet).includes("sms")) ?? ev;
      if (smsEv) {
        evidenceIds = [smsEv.id];
        evidenceQuotes = [smsEv.snippet.slice(0, 160)];
      }
    } else if (score >= 2 && ev) {
      status = "Covered";
      evidenceIds = [ev.id];
      evidenceQuotes = [ev.snippet.slice(0, 160)];
    } else if (score === 1 && ev) {
      status = "Partial";
      evidenceIds = [ev.id];
      evidenceQuotes = [ev.snippet.slice(0, 160)];
      gapsOrQuestions.push("Can you confirm the exact workflow details and constraints for this requirement?");
      riskFlags.push("Ambiguity");
    } else {
      status = "Partial";
      gapsOrQuestions.push("The capability brief does not explicitly confirm this requirement. Provide supporting evidence or documentation.");
      riskFlags.push("Weak evidence");
    }

    const responseSummary =
      status === "Covered"
        ? "Supported based on the capability brief evidence cited."
        : "Supported in part or requires confirmation based on available evidence.";

    return {
      id: r.id,
      category: r.category,
      text: reqText,
      status,
      responseSummary,
      evidenceIds,
      evidenceQuotes,
      gapsOrQuestions: gapsOrQuestions.slice(0, 3),
      riskFlags: uniqStrings(riskFlags),
    };
  });

  const total = rows.length;
  const coveredCount = rows.filter((x) => x.status === "Covered").length;
  const partialCount = rows.filter((x) => x.status === "Partial").length;
  const missingCount = rows.filter((x) => x.status === "Missing").length;
  const coveragePercent = total ? (coveredCount / total) * 100 : 0;

  const topRisks = uniqStrings(rows.flatMap((r) => r.riskFlags ?? []).filter(Boolean)).slice(0, 8);
  const nextActions = uniqStrings(rows.filter((r) => r.status !== "Covered").flatMap((r) => r.gapsOrQuestions ?? [])).slice(0, 8);

  const proposalOutline = {
    executiveSummary:
      "MatrixMint provides a proof-locked compliance analysis that maps each requirement to verifiable capability evidence, producing bid-ready exports with conservative coverage classification.",
    sections: [
      "1. Solution Overview and Approach",
      "2. Compliance Matrix and Evidence Mapping",
      "3. Risk Register and Mitigation Plan",
      "4. Clarifications and Open Questions",
      "5. Implementation Plan and Milestones",
      "6. Support, Training, and Adoption",
    ],
  };

  const withProof = computeProof(
    {
      summary: {
        totalRequirements: total,
        coveredCount,
        partialCount,
        missingCount,
        coveragePercent,
        topRisks,
        nextActions,
      },
      requirements: rows,
      proposalOutline,
    },
    capabilityText
  );

  withProof.summary.coveragePercent = clamp(withProof.summary.coveragePercent, 0, 100);
  withProof.summary.proofNotes = uniqStrings([
    ...(withProof.summary.proofNotes ?? []),
    "Offline mode: deterministic matching between requirements and capability evidence via keyword overlap (conservative).",
    "No capabilities are asserted without attaching a direct capability snippet as evidence.",
  ]);

  return withProof;
}

export async function POST(req: Request) {
  const meta: AnalyzeMeta = {
    modelRequested: "unknown",
    modelUsed: "unknown",
    fallbackUsed: "none",
    warnings: [],
    cache: { hit: false, source: "none" },
    quota: getQuotaMeta(),
  };

  try {
    const body = (await req.json()) as Partial<AnalyzeBody>;
    const rfpText = (body.rfpText ?? "").trim();
    const capabilityText = (body.capabilityText ?? "").trim();
    const requestedModel = body.model ?? "gemini-3-flash-preview";

    meta.modelRequested = requestedModel;

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ ok: false, error: "Missing GEMINI_API_KEY" }, { status: 500 });
    }
    if (!rfpText || !capabilityText) {
      return NextResponse.json({ ok: false, error: "rfpText and capabilityText are required" }, { status: 400 });
    }

    // Headers (control plane)
    const h = new Headers(req.headers);
    const forceMode = (h.get("x-matrixmint-mode") || "").trim().toLowerCase(); // "", "live", "cache", "offline"
    const bustCache = (h.get("x-matrixmint-bust-cache") || "").trim() === "1";
    const clearCache = (h.get("x-matrixmint-clear-cache") || "").trim() === "1";

    // Build stable cache key (include version + requested model + inputs)
    const cacheKey = sha256(`${CACHE_VERSION}\n${requestedModel}\n---\n${rfpText}\n---\n${capabilityText}`);
    meta.cache = { hit: false, key: cacheKey, source: "none" };
    meta.quota = getQuotaMeta();

    // Clear only this key (memory + disk)
    if (clearCache) {
      RESULT_CACHE.delete(cacheKey);
      try {
        await ensureCacheDir();
        await fs.unlink(cachePathForKey(cacheKey));
      } catch {
        // ignore
      }
      meta.warnings?.push("Cache cleared for this input key.");
    }

    // Forced modes
    if (forceMode === "offline") {
      meta.warnings?.push("Forced offline (x-matrixmint-mode=offline).");
      const offline = offlineAnalyze(rfpText, capabilityText);
      RESULT_CACHE.set(cacheKey, { data: offline, savedAt: nowMs() });
      await writeDiskCache(cacheKey, offline);
      meta.modelUsed = "offline";
      meta.fallbackUsed = "offline";
      meta.cache = { hit: false, key: cacheKey, source: "none" };
      meta.quota = getQuotaMeta();
      return NextResponse.json({ ok: true, data: offline, meta });
    }

    if (forceMode === "cache") {
      // Cache-only: do NOT run model, do NOT run offline generation.
      const mem = RESULT_CACHE.get(cacheKey);
      if (mem) {
        meta.modelUsed = "cache";
        meta.fallbackUsed = "cache";
        meta.cache = { hit: true, key: cacheKey, source: "memory", ageSeconds: Math.round((nowMs() - mem.savedAt) / 1000) };
        meta.quota = getQuotaMeta();
        return NextResponse.json({ ok: true, data: mem.data, meta });
      }

      const disk = await readDiskCache(cacheKey);
      if (disk) {
        RESULT_CACHE.set(cacheKey, disk);
        meta.modelUsed = "cache";
        meta.fallbackUsed = "cache";
        meta.cache = { hit: true, key: cacheKey, source: "disk", ageSeconds: Math.round((nowMs() - disk.savedAt) / 1000) };
        meta.quota = getQuotaMeta();
        return NextResponse.json({ ok: true, data: disk.data, meta });
      }

      return NextResponse.json(
        { ok: false, error: "Cache-only mode: no cached result for this input key.", meta },
        { status: 404 }
      );
    }

    if (bustCache) {
      meta.warnings?.push("Cache bust enabled; bypassing memory+disk cache.");
    }

    // Normal path (auto or live): try cache first unless bustCache
    if (!bustCache) {
      const mem = RESULT_CACHE.get(cacheKey);
      if (mem) {
        meta.modelUsed = "cache";
        meta.fallbackUsed = "cache";
        meta.cache = { hit: true, key: cacheKey, source: "memory", ageSeconds: Math.round((nowMs() - mem.savedAt) / 1000) };
        meta.quota = getQuotaMeta();
        return NextResponse.json({ ok: true, data: mem.data, meta });
      }

      const disk = await readDiskCache(cacheKey);
      if (disk) {
        RESULT_CACHE.set(cacheKey, disk);
        meta.modelUsed = "cache";
        meta.fallbackUsed = "cache";
        meta.cache = { hit: true, key: cacheKey, source: "disk", ageSeconds: Math.round((nowMs() - disk.savedAt) / 1000) };
        meta.quota = getQuotaMeta();
        return NextResponse.json({ ok: true, data: disk.data, meta });
      }
    }

    // If quota cooldown is active, skip live attempt and go offline immediately.
    meta.quota = getQuotaMeta();
    if (meta.quota.blocked) {
      const offline = offlineAnalyze(rfpText, capabilityText);
      RESULT_CACHE.set(cacheKey, { data: offline, savedAt: nowMs() });
      await writeDiskCache(cacheKey, offline);

      meta.modelUsed = "offline";
      meta.fallbackUsed = "offline";
      meta.warnings?.push(`Quota cooldown active; returned offline deterministic analysis (retryAfter=${meta.quota.retryAfterSeconds}s).`);
      meta.cache = { hit: false, key: cacheKey, source: "none" };
      meta.quota = getQuotaMeta();
      return NextResponse.json({ ok: true, data: offline, meta });
    }

    // Live attempt allowed unless forceMode is explicitly something else
    const allowLive = forceMode === "live" || forceMode === "" || forceMode === "auto";

    if (!allowLive) {
      // Unknown mode string; be safe
      meta.warnings?.push(`Unknown x-matrixmint-mode="${forceMode}". Falling back to offline.`);
      const offline = offlineAnalyze(rfpText, capabilityText);
      RESULT_CACHE.set(cacheKey, { data: offline, savedAt: nowMs() });
      await writeDiskCache(cacheKey, offline);
      meta.modelUsed = "offline";
      meta.fallbackUsed = "offline";
      meta.quota = getQuotaMeta();
      return NextResponse.json({ ok: true, data: offline, meta });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const jsonSchema = z.toJSONSchema(matrixResultSchema);
    const basePrompt = buildPrompt(rfpText, capabilityText);
    const strictPrompt = buildStrictRetryPrompt(basePrompt);

    const attemptModel = async (m: "gemini-3-flash-preview" | "gemini-3-pro-preview") => {
      try {
        const parsed = await generateParseValidate({
          ai,
          model: m,
          prompt: basePrompt,
          jsonSchema,
          thinkingLevel: THINKING_LEVEL,
        });
        return parsed;
      } catch (err: any) {
        if (isQuotaExceededError(err) || isOverloadedError(err)) throw err;

        const parsed2 = await generateParseValidate({
          ai,
          model: m,
          prompt: strictPrompt,
          jsonSchema,
          thinkingLevel: THINKING_LEVEL,
        });
        return parsed2;
      }
    };

    // Live ladder
    try {
      const parsed = await attemptModel(requestedModel);
      const withProof = computeProof(parsed, capabilityText);

      RESULT_CACHE.set(cacheKey, { data: withProof, savedAt: nowMs() });
      await writeDiskCache(cacheKey, withProof);

      meta.modelUsed = requestedModel;
      meta.fallbackUsed = "none";
      meta.cache = { hit: false, key: cacheKey, source: "none" };
      meta.quota = getQuotaMeta();
      return NextResponse.json({ ok: true, data: withProof, meta });
    } catch (err: any) {
      // Pro quota => Flash
      if (requestedModel === "gemini-3-pro-preview" && isQuotaExceededError(err)) {
        meta.warnings?.push("Pro quota unavailable; attempting Flash.");
        try {
          const parsed = await attemptModel("gemini-3-flash-preview");
          const withProof = computeProof(parsed, capabilityText);

          RESULT_CACHE.set(cacheKey, { data: withProof, savedAt: nowMs() });
          await writeDiskCache(cacheKey, withProof);

          meta.modelUsed = "gemini-3-flash-preview";
          meta.fallbackUsed = "flash";
          meta.quota = getQuotaMeta();
          return NextResponse.json({ ok: true, data: withProof, meta });
        } catch (err2: any) {
          err = err2;
          meta.warnings?.push("Flash also blocked; falling back to offline.");
        }
      }

      // Any quota => offline
      if (isQuotaExceededError(err)) {
        const offline = offlineAnalyze(rfpText, capabilityText);

        RESULT_CACHE.set(cacheKey, { data: offline, savedAt: nowMs() });
        await writeDiskCache(cacheKey, offline);

        meta.modelUsed = "offline";
        meta.fallbackUsed = "offline";
        meta.warnings?.push("Quota exceeded; returned offline deterministic analysis (conservative).");
        meta.quota = getQuotaMeta();

        return NextResponse.json({ ok: true, data: offline, meta });
      }

      // Overload => try other model then offline
      if (isOverloadedError(err)) {
        const fallback =
          requestedModel === "gemini-3-flash-preview" ? "gemini-3-pro-preview" : "gemini-3-flash-preview";
        meta.warnings?.push(`${requestedModel} overloaded; attempting ${fallback}.`);

        try {
          const parsed = await attemptModel(fallback);
          const withProof = computeProof(parsed, capabilityText);

          RESULT_CACHE.set(cacheKey, { data: withProof, savedAt: nowMs() });
          await writeDiskCache(cacheKey, withProof);

          meta.modelUsed = fallback;
          meta.fallbackUsed = requestedModel === "gemini-3-pro-preview" ? "flash" : "none";
          meta.quota = getQuotaMeta();
          return NextResponse.json({ ok: true, data: withProof, meta });
        } catch {
          const offline = offlineAnalyze(rfpText, capabilityText);

          RESULT_CACHE.set(cacheKey, { data: offline, savedAt: nowMs() });
          await writeDiskCache(cacheKey, offline);

          meta.modelUsed = "offline";
          meta.fallbackUsed = "offline";
          meta.warnings?.push("Fallback failed; returned offline deterministic analysis.");
          meta.quota = getQuotaMeta();
          return NextResponse.json({ ok: true, data: offline, meta });
        }
      }

      const msg = String(err?.message ?? "Unknown error");
      meta.quota = getQuotaMeta();
      return NextResponse.json({ ok: false, error: msg, meta }, { status: 500 });
    }
  } catch (err: any) {
    const msg = String(err?.message ?? "Unknown error");
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
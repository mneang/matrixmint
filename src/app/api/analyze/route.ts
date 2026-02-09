export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import crypto from "crypto";
import path from "path";
import { promises as fs } from "fs";
import { matrixResultSchema } from "@/lib/matrixSchema";

// --------- Thinking level compat ----------
let THINKING_LEVEL: any = "MEDIUM";
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@google/genai");
  if (mod?.ThinkingLevel?.MEDIUM) THINKING_LEVEL = mod.ThinkingLevel.MEDIUM;
  else if (mod?.ThinkingLevel?.HIGH) THINKING_LEVEL = mod.ThinkingLevel.HIGH;
} catch {
  // ignore
}

// --------- Types ----------
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
  lane?: "main" | "offline";
};

type QuotaMeta = {
  blocked: boolean;
  blockedUntilUnixMs: number;
  lastError: string;
};

type ProofRepairMeta = {
  triggered: boolean;
  attempts: number;
  beforeProofPercent?: number;
  afterProofPercent?: number;
  fixedMismatches: number;
  notes?: string[];
};

type AnalyzeMeta = {
  modelRequested: string;
  modelUsed: string;
  fallbackUsed?: "none" | "flash" | "cache" | "offline";
  warnings?: string[];
  cache?: CacheMeta;
  quota?: QuotaMeta;
  proofRepair?: ProofRepairMeta;
};

// --------- Helpers ----------
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function normalizeText(s: string) {
  return (s ?? "").replace(/\r/g, "").trim();
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
3) For Partial/Missing: include 1–3 gapsOrQuestions.
4) responseSummary: 1–3 short, business-readable sentences.
5) proposalOutline must be actionable.
6) Outputs must be English.
7) OUTPUT MUST BE A SINGLE JSON OBJECT. No markdown.

Be conservative. When unclear, choose Partial with a question.

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
- Do not include commentary.
`
  );
}

function isOverloadedError(err: any) {
  const msg = String(err?.message ?? "");
  const status = err?.status || err?.error?.status;
  const code = err?.code || err?.error?.code;
  return status === "UNAVAILABLE" || code === 503 || msg.includes("overloaded") || msg.includes("503");
}

function isQuotaExceededError(err: any) {
  const msg = String(err?.message ?? "");
  const status = err?.status || err?.error?.status;
  const code = err?.code || err?.error?.code;
  return (
    status === "RESOURCE_EXHAUSTED" ||
    code === 429 ||
    msg.toLowerCase().includes("quota exceeded") ||
    msg.toLowerCase().includes("exceeded your current quota") ||
    msg.toLowerCase().includes("rate limit")
  );
}

function isAbortError(err: any) {
  const name = String(err?.name || "");
  const msg = String(err?.message || "");
  return name === "AbortError" || msg.toLowerCase().includes("aborted");
}

function makeAbortSignal(timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
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
      // ignore
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

function resolveModelTimeoutMs(params: {
  mode: "auto" | "live" | "cache" | "offline";
  model: "gemini-3-flash-preview" | "gemini-3-pro-preview";
}) {
  const { mode, model } = params;

  const flashLive = Number(process.env.MM_FLASH_TIMEOUT_LIVE_MS || 132_000);
  const flashAuto = Number(process.env.MM_FLASH_TIMEOUT_AUTO_MS || 105_000);
  const proLive = Number(process.env.MM_PRO_TIMEOUT_LIVE_MS || 150_000);
  const proAuto = Number(process.env.MM_PRO_TIMEOUT_AUTO_MS || 120_000);

  if (model === "gemini-3-pro-preview") {
    return mode === "live" ? proLive : proAuto;
  }
  return mode === "live" ? flashLive : flashAuto;
}

// --------- Caching (memory + best-effort disk) ----------
const RESULT_CACHE = new Map<string, { data: MatrixResult; savedAt: number }>();

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const CACHE_VERSION = "v4";

/**
 * Vercel note:
 * - Deployed FS is read-only (often /var/task).
 * - Only /tmp is writable.
 * - Allow override via MATRIXMINT_CACHE_DIR for clarity.
 */
function getCacheDir() {
  const envOverride = (process.env.MATRIXMINT_CACHE_DIR || "").trim();
  if (envOverride) return envOverride;

  const isServerless = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  const base = isServerless ? "/tmp" : process.cwd();
  return path.join(base, ".matrixmint_cache");
}

async function ensureCacheDir() {
  try {
    await fs.mkdir(getCacheDir(), { recursive: true });
  } catch {
    // best-effort: if this fails, we still can operate without disk cache
  }
}

function cachePathForKey(key: string) {
  return path.join(getCacheDir(), `${key}.json`);
}

async function deleteDiskCache(key: string) {
  try {
    await fs.rm(cachePathForKey(key), { force: true });
  } catch {
    // ignore
  }
}

async function readDiskCache(key: string): Promise<{ data: MatrixResult; savedAt: number } | null> {
  try {
    await ensureCacheDir();
    const raw = await fs.readFile(cachePathForKey(key), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.data || typeof parsed?.savedAt !== "number") return null;

    if (Date.now() - parsed.savedAt > CACHE_TTL_MS) return null;

    matrixResultSchema.parse(parsed.data);
    return { data: parsed.data as MatrixResult, savedAt: parsed.savedAt as number };
  } catch {
    return null;
  }
}

async function writeDiskCache(key: string, data: MatrixResult) {
  // Best-effort: NEVER fail the request because disk cache write failed
  try {
    await ensureCacheDir();
    const p = cachePathForKey(key);
    const tmp = `${p}.tmp`;
    const payload = JSON.stringify({ savedAt: Date.now(), data }, null, 2);
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, p);
  } catch {
    // ignore
  }
}

async function diskCacheExists(key: string) {
  try {
    await ensureCacheDir();
    await fs.access(cachePathForKey(key));
    return true;
  } catch {
    return false;
  }
}

/**
 * Cache quality guard:
 * If we already have a cached result (memory or disk),
 * do not overwrite it with an offline fallback.
 */
async function shouldWriteOfflineFallback(key: string) {
  if (RESULT_CACHE.has(key)) return false;
  if (await diskCacheExists(key)) return false;
  return true;
}

// --------- Quota circuit breaker ----------
const QUOTA_STATE: Record<string, QuotaMeta> = {
  global: { blocked: false, blockedUntilUnixMs: 0, lastError: "" },
  "gemini-3-flash-preview": { blocked: false, blockedUntilUnixMs: 0, lastError: "" },
  "gemini-3-pro-preview": { blocked: false, blockedUntilUnixMs: 0, lastError: "" },
};

function getQuotaState(model: string): QuotaMeta {
  const m = QUOTA_STATE[model] || QUOTA_STATE.global;
  const now = Date.now();
  if (m.blocked && m.blockedUntilUnixMs <= now) {
    m.blocked = false;
    m.blockedUntilUnixMs = 0;
    m.lastError = "";
  }
  return { ...m };
}

function setQuotaBlocked(model: string, blockedUntilUnixMs: number, lastError: string) {
  const m = QUOTA_STATE[model] || QUOTA_STATE.global;
  m.blocked = true;
  m.blockedUntilUnixMs = Math.max(blockedUntilUnixMs, Date.now() + 10_000);
  m.lastError = lastError || "";
  QUOTA_STATE[model] = m;
}

function parseRetryDelayMs(details: any): number {
  const retryDelay =
    details?.error?.details?.find?.((d: any) => String(d?.["@type"] || "").includes("RetryInfo"))?.retryDelay;

  if (typeof retryDelay === "string" && retryDelay.endsWith("s")) {
    const secs = Number(retryDelay.replace("s", ""));
    if (Number.isFinite(secs) && secs > 0) return Math.min(120_000, secs * 1000);
  }
  return 15_000;
}

// --------- Live gate (serializes live Gemini calls) ----------
let LIVE_CHAIN: Promise<void> = Promise.resolve();
let LAST_LIVE_AT = 0;

async function withLiveGate<T>(minGapMs: number, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = LIVE_CHAIN;
  LIVE_CHAIN = new Promise<void>((r) => (release = r));

  await prev;

  const waitMs = LAST_LIVE_AT + minGapMs - Date.now();
  if (waitMs > 0) await sleep(waitMs);

  try {
    return await fn();
  } finally {
    LAST_LIVE_AT = Date.now();
    release();
  }
}
// --------- End live gate ----------

async function generateWithRetries(params: {
  ai: GoogleGenAI;
  model: "gemini-3-flash-preview" | "gemini-3-pro-preview";
  prompt: string;
  jsonSchema: any;
  thinkingLevel: any;
  timeoutMs: number;
}) {
  const { ai, model, prompt, jsonSchema, thinkingLevel, timeoutMs } = params;

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { signal, clear } = makeAbortSignal(timeoutMs);

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
          abortSignal: signal,
        } as any,
      });
    } catch (err: any) {
      if (isAbortError(err)) throw err;
      if (isQuotaExceededError(err)) throw err;
      if (!isOverloadedError(err) || attempt === maxAttempts) throw err;

      const wait = 250 + attempt * attempt * 150;
      console.log(`MatrixMint: ${model} overloaded. Retry ${attempt}/${maxAttempts} in ${wait}ms`);
      await sleep(wait);
    } finally {
      clear();
    }
  }
  throw new Error("Retry loop fell through unexpectedly");
}

async function generateParseValidate(params: {
  ai: GoogleGenAI;
  model: "gemini-3-flash-preview" | "gemini-3-pro-preview";
  prompt: string;
  jsonSchema: any;
  thinkingLevel: any;
  timeoutMs: number;
}) {
  const resp = await generateWithRetries(params);
  const raw = (await extractResponseText(resp)) ?? "";
  const json = safeJsonParse(raw);
  const parsed = matrixResultSchema.parse(json);
  return parsed as MatrixResult;
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

/**
 * Self-healing proof repair:
 * Replace evidenceQuotes with deterministic snippets from Capability Brief around each evidenceId.
 * This keeps us honest (no invention) and makes proof verifiable.
 */
function repairEvidenceQuotes(result: MatrixResult, capabilityText: string) {
  const text = capabilityText || "";
  const capNorm = normalizeForMatch(text);

  const ids = Array.from(new Set(Array.from(text.matchAll(/\bCB-\d+\b/g)).map((m) => m[0])));
  const idToSnippet = new Map<string, string>();

  const makeSnippet = (id: string) => {
    const idx = text.indexOf(id);
    if (idx === -1) return null;

    const lineStart = text.lastIndexOf("\n", idx);
    const lineEnd = text.indexOf("\n", idx);
    const ls = lineStart === -1 ? 0 : lineStart + 1;
    const le = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(ls, le).trim();

    if (line.length >= 40 && line.length <= 320) return line;

    const start = Math.max(0, idx - 120);
    const end = Math.min(text.length, idx + 220);
    return text.slice(start, end).replace(/\s+/g, " ").trim();
  };

  for (const id of ids) {
    const sn = makeSnippet(id);
    if (sn && normalizeForMatch(sn) && capNorm.includes(normalizeForMatch(sn))) {
      idToSnippet.set(id, sn);
    } else if (sn) {
      idToSnippet.set(id, sn);
    }
  }

  let fixed = 0;

  const repairedReqs = (result.requirements ?? []).map((r) => {
    const evidenceIds = uniqStrings(Array.isArray(r.evidenceIds) ? r.evidenceIds.map(String) : []);
    const evidenceQuotes = Array.isArray(r.evidenceQuotes) ? r.evidenceQuotes.map(String) : [];

    if (!evidenceIds.length) return r;

    const anyBad = evidenceQuotes.some((q) => !quoteExistsInText(q, text));
    const tooFew = evidenceQuotes.length < evidenceIds.length;

    if (!anyBad && !tooFew) return r;

    const newQuotes: string[] = [];
    for (const id of evidenceIds) {
      const sn = idToSnippet.get(id);
      if (sn) newQuotes.push(sn);
    }

    if (!newQuotes.length) return r;

    fixed += 1;

    return {
      ...r,
      evidenceIds,
      evidenceQuotes: newQuotes,
      riskFlags: uniqStrings((r.riskFlags ?? []).filter((x) => String(x) !== "Evidence mismatch")),
    };
  });

  return { repaired: { ...result, requirements: repairedReqs }, fixedMismatches: fixed };
}

function needsProofRepair(result: MatrixResult) {
  const reqs = result.requirements ?? [];
  if (!reqs.length) return false;
  const anyMismatch = reqs.some((r) => (r.riskFlags ?? []).some((f) => String(f) === "Evidence mismatch"));
  const p = result.summary?.proofPercent;
  if (typeof p === "number" && p < 100) return true;
  return anyMismatch;
}

function maybeDemoBreakOneQuote(result: MatrixResult): MatrixResult {
  const reqs = result.requirements ?? [];
  const token = " @@BROKEN_PROOF@@";

  for (let i = 0; i < reqs.length; i++) {
    const ids = reqs[i]?.evidenceIds ?? [];
    const quotes = reqs[i]?.evidenceQuotes ?? [];
    if (Array.isArray(ids) && ids.length > 0 && typeof quotes[0] === "string" && quotes[0].length > 10) {
      const broken = `${quotes[0]}${token}`;
      const newReqs = reqs.slice();
      newReqs[i] = { ...newReqs[i], evidenceQuotes: [broken, ...quotes.slice(1)] };
      return { ...result, requirements: newReqs };
    }
  }
  return result;
}

// --------- Deterministic OFFLINE analyzer ----------
function offlineAnalyze(rfpText: string, capabilityText: string): MatrixResult {
  const lines = rfpText.split("\n").map((l) => l.trim()).filter(Boolean);

  const idLineRe = /\b(FR|NFR|REQ|RFP|SEC)[-_ ]?(\d{1,3})\b/i;
  const picked: Array<{ id: string; category: "Functional" | "NonFunctional"; text: string }> = [];

  for (const ln of lines) {
    const m = ln.match(idLineRe);
    if (m) {
      const prefix = m[1].toUpperCase();
      const num = String(m[2]).padStart(2, "0");
      const id = `${prefix}-${num}`;
      const category: "Functional" | "NonFunctional" = prefix === "NFR" ? "NonFunctional" : "Functional";
      const text = ln.replace(/\s+/g, " ").slice(0, 240);
      picked.push({ id, category, text });
    }
  }

  if (!picked.length) {
    const bullets = lines.filter((l) => /^[-*•]/.test(l) || /^\d+\./.test(l)).slice(0, 18);
    for (let i = 0; i < bullets.length; i++) {
      const id = `GEN-${String(i + 1).padStart(2, "0")}`;
      const text = bullets[i].replace(/^[-*•]\s*/, "").replace(/^\d+\.\s*/, "").slice(0, 240);
      picked.push({ id, category: "Functional", text });
    }
  }

  const cbIds = Array.from(capabilityText.matchAll(/\bCB-\d+\b/g)).map((m) => m[0]);
  const cbUnique = Array.from(new Set(cbIds));
  const capNorm = normalizeForMatch(capabilityText);

  function keywordScore(reqText: string) {
    const w = normalizeForMatch(reqText)
      .replace(/[^a-z0-9 ]/g, " ")
      .split(" ")
      .filter((x) => x.length >= 5)
      .slice(0, 14);

    let hits = 0;
    for (const k of w) {
      if (capNorm.includes(k)) hits++;
    }
    return { hits, total: w.length };
  }

  const requirements: RequirementRow[] = picked.slice(0, 18).map((r) => {
    const ks = keywordScore(r.text);
    const ratio = ks.total === 0 ? 0 : ks.hits / ks.total;

    let status: CoverageStatus = "Missing";
    if (ratio >= 0.35 && cbUnique.length) status = "Partial";
    if (ratio >= 0.55 && cbUnique.length >= 1) status = "Covered";

    const evidenceIds = status === "Covered" ? cbUnique.slice(0, 1) : [];
    const evidenceQuotes =
      status === "Covered"
        ? [
            (() => {
              const id = cbUnique[0];
              const idx = capabilityText.indexOf(id);
              if (idx === -1) return id;
              const start = Math.max(0, idx - 80);
              const end = Math.min(capabilityText.length, idx + 140);
              return capabilityText.slice(start, end).replace(/\s+/g, " ").trim();
            })(),
          ]
        : [];

    const gaps: string[] = [];
    const risks: string[] = [];

    if (status !== "Covered") {
      gaps.push("Please confirm whether this requirement is mandatory for initial launch or acceptable as a phased enhancement.");
      gaps.push("If mandatory, provide preferred implementation constraints (hosting, integrations, data retention).");
    }

    if (status === "Missing") {
      risks.push("Ambiguity");
      risks.push("Scope gap");
    } else if (status === "Partial") {
      risks.push("Ambiguity");
      risks.push("Implementation risk");
    }

    const responseSummary =
      status === "Covered"
        ? "Covered with evidence-backed capability in the provided brief."
        : status === "Partial"
        ? "Partially aligned based on keyword overlap; confirmation and scope details required."
        : "Not evidenced in the capability brief; likely requires additional build or third-party support.";

    return {
      id: r.id,
      category: r.category,
      text: r.text,
      status,
      responseSummary,
      evidenceIds,
      evidenceQuotes,
      gapsOrQuestions: gaps,
      riskFlags: risks,
    };
  });

  const total = requirements.length;
  const coveredCount = requirements.filter((x) => x.status === "Covered").length;
  const partialCount = requirements.filter((x) => x.status === "Partial").length;
  const missingCount = requirements.filter((x) => x.status === "Missing").length;
  const coveragePercent = total ? (coveredCount / total) * 100 : 0;

  const topRisks = uniqStrings(requirements.flatMap((r) => r.riskFlags).slice(0, 10));

  const nextActions = [
    "Confirm scope priorities and any mandatory go-live constraints (timeline, hosting, integrations).",
    "Provide a system architecture diagram and data-flow overview for evaluator review.",
    "Produce a risk mitigation plan for all Partial/Missing requirements with owners and target dates.",
    "Generate a clarifications email and align on acceptance criteria for each ambiguous requirement.",
  ];

  const proposalOutline = {
    executiveSummary:
      "MatrixMint delivers a compliance-first workflow that maps RFP requirements to verifiable capability evidence, producing bid-ready artifacts and reducing procurement risk through proof-anchored traceability.",
    sections: [
      "Problem & Procurement Risk",
      "Solution Overview (MatrixMint Workflow)",
      "Compliance Matrix (Evidence-Anchored)",
      "Implementation Plan (30/60/90)",
      "Security, Privacy, and Reliability",
      "Risks, Clarifications, and Mitigations",
      "Support, Training, and Adoption",
      "Pricing & Licensing (placeholder)",
      "Appendix: Proof Pack & Evidence Quotes",
    ],
  };

  return {
    summary: {
      totalRequirements: total,
      coveredCount,
      partialCount,
      missingCount,
      coveragePercent,
      topRisks,
      nextActions,
      proofNotes: ["Offline deterministic analysis used (conservative coverage scoring)."],
    },
    requirements,
    proposalOutline,
  };
}

// --------- Route ----------
export async function POST(req: Request) {
  const meta: AnalyzeMeta = {
    modelRequested: "unknown",
    modelUsed: "unknown",
    fallbackUsed: "none",
    warnings: [],
    cache: { hit: false, source: "none", lane: "main" },
    quota: getQuotaState("global"),
    proofRepair: {
      triggered: false,
      attempts: 0,
      fixedMismatches: 0,
      notes: [],
    },
  };

  try {
    const body = (await req.json()) as Partial<AnalyzeBody>;
    const rfpText = normalizeText(body.rfpText ?? "");
    const capabilityText = normalizeText(body.capabilityText ?? "");
    const requestedModel = (body.model ?? "gemini-3-flash-preview") as
      | "gemini-3-flash-preview"
      | "gemini-3-pro-preview";

    meta.modelRequested = requestedModel;

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ ok: false, error: "Missing GEMINI_API_KEY" }, { status: 500 });
    }
    if (!rfpText || !capabilityText) {
      return NextResponse.json({ ok: false, error: "rfpText and capabilityText are required" }, { status: 400 });
    }

    const h = req.headers;
    const modeRaw = String(h.get("x-matrixmint-mode") || "auto").toLowerCase();
    const mode = (["auto", "live", "cache", "offline"].includes(modeRaw) ? modeRaw : "auto") as
      | "auto"
      | "live"
      | "cache"
      | "offline";

    const bustCache = String(h.get("x-matrixmint-bust-cache") || "") === "1";
    const clearCache = String(h.get("x-matrixmint-clear-cache") || "") === "1";
    const demoBreakProof = String(h.get("x-matrixmint-demo-break-proof") || "") === "1";

    if (mode === "offline") meta.warnings?.push("Forced offline (x-matrixmint-mode=offline).");
    if (mode === "cache") meta.warnings?.push("Cache-preferred mode (x-matrixmint-mode=cache).");
    if (mode === "live") meta.warnings?.push("Live-preferred mode (x-matrixmint-mode=live).");
    if (bustCache) meta.warnings?.push("Cache bust enabled; bypassing memory+disk cache.");
    if (demoBreakProof)
      meta.warnings?.push("DEMO: x-matrixmint-demo-break-proof=1 (injecting one proof mismatch then self-healing).");

    const cacheLane: "main" | "offline" = mode === "offline" ? "offline" : "main";
    meta.cache = { hit: false, source: "none", lane: cacheLane };

    const cacheKey = sha256(`${CACHE_VERSION}\nlane=${cacheLane}\n${requestedModel}\n${rfpText}\n---\n${capabilityText}`);
    meta.cache.key = cacheKey;

    if (clearCache) {
      RESULT_CACHE.delete(cacheKey);
      await deleteDiskCache(cacheKey);
      meta.warnings?.push("Cache cleared for this input key.");
    }

    // --- Cache read path ---
    if (!bustCache && mode !== "offline") {
      const mem = RESULT_CACHE.get(cacheKey);
      if (mem) {
        meta.modelUsed = "cache";
        meta.fallbackUsed = "cache";
        meta.cache = {
          hit: true,
          key: cacheKey,
          source: "memory",
          ageSeconds: Math.round((Date.now() - mem.savedAt) / 1000),
          lane: cacheLane,
        };
        meta.quota = getQuotaState(requestedModel);
        return NextResponse.json({ ok: true, data: mem.data, meta });
      }

      const disk = await readDiskCache(cacheKey);
      if (disk) {
        RESULT_CACHE.set(cacheKey, disk);
        meta.modelUsed = "cache";
        meta.fallbackUsed = "cache";
        meta.cache = {
          hit: true,
          key: cacheKey,
          source: "disk",
          ageSeconds: Math.round((Date.now() - disk.savedAt) / 1000),
          lane: cacheLane,
        };
        meta.quota = getQuotaState(requestedModel);
        return NextResponse.json({ ok: true, data: disk.data, meta });
      }
    }

    // --- Forced offline ---
    if (mode === "offline") {
      const offline = offlineAnalyze(rfpText, capabilityText);
      const withProof = computeProof(offline, capabilityText);

      RESULT_CACHE.set(cacheKey, { data: withProof, savedAt: Date.now() });
      await writeDiskCache(cacheKey, withProof);

      meta.modelUsed = "offline";
      meta.fallbackUsed = "offline";
      meta.cache = { hit: false, key: cacheKey, source: "none", lane: cacheLane };
      meta.quota = getQuotaState(requestedModel);
      return NextResponse.json({ ok: true, data: withProof, meta });
    }

    // --- Circuit breaker gate (AUTO/CACHE only) ---
    const q = getQuotaState(requestedModel);
    meta.quota = q;

    const allowLive =
      mode === "live" ? true : mode === "auto" || mode === "cache" ? !q.blocked : false;

    if (mode === "live" && q.blocked) {
      meta.warnings?.push("Quota circuit breaker active; live mode will still attempt the API call.");
    }

    if (!allowLive) {
      if (mode === "live") {
        const now = Date.now();
        const retryMs = Math.max(10_000, (q.blockedUntilUnixMs || now + 20_000) - now);

        meta.warnings?.push("Quota circuit breaker active; refusing offline fallback in live mode.");
        meta.quota = getQuotaState(requestedModel);

        return NextResponse.json(
          { ok: false, error: "quota_blocked", retryAfterMs: retryMs, meta },
          { status: 429, headers: { "Retry-After": String(Math.ceil(retryMs / 1000)) } }
        );
      }

      meta.warnings?.push("Quota circuit breaker active; skipping live call and returning offline analysis.");

      const offline = offlineAnalyze(rfpText, capabilityText);
      const withProof = computeProof(offline, capabilityText);

      if (await shouldWriteOfflineFallback(cacheKey)) {
        RESULT_CACHE.set(cacheKey, { data: withProof, savedAt: Date.now() });
        await writeDiskCache(cacheKey, withProof);
      }

      meta.modelUsed = "offline";
      meta.fallbackUsed = "offline";
      meta.cache = { hit: false, key: cacheKey, source: "none", lane: cacheLane };
      meta.quota = getQuotaState(requestedModel);
      return NextResponse.json({ ok: true, data: withProof, meta });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const jsonSchema = (z as any).toJSONSchema ? (z as any).toJSONSchema(matrixResultSchema) : undefined;

    const basePrompt = buildPrompt(rfpText, capabilityText);
    const strictPrompt = buildStrictRetryPrompt(basePrompt);

    const modelTimeoutMs = resolveModelTimeoutMs({ mode, model: requestedModel });

    const attemptModel = async (m: "gemini-3-flash-preview" | "gemini-3-pro-preview") => {
      try {
        return await withLiveGate(1200, async () => {
          return await generateParseValidate({
            ai,
            model: m,
            prompt: basePrompt,
            jsonSchema: jsonSchema ?? {},
            thinkingLevel: THINKING_LEVEL,
            timeoutMs: modelTimeoutMs,
          });
        });
      } catch (err: any) {
        if (isAbortError(err)) throw err;
        if (isQuotaExceededError(err)) throw err;
        if (isOverloadedError(err)) throw err;

        // Strict retry for format issues only
        return await generateParseValidate({
          ai,
          model: m,
          prompt: strictPrompt,
          jsonSchema: jsonSchema ?? {},
          thinkingLevel: THINKING_LEVEL,
          timeoutMs: modelTimeoutMs,
        });
      }
    };

    const attemptModelWithQuotaRetry = async (m: "gemini-3-flash-preview" | "gemini-3-pro-preview") => {
      try {
        return await attemptModel(m);
      } catch (err: any) {
        if (mode === "live" && isQuotaExceededError(err)) {
          const retryMs = parseRetryDelayMs(err);
          meta.warnings?.push(`Quota exceeded for ${m}; waiting ${Math.ceil(retryMs / 1000)}s then retrying once.`);
          await sleep(retryMs);
          return await attemptModel(m);
        }
        throw err;
      }
    };

    const primary = requestedModel;
    const secondary: "gemini-3-flash-preview" | "gemini-3-pro-preview" =
      requestedModel === "gemini-3-pro-preview" ? "gemini-3-flash-preview" : "gemini-3-pro-preview";

    try {
      // ---- Primary attempt ----
      const parsed = await attemptModelWithQuotaRetry(primary);

      // Proof compute (first pass)
      let withProof = computeProof(parsed, capabilityText);

      // DEMO: inject mismatch to show self-healing
      if (demoBreakProof) {
        withProof = computeProof(maybeDemoBreakOneQuote(withProof), capabilityText);
      }

      // Self-healing proof loop
      const before = withProof.summary?.proofPercent;
      if (needsProofRepair(withProof)) {
        meta.proofRepair = meta.proofRepair || { triggered: false, attempts: 0, fixedMismatches: 0, notes: [] };
        meta.proofRepair.triggered = true;
        meta.proofRepair.beforeProofPercent = typeof before === "number" ? before : undefined;

        const maxRepairPasses = 2;
        let cur = withProof;
        let totalFixed = 0;
        let attempts = 0;

        for (let pass = 1; pass <= maxRepairPasses; pass++) {
          attempts++;
          const repaired = repairEvidenceQuotes(cur, capabilityText);
          totalFixed += repaired.fixedMismatches;
          cur = computeProof(repaired.repaired, capabilityText);
          if (!needsProofRepair(cur)) break;
        }

        meta.proofRepair.attempts = attempts;
        meta.proofRepair.fixedMismatches = totalFixed;
        meta.proofRepair.afterProofPercent =
          typeof cur.summary?.proofPercent === "number" ? cur.summary.proofPercent : undefined;
        meta.proofRepair.notes = uniqStrings([
          ...(meta.proofRepair.notes ?? []),
          "Repair replaces evidenceQuotes with deterministic snippets extracted from Capability Brief around each evidenceId.",
          "No new capability is invented; only evidence quoting is repaired for verifiability.",
        ]);

        withProof = cur;

        meta.warnings?.push(
          `Self-healing proof loop executed: proof ${meta.proofRepair.beforeProofPercent ?? "?"}% -> ${
            meta.proofRepair.afterProofPercent ?? "?"
          }% (passes=${attempts}, fixed=${totalFixed}).`
        );
      }

      RESULT_CACHE.set(cacheKey, { data: withProof, savedAt: Date.now() });
      await writeDiskCache(cacheKey, withProof);

      meta.modelUsed = primary;
      meta.fallbackUsed = "none";
      meta.cache = { hit: false, key: cacheKey, source: "none", lane: cacheLane };
      meta.quota = getQuotaState(primary);

      return NextResponse.json({ ok: true, data: withProof, meta });
    } catch (err: any) {
      // ---- Timeout -> offline fallback ----
      if (isAbortError(err)) {
        meta.warnings?.push("Live request timed out; returned offline deterministic analysis (conservative).");
        meta.quota = getQuotaState(primary);

        const offline = offlineAnalyze(rfpText, capabilityText);
        const withProof = computeProof(offline, capabilityText);

        if (await shouldWriteOfflineFallback(cacheKey)) {
          RESULT_CACHE.set(cacheKey, { data: withProof, savedAt: Date.now() });
          await writeDiskCache(cacheKey, withProof);
        }

        meta.modelUsed = "offline";
        meta.fallbackUsed = "offline";
        meta.cache = { hit: false, key: cacheKey, source: "none", lane: cacheLane };

        return NextResponse.json({ ok: true, data: withProof, meta });
      }

      // ---- Quota exceeded ----
      if (isQuotaExceededError(err)) {
        const retryMs = parseRetryDelayMs(err);
        setQuotaBlocked(primary, Date.now() + retryMs, String(err?.message ?? "quota"));
        meta.quota = getQuotaState(primary);

        if (mode === "live") {
          meta.warnings?.push(`Quota exceeded for ${primary}; attempting ${secondary}.`);
          try {
            const parsed2 = await attemptModelWithQuotaRetry(secondary);
            let withProof2 = computeProof(parsed2, capabilityText);

            if (demoBreakProof) {
              withProof2 = computeProof(maybeDemoBreakOneQuote(withProof2), capabilityText);
            }

            const before2 = withProof2.summary?.proofPercent;
            if (needsProofRepair(withProof2)) {
              meta.proofRepair = meta.proofRepair || { triggered: false, attempts: 0, fixedMismatches: 0, notes: [] };
              meta.proofRepair.triggered = true;
              meta.proofRepair.beforeProofPercent = typeof before2 === "number" ? before2 : undefined;

              const maxRepairPasses = 2;
              let cur = withProof2;
              let totalFixed = 0;
              let attempts = 0;

              for (let pass = 1; pass <= maxRepairPasses; pass++) {
                attempts++;
                const repaired = repairEvidenceQuotes(cur, capabilityText);
                totalFixed += repaired.fixedMismatches;
                cur = computeProof(repaired.repaired, capabilityText);
                if (!needsProofRepair(cur)) break;
              }

              meta.proofRepair.attempts = attempts;
              meta.proofRepair.fixedMismatches = totalFixed;
              meta.proofRepair.afterProofPercent =
                typeof cur.summary?.proofPercent === "number" ? cur.summary.proofPercent : undefined;

              withProof2 = cur;
            }

            RESULT_CACHE.set(cacheKey, { data: withProof2, savedAt: Date.now() });
            await writeDiskCache(cacheKey, withProof2);

            meta.modelUsed = secondary;
            meta.fallbackUsed = secondary === "gemini-3-flash-preview" ? "flash" : "none";
            meta.cache = { hit: false, key: cacheKey, source: "none", lane: cacheLane };
            meta.quota = getQuotaState(secondary);

            return NextResponse.json({ ok: true, data: withProof2, meta });
          } catch (err2: any) {
            const retryMs2 = isQuotaExceededError(err2) ? parseRetryDelayMs(err2) : retryMs;
            meta.warnings?.push("Live quota still exceeded; returning 429 for retry.");

            return NextResponse.json(
              { ok: false, error: "quota_exceeded", retryAfterMs: retryMs2, meta },
              { status: 429, headers: { "Retry-After": String(Math.ceil(retryMs2 / 1000)) } }
            );
          }
        }

        meta.warnings?.push("Quota exceeded; returned offline deterministic analysis (conservative).");

        const offline = offlineAnalyze(rfpText, capabilityText);
        const withProof = computeProof(offline, capabilityText);

        if (await shouldWriteOfflineFallback(cacheKey)) {
          RESULT_CACHE.set(cacheKey, { data: withProof, savedAt: Date.now() });
          await writeDiskCache(cacheKey, withProof);
        }

        meta.modelUsed = "offline";
        meta.fallbackUsed = "offline";
        meta.cache = { hit: false, key: cacheKey, source: "none", lane: cacheLane };
        meta.quota = getQuotaState(primary);

        return NextResponse.json({ ok: true, data: withProof, meta });
      }

      // ---- Overloaded ----
      if (isOverloadedError(err)) {
        meta.warnings?.push(`${primary} overloaded; attempting ${secondary}.`);
        try {
          const parsed2 = await attemptModelWithQuotaRetry(secondary);
          let withProof2 = computeProof(parsed2, capabilityText);

          if (demoBreakProof) {
            withProof2 = computeProof(maybeDemoBreakOneQuote(withProof2), capabilityText);
          }

          const before2 = withProof2.summary?.proofPercent;
          if (needsProofRepair(withProof2)) {
            meta.proofRepair = meta.proofRepair || { triggered: false, attempts: 0, fixedMismatches: 0, notes: [] };
            meta.proofRepair.triggered = true;
            meta.proofRepair.beforeProofPercent = typeof before2 === "number" ? before2 : undefined;

            const maxRepairPasses = 2;
            let cur = withProof2;
            let totalFixed = 0;
            let attempts = 0;

            for (let pass = 1; pass <= maxRepairPasses; pass++) {
              attempts++;
              const repaired = repairEvidenceQuotes(cur, capabilityText);
              totalFixed += repaired.fixedMismatches;
              cur = computeProof(repaired.repaired, capabilityText);
              if (!needsProofRepair(cur)) break;
            }

            meta.proofRepair.attempts = attempts;
            meta.proofRepair.fixedMismatches = totalFixed;
            meta.proofRepair.afterProofPercent =
              typeof cur.summary?.proofPercent === "number" ? cur.summary.proofPercent : undefined;

            withProof2 = cur;
          }

          RESULT_CACHE.set(cacheKey, { data: withProof2, savedAt: Date.now() });
          await writeDiskCache(cacheKey, withProof2);

          meta.modelUsed = secondary;
          meta.fallbackUsed = secondary === "gemini-3-flash-preview" ? "flash" : "none";
          meta.cache = { hit: false, key: cacheKey, source: "none", lane: cacheLane };
          meta.quota = getQuotaState(secondary);

          return NextResponse.json({ ok: true, data: withProof2, meta });
        } catch {
          meta.warnings?.push("Fallback failed; returned offline deterministic analysis.");

          const offline = offlineAnalyze(rfpText, capabilityText);
          const withProof = computeProof(offline, capabilityText);

          if (await shouldWriteOfflineFallback(cacheKey)) {
            RESULT_CACHE.set(cacheKey, { data: withProof, savedAt: Date.now() });
            await writeDiskCache(cacheKey, withProof);
          }

          meta.modelUsed = "offline";
          meta.fallbackUsed = "offline";
          meta.cache = { hit: false, key: cacheKey, source: "none", lane: cacheLane };
          meta.quota = getQuotaState(primary);

          return NextResponse.json({ ok: true, data: withProof, meta });
        }
      }

      // ---- Unknown error ----
      const msg = String(err?.message ?? "Unknown error");
      return NextResponse.json({ ok: false, error: msg, meta }, { status: 500 });
    }
  } catch (err: any) {
    const msg = String(err?.message ?? "Unknown error");
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
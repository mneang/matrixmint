/**
 * judgeRun.mjs — Judge-style run verification for MatrixMint.
 *
 * Runs:
 *  1) LIVE (cache-bust) run
 *  2) CACHE run
 *  3) OFFLINE run
 *
 * Validates:
 *  - HTTP 200
 *  - ok:true
 *  - exports contain required keys
 *  - coverage/proof present
 *
 * Prints judge-grade metadata:
 *  - modeRequested / ladderUsed / modelUsed
 *  - elapsedMs
 *  - cache hit/source/lane/ageSeconds
 *  - warnings
 *  - attempts summary (what was tried, what succeeded)
 *
 * Usage:
 *   node scripts/judgeRun.mjs
 *
 * Env:
 *   BASE=http://127.0.0.1:3000
 *   MODEL=gemini-3-flash-preview
 *   SAMPLE_ID=disaster-relief
 *
 * Reliability:
 *   TIMEOUT_MS=140000        # per request timeout
 *   MAX_RETRIES=2            # retries on 429/502/503/504
 *   RETRY_BASE_MS=600        # base backoff
 *
 * Live proof gating:
 *   STRICT_LIVE=0|1          # if 1, fail if LIVE does not use a gemini model
 */

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const MODEL = process.env.MODEL || "gemini-3-flash-preview";
const SAMPLE_ID = process.env.SAMPLE_ID || "disaster-relief";

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || "140000");
const MAX_RETRIES = Number(process.env.MAX_RETRIES || "2");
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || "600");
const STRICT_LIVE = String(process.env.STRICT_LIVE || "0") === "1";

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function isRetriableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function getRetryDelayMs(attempt) {
  // attempt starts at 1
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(8000, RETRY_BASE_MS + attempt * attempt * 700 + jitter);
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    return { res, text, json: safeJsonParse(text), aborted: false };
  } catch (e) {
    const msg = String(e?.message || e);
    const aborted = msg.toLowerCase().includes("aborted");
    return { res: null, text: msg, json: null, aborted };
  } finally {
    clearTimeout(t);
  }
}

async function postRun(extraHeaders, label) {
  const url = `${BASE}/api/run`;
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ sampleId: SAMPLE_ID, model: MODEL }),
  };

  let attempt = 0;
  while (true) {
    attempt += 1;

    const out = await fetchWithTimeout(url, init, TIMEOUT_MS);

    // Network/timeout: retry if allowed
    if (!out.res) {
      const canRetry = attempt <= MAX_RETRIES;
      if (canRetry) {
        const delay = getRetryDelayMs(attempt);
        console.log(`${label}: RETRY (no response / ${out.aborted ? "timeout" : "network"}) attempt=${attempt}/${MAX_RETRIES} wait=${delay}ms`);
        await sleep(delay);
        continue;
      }
      return out;
    }

    // HTTP retriable
    if (!out.res.ok && isRetriableStatus(out.res.status) && attempt <= MAX_RETRIES) {
      const delay = getRetryDelayMs(attempt);
      const preview = String(out.text || "").slice(0, 140).replace(/\s+/g, " ");
      console.log(`${label}: RETRY HTTP ${out.res.status} attempt=${attempt}/${MAX_RETRIES} wait=${delay}ms preview="${preview}"`);
      await sleep(delay);
      continue;
    }

    return out;
  }
}

function validate(label, pack) {
  const { res, text, json } = pack;

  assert(res && res.ok, `${label}: HTTP ${res ? res.status : "(no status)"} ${String(text || "").slice(0, 180)}`);
  assert(json && typeof json === "object", `${label}: Not JSON`);
  assert(json.ok === true, `${label}: ok=false ${(json.error || "").slice(0, 180)}`);

  const exportsKeys = Object.keys(json.exports || {});
  const required = [
    "proofpack_md",
    "bidpacket_md",
    "clarifications_email_md",
    "risks_csv",
    "proposal_draft_md",
  ];
  for (const k of required) {
    assert(exportsKeys.includes(k), `${label}: missing export key ${k}`);
  }

  const sum = json.runSummary || {};
  assert(typeof sum.coveragePercent === "number", `${label}: missing coveragePercent`);
  assert(typeof sum.proof === "string", `${label}: missing proof string`);

  return json;
}

function formatCache(c) {
  if (!c || typeof c !== "object") return "—";
  const hit = typeof c.hit === "boolean" ? `hit=${c.hit}` : "";
  const src = c.source ? `src=${c.source}` : "";
  const lane = c.lane ? `lane=${c.lane}` : "";
  const age = typeof c.ageSeconds === "number" ? `age=${c.ageSeconds}s` : "";
  return [hit, src, lane, age].filter(Boolean).join(" ") || "—";
}

function summarize(label, j) {
  const orch = j?.orchestrator || {};
  const sum = j?.runSummary || {};
  const exportsKeys = Object.keys(j?.exports || {});
  const warnings = Array.isArray(orch.warnings) ? orch.warnings : [];
  const attempts = Array.isArray(orch.attempts) ? orch.attempts : [];

  console.log(`\n${label}`);
  console.log("  ok:", j?.ok);
  console.log("  modeRequested:", orch.modeRequested ?? "—");
  console.log("  ladderUsed:", orch.ladderUsed ?? "—");
  console.log("  modelUsed:", orch.modelUsed ?? "—");
  console.log("  elapsedMs:", orch.elapsedMs ?? "—");
  console.log("  cache:", formatCache(orch.cache));
  console.log("  warnings:", warnings.slice(0, 3).join(" | ") || "—");
  console.log("  coverage:", sum.coveragePercent);
  console.log("  proof:", sum.proof);
  console.log("  exports:", exportsKeys.join(", ") || "—");

  if (attempts.length) {
    const slim = attempts.map((a) => ({
      name: a.name,
      ok: a.ok,
      httpStatus: a.httpStatus ?? null,
      elapsedMs: a.elapsedMs,
      aborted: a.aborted,
      modelUsed: a.modelUsed,
    }));
    console.log("  attempts:", JSON.stringify(slim, null, 2).split("\n").map((l) => "  " + l).join("\n"));
  }
}

function isGeminiModelUsed(modelUsed) {
  return typeof modelUsed === "string" && modelUsed.startsWith("gemini-");
}

function liveProofCheck(liveJson) {
  const orch = liveJson?.orchestrator || {};
  const modeRequested = orch.modeRequested;
  const ladderUsed = orch.ladderUsed;
  const modelUsed = orch.modelUsed;

  // Always show a clear signal line
  const liveProof = isGeminiModelUsed(modelUsed) && modeRequested === "live" && ladderUsed === "live";
  const signal = liveProof ? "LIVE_PROOF_OK" : "LIVE_PROOF_NOT_CONFIRMED";
  console.log(`\nLIVE_PROOF_SIGNAL: ${signal}`);
  console.log(`  modeRequested=${modeRequested ?? "—"} ladderUsed=${ladderUsed ?? "—"} modelUsed=${modelUsed ?? "—"}`);

  // Hard fail only if STRICT_LIVE=1
  if (STRICT_LIVE) {
    assert(liveProof, `LIVE proof failed: expected gemini modelUsed + live ladder; got mode=${modeRequested} ladder=${ladderUsed} modelUsed=${modelUsed}`);
  } else {
    if (!liveProof) {
      console.log("  note: LIVE did not confirm gemini usage. This can happen under quota/circuit breaker; CACHE fallback is still acceptable for demo stability.");
      console.log("  tip: rerun later or set STRICT_LIVE=1 when you want the script to fail unless live proof is captured.");
    }
  }
}

async function main() {
  console.log(`[${nowIso()}] JudgeRun`);
  console.log(`BASE=${BASE}`);
  console.log(`MODEL=${MODEL}`);
  console.log(`SAMPLE_ID=${SAMPLE_ID}`);
  console.log(`TIMEOUT_MS=${TIMEOUT_MS} MAX_RETRIES=${MAX_RETRIES} STRICT_LIVE=${STRICT_LIVE}\n`);

  // 1) LIVE (fresh judge run)
  const livePack = await postRun(
    { "x-matrixmint-mode": "live", "x-matrixmint-bust-cache": "1" },
    "LIVE"
  );
  const live = validate("LIVE", livePack);
  summarize("LIVE", live);
  liveProofCheck(live);

  // 2) CACHE (should be instant-ish + stable)
  const cachePack = await postRun({ "x-matrixmint-mode": "cache" }, "CACHE");
  const cache = validate("CACHE", cachePack);
  summarize("CACHE", cache);

  // 3) OFFLINE (should always work)
  const offPack = await postRun({ "x-matrixmint-mode": "offline" }, "OFFLINE");
  const offline = validate("OFFLINE", offPack);
  summarize("OFFLINE", offline);

  // Stability note (not failing)
  const d1 = Math.abs((live.runSummary.coveragePercent || 0) - (cache.runSummary.coveragePercent || 0));
  const d2 = Math.abs((live.runSummary.coveragePercent || 0) - (offline.runSummary.coveragePercent || 0));
  console.log("\nSTABILITY:");
  console.log("  |live-cache| coverage delta:", d1.toFixed(2));
  console.log("  |live-offline| coverage delta:", d2.toFixed(2));

  console.log("\nALL_JUDGE_CHECKS_OK");
}

main().catch((e) => {
  console.error("JUDGE_RUN_FAIL:", String(e?.message || e));
  process.exit(1);
});
/**
 * MatrixMint eval harness (reliability + model/caching visibility).
 *
 * What it measures:
 * - Success rate
 * - Coverage/proof stats + stddev
 * - Evidence mismatch rows max observed
 * - Model usage distribution: live vs cache vs offline
 * - Retries for 429/503 (quota/overload)
 * - Cache age (if present)
 *
 * Env:
 *   BASE=http://127.0.0.1:3000
 *   MODEL=gemini-3-flash-preview | gemini-3-pro-preview
 *   N=10
 *   SLEEP_MS=150          # delay between runs
 *   MAX_RETRIES=3         # per run, on 429/503
 *   RETRY_BASE_MS=350     # base backoff
 *
 * Cache controls:
 *   CLEAR_DISK_CACHE=1    # deletes .matrixmint_cache before running
 *   CLEAR_DISK_EACH_RUN=1 # deletes .matrixmint_cache before every run (heavy)
 *
 * Output modes:
 *   VERBOSE=1             # prints warnings + cache meta each run
 */

import fs from "fs/promises";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const MODEL = process.env.MODEL || "gemini-3-flash-preview";
const N = Number(process.env.N || "10");
const SLEEP_MS = Number(process.env.SLEEP_MS || "120");
const MAX_RETRIES = Number(process.env.MAX_RETRIES || "3");
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || "350");
const VERBOSE = String(process.env.VERBOSE || "0") === "1";

const CLEAR_DISK_CACHE = String(process.env.CLEAR_DISK_CACHE || "0") === "1";
const CLEAR_DISK_EACH_RUN = String(process.env.CLEAR_DISK_EACH_RUN || "0") === "1";

const CACHE_DIR = ".matrixmint_cache";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowMs() {
  return Date.now();
}

function safeJsonParse(txt) {
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function summarizeError(out, status, bodyText) {
  const msg = out?.error ? String(out.error) : bodyText ? String(bodyText).slice(0, 120) : "";
  const details = out?.details ? JSON.stringify(out.details).slice(0, 160) : "";
  return `status=${status} err=${msg}${details ? " | details: " + details : ""}`;
}

function getRetryDelayMs(out, attempt) {
  // If API includes retryDelay like "33s", respect it.
  const retryDelay = out?.details?.error?.details?.find?.((d) => d?.["@type"]?.includes("RetryInfo"))?.retryDelay;
  if (typeof retryDelay === "string" && retryDelay.endsWith("s")) {
    const secs = Number(retryDelay.replace("s", ""));
    if (Number.isFinite(secs) && secs > 0) return Math.min(60000, secs * 1000);
  }
  // Otherwise exponential-ish backoff.
  const base = RETRY_BASE_MS;
  return Math.min(60000, base + attempt * attempt * 250);
}

async function clearDiskCache() {
  try {
    await fs.rm(CACHE_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

async function main() {
  console.log(`EVAL HARNESS: N=${N} MODEL=${MODEL} BASE=${BASE}`);
  if (CLEAR_DISK_CACHE) console.log(`Cache: CLEAR_DISK_CACHE=1 (deleting ${CACHE_DIR} once before run)`);
  if (CLEAR_DISK_EACH_RUN) console.log(`Cache: CLEAR_DISK_EACH_RUN=1 (deleting ${CACHE_DIR} before each run)`);
  console.log("");

  if (CLEAR_DISK_CACHE) await clearDiskCache();

  // Load sample
  const sres = await fetch(`${BASE}/api/samples`);
  const sj = await sres.json();
  const s = sj.samples?.[0];
  if (!s) {
    console.error("Missing sample payload");
    process.exit(1);
  }
  console.log(`Sample: ${s.id} — ${s.name}\n`);

  // Metrics
  let ok = 0;
  let fail = 0;

  const coverageList = [];
  const proofList = [];
  let maxMismatchRows = 0;

  const usage = {
    live: 0, // real Gemini model
    cache: 0,
    offline: 0,
    unknown: 0,
  };

  let totalRetries = 0;
  const latencyMs = [];

  for (let i = 1; i <= N; i++) {
    if (CLEAR_DISK_EACH_RUN) await clearDiskCache();

    const start = nowMs();
    let attempt = 0;

    while (true) {
      attempt++;

      const res = await fetch(`${BASE}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rfpText: s.rfpText,
          capabilityText: s.capabilityText,
          model: MODEL,
        }),
      });

      const text = await res.text();
      const out = safeJsonParse(text);

      // Success path
      if (res.ok && out?.ok) {
        const end = nowMs();
        const ms = end - start;
        latencyMs.push(ms);

        const cov = Number(out.data?.summary?.coveragePercent ?? 0);
        const proof = Number(out.data?.summary?.proofPercent ?? 0);
        const reqs = out.data?.requirements || [];
        const mismatchRows = reqs.filter((r) => (r.riskFlags || []).includes("Evidence mismatch")).length;

        const meta = out.meta || {};
        const modelUsed = meta.modelUsed || "unknown";
        const fallback = meta.fallbackUsed || "none";
        const cache = meta.cache || {};
        const age = typeof cache.ageSeconds === "number" ? cache.ageSeconds : null;

        if (modelUsed === "cache") usage.cache++;
        else if (modelUsed === "offline") usage.offline++;
        else if (typeof modelUsed === "string" && modelUsed.startsWith("gemini")) usage.live++;
        else usage.unknown++;

        ok++;
        coverageList.push(cov);
        proofList.push(proof);
        maxMismatchRows = Math.max(maxMismatchRows, mismatchRows);

        const ageStr = age === null ? "" : ` age=${age}s`;
        const warnStr = Array.isArray(meta.warnings) && meta.warnings.length ? ` warnings=${meta.warnings.length}` : "";
        const retryStr = attempt > 1 ? ` retries=${attempt - 1}` : "";
        const msStr = ` ${ms}ms`;

        console.log(
          `RUN ${i}: OK coverage=${cov.toFixed(2)} proof=${Math.round(proof)}% mismatchRows=${mismatchRows} modelUsed=${modelUsed} fallback=${fallback}${ageStr}${warnStr}${retryStr}${msStr}`
        );

        if (VERBOSE && meta.warnings?.length) {
          console.log("  WARNINGS:", meta.warnings.slice(0, 3));
        }
        break;
      }

      // Failure path
      const status = res.status;
      const errSummary = summarizeError(out, status, text);

      // Retriable: overload / quota / transient 5xx
      const retriable = status === 429 || status === 503 || status === 502 || status === 504;

      if (retriable && attempt <= MAX_RETRIES) {
        totalRetries += 1;
        const delay = getRetryDelayMs(out, attempt);
        console.log(`RUN ${i}: RETRY attempt=${attempt}/${MAX_RETRIES} ${errSummary} (wait ${delay}ms)`);
        await sleep(delay);
        continue;
      }

      fail++;
      console.log(`RUN ${i}: FAIL ${errSummary}`);
      break;
    }

    if (SLEEP_MS > 0 && i < N) await sleep(SLEEP_MS);
  }

  // Results
  const covAvg = mean(coverageList);
  const covMin = coverageList.length ? Math.min(...coverageList) : 0;
  const covMax = coverageList.length ? Math.max(...coverageList) : 0;
  const covSd = stddev(coverageList);

  const proofAvg = mean(proofList);
  const proofMin = proofList.length ? Math.min(...proofList) : 0;
  const proofMax = proofList.length ? Math.max(...proofList) : 0;
  const proofSd = stddev(proofList);

  const latAvg = mean(latencyMs);
  const latMin = latencyMs.length ? Math.min(...latencyMs) : 0;
  const latMax = latencyMs.length ? Math.max(...latencyMs) : 0;

  console.log("\nRESULTS:");
  console.log(`OK: ${ok} | FAIL: ${fail}`);
  console.log(`Coverage avg=${covAvg.toFixed(2)} (min=${covMin.toFixed(2)} max=${covMax.toFixed(2)} sd=${covSd.toFixed(2)})`);
  console.log(`Proof avg=${Math.round(proofAvg)}% (min=${Math.round(proofMin)} max=${Math.round(proofMax)} sd=${proofSd.toFixed(2)})`);
  console.log(`Max Evidence mismatch rows observed: ${maxMismatchRows}`);
  console.log(`Retries total: ${totalRetries}`);
  console.log(`Latency avg=${Math.round(latAvg)}ms (min=${latMin}ms max=${latMax}ms)`);
  console.log(`Model usage: live=${usage.live} cache=${usage.cache} offline=${usage.offline} unknown=${usage.unknown}`);
}

main().catch((e) => {
  console.error("HARNESS_FATAL", String(e?.message || e));
  process.exit(1);
});
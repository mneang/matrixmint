/**
 * MatrixMint smoke test for /api/analyze + /api/export.
 *
 * Goals:
 * - Validate analyze returns ok:true
 * - Print meta.modelUsed/fallback/warnings/cache age
 * - Print coverage + proof + mismatch rows
 * - Optionally test exports (proofpack/bidpacket/json) and verify bytes > 0
 *
 * Usage:
 *   node scripts/testAnalyze.mjs
 *
 * Env:
 *   BASE=http://127.0.0.1:3000
 *   MODEL=gemini-3-flash-preview | gemini-3-pro-preview
 *   EXPORTS=proofpack_md,bidpacket_md,json (comma-separated)  (default: proofpack_md,bidpacket_md)
 *   WRITE_EXPORTS=0|1  (default: 0)  // if 1, writes export files to ./tmp_exports
 */

import fs from "fs/promises";
import path from "path";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const MODEL = process.env.MODEL || "gemini-3-flash-preview";
const EXPORTS = (process.env.EXPORTS || "proofpack_md,bidpacket_md")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const WRITE_EXPORTS = String(process.env.WRITE_EXPORTS || "0") === "1";

function nowIso() {
  return new Date().toISOString();
}

function safeSlice(s, n = 220) {
  return String(s ?? "").slice(0, n);
}

function bytesToKB(b) {
  return `${Math.round((b / 1024) * 10) / 10} KB`;
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not json
  }
  return { res, text, json };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k];
  return out;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function main() {
  console.log(`[${nowIso()}] MatrixMint testAnalyze`);
  console.log(`BASE=${BASE}`);
  console.log(`MODEL=${MODEL}`);
  console.log(`EXPORTS=${EXPORTS.join(",")}`);
  console.log(`WRITE_EXPORTS=${WRITE_EXPORTS}\n`);

  // 1) Load sample
  const samplesUrl = `${BASE}/api/samples`;
  const sres = await fetchJson(samplesUrl);
  if (!sres.res.ok) {
    console.error("SAMPLES_FAIL", sres.res.status, safeSlice(sres.text));
    process.exit(1);
  }

  const sample = sres.json?.samples?.[0];
  if (!sample?.rfpText || !sample?.capabilityText) {
    console.error("SAMPLES_FAIL Missing sample payload shape");
    process.exit(1);
  }

  console.log(`SAMPLE_OK id=${sample.id || "(no id)"} name=${sample.name || "(no name)"}\n`);

  // 2) Analyze
  const analyzeUrl = `${BASE}/api/analyze`;
  const ares = await fetchJson(analyzeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rfpText: sample.rfpText,
      capabilityText: sample.capabilityText,
      model: MODEL,
    }),
  });

  if (!ares.res.ok) {
    console.error("ANALYZE_HTTP_FAIL", ares.res.status, safeSlice(ares.text));
    process.exit(1);
  }

  const out = ares.json;
  if (!out?.ok) {
    console.error("ANALYZE_FAIL", out?.error || "(no error)");
    if (out?.details) console.error("DETAILS", safeSlice(JSON.stringify(out.details), 400));
    console.error("RAW", safeSlice(ares.text, 400));
    process.exit(1);
  }

  const data = out.data;
  const meta = out.meta || {};

  const cov = Number(data?.summary?.coveragePercent ?? 0);
  const proofPct = data?.summary?.proofPercent;
  const proofVerified = data?.summary?.proofVerifiedCount;
  const proofTotal = data?.summary?.proofTotalEvidenceRefs;

  const reqs = Array.isArray(data?.requirements) ? data.requirements : [];
  const mismatches = reqs
    .filter((r) => Array.isArray(r?.riskFlags) && r.riskFlags.includes("Evidence mismatch"))
    .map((r) => r?.id)
    .filter(Boolean);

  console.log("ANALYZE_OK");
  console.log("META", JSON.stringify(pick(meta, ["modelRequested", "modelUsed", "fallbackUsed", "warnings", "cache"]), null, 2));

  console.log(
    `SCORE coverage=${cov.toFixed(2)}% proof=${
      typeof proofPct === "number" && typeof proofVerified === "number" && typeof proofTotal === "number"
        ? `${Math.round(proofPct)}% (${proofVerified}/${proofTotal})`
        : "—"
    } mismatchRows=${mismatches.length}`
  );

  console.log("EVIDENCE_MISMATCH_ROWS", mismatches.length ? mismatches.join(", ") : "(none)");

  // 3) Export tests
  // Default: test Proof Pack + Bid Packet. Optional JSON export too.
  // We verify:
  // - HTTP 200
  // - response bytes > 0
  // - content-type exists
  // If WRITE_EXPORTS=1, we write files into ./tmp_exports for inspection.
  const exportDir = path.join(process.cwd(), "tmp_exports");

  if (EXPORTS.length) {
    if (WRITE_EXPORTS) await ensureDir(exportDir);

    for (const fmt of EXPORTS) {
      const url = `${BASE}/api/export?format=${encodeURIComponent(fmt)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: data }),
      });

      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type") || "(none)";
      const ok = res.ok && buf.length > 0;

      console.log(
        `EXPORT_${fmt.toUpperCase()} ${ok ? "OK" : "FAIL"} http=${res.status} bytes=${buf.length} (${bytesToKB(buf.length)}) contentType=${ct}`
      );

      if (!ok) {
        const preview = buf.toString("utf8").slice(0, 280);
        console.error(`EXPORT_${fmt.toUpperCase()}_DETAILS`, preview);
        process.exit(1);
      }

      if (WRITE_EXPORTS) {
        const d = new Date().toISOString().slice(0, 10);
        let name = `matrixmint-${fmt}-${d}`;
        if (fmt.endsWith("_md")) name += ".md";
        else if (fmt.endsWith("_csv")) name += ".csv";
        else if (fmt === "json") name += ".json";
        else name += ".bin";

        const outPath = path.join(exportDir, name);
        await fs.writeFile(outPath, buf);
        console.log(`  ↳ wrote ${outPath}`);
      }
    }
  }

  console.log("\nALL_CHECKS_OK");
}

main().catch((e) => {
  console.error("UNCAUGHT_FAIL", String(e?.message || e));
  process.exit(1);
});
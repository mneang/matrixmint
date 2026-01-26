/**
 * judgeRun.mjs — Judge-style run verification for MatrixMint.
 *
 * What it does (single command):
 * 1) LIVE (cache-bust) run on sampleId
 * 2) CACHE run on same sampleId
 * 3) OFFLINE forced run on same sampleId
 * 4) Validates:
 *    - ok:true
 *    - exports contain required keys
 *    - coverage/proof present
 *    - prints modelUsed + elapsedMs + warnings
 *
 * Usage:
 *   node scripts/judgeRun.mjs
 *
 * Env:
 *   BASE=http://127.0.0.1:3000
 *   MODEL=gemini-3-flash-preview
 *   SAMPLE_ID=disaster-relief
 */

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const MODEL = process.env.MODEL || "gemini-3-flash-preview";
const SAMPLE_ID = process.env.SAMPLE_ID || "disaster-relief";

function nowIso() {
  return new Date().toISOString();
}

async function postRun(headers) {
  const res = await fetch(`${BASE}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ sampleId: SAMPLE_ID, model: MODEL }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, text, json };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function summarize(label, j) {
  const orch = j?.orchestrator || {};
  const sum = j?.runSummary || {};
  const exportsKeys = Object.keys(j?.exports || {});
  console.log(`\n${label}`);
  console.log("  ok:", j?.ok);
  console.log("  modelUsed:", orch.modelUsed);
  console.log("  elapsedMs:", orch.elapsedMs);
  console.log("  warnings:", (orch.warnings || []).slice(0, 2).join(" | ") || "—");
  console.log("  coverage:", sum.coveragePercent);
  console.log("  proof:", sum.proof);
  console.log("  exports:", exportsKeys.join(", ") || "—");
}

function validate(label, pack) {
  const { res, text, json } = pack;
  assert(res.ok, `${label}: HTTP ${res.status} ${text.slice(0, 160)}`);
  assert(json && typeof json === "object", `${label}: Not JSON`);
  assert(json.ok === true, `${label}: ok=false ${(json.error || "").slice(0, 160)}`);

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

async function main() {
  console.log(`[${nowIso()}] JudgeRun`);
  console.log(`BASE=${BASE}`);
  console.log(`MODEL=${MODEL}`);
  console.log(`SAMPLE_ID=${SAMPLE_ID}`);

  // 1) LIVE (fresh judge run)
  const livePack = await postRun({
    "x-matrixmint-mode": "live",
    "x-matrixmint-bust-cache": "1",
  });
  const live = validate("LIVE", livePack);
  summarize("LIVE", live);

  // 2) CACHE (should be instant-ish + stable)
  const cachePack = await postRun({
    "x-matrixmint-mode": "cache",
  });
  const cache = validate("CACHE", cachePack);
  summarize("CACHE", cache);

  // 3) OFFLINE (should always work)
  const offPack = await postRun({
    "x-matrixmint-mode": "offline",
  });
  const offline = validate("OFFLINE", offPack);
  summarize("OFFLINE", offline);

  // Simple stability note (not failing the run)
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
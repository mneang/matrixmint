import fs from "node:fs";
import path from "node:path";

const FILE = path.join(process.cwd(), "src/app/api/analyze/route.ts");
if (!fs.existsSync(FILE)) {
  console.error("ERROR: route.ts not found at", FILE);
  process.exit(1);
}

let s = fs.readFileSync(FILE, "utf8");
const original = s;

// ----------------------------
// 1) Insert Live Gate helpers (module scope)
// ----------------------------
const LIVE_GATE_MARKER_START = "// --------- Live gate (serializes live Gemini calls) ----------";
const LIVE_GATE_BLOCK = `
${LIVE_GATE_MARKER_START}
let LIVE_CHAIN: Promise<void> = Promise.resolve();
let LAST_LIVE_AT = 0;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Serializes calls and enforces a minimum gap between live Gemini requests.
 * This prevents burst quota hits during judgeRun's back-to-back requests.
 */
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
`.trimEnd();

if (!s.includes(LIVE_GATE_MARKER_START)) {
  // Insert right after the QUOTA_STATE block (best stable anchor from your file)
  const anchor = /const\s+QUOTA_STATE:\s*Record<string,\s*QuotaMeta>\s*=\s*\{[\s\S]*?\};\s*/m;
  const m = s.match(anchor);
  if (!m) {
    console.error("ERROR: Could not find QUOTA_STATE block to anchor insertion.");
    process.exit(1);
  }
  const idx = m.index + m[0].length;
  s = s.slice(0, idx) + "\n\n" + LIVE_GATE_BLOCK + "\n\n" + s.slice(idx);
}

// ----------------------------
// 2) Replace the "!allowLive" block to refuse offline fallback in mode=live
// ----------------------------
const allowLiveBlockRegex =
  /if\s*\(!allowLive\)\s*\{\s*([\s\S]*?)\n\s*return\s+NextResponse\.json\(\{\s*ok:\s*true,\s*data:\s*withProof,\s*meta\s*\}\);\s*\n\s*\}/m;

if (allowLiveBlockRegex.test(s)) {
  s = s.replace(allowLiveBlockRegex, () => {
    return `
if (!allowLive) {
  // In STRICT live mode, do NOT return a 200 offline fallback (judge will fail).
  // Instead, return 429 so the client/judge can retry after cooldown.
  if (mode === "live") {
    const now = Date.now();
    const retryMs = Math.max(10_000, (q.blockedUntilUnixMs || (now + 20_000)) - now);

    meta.warnings?.push("Quota circuit breaker active; refusing offline fallback in live mode.");
    meta.quota = getQuotaState(requestedModel);

    return NextResponse.json(
      { ok: false, error: "quota_blocked", retryAfterMs: retryMs, meta },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryMs / 1000)) } }
    );
  }

  // For non-live (auto/cache/etc), we can still fall back offline.
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
`.trim();
  });
} else {
  console.warn("WARN: Did not find the exact !allowLive block to replace (may already be patched).");
}

// ----------------------------
// 3) Wrap generateParseValidate(...) inside attemptModel with withLiveGate
// ----------------------------
const genCallRegex =
  /return\s+await\s+generateParseValidate\(\{\s*ai,\s*model:\s*m,\s*prompt:\s*basePrompt,\s*jsonSchema,\s*thinkingLevel:\s*THINKING_LEVEL,\s*timeoutMs:\s*modelTimeoutMs,\s*\}\);/m;

if (genCallRegex.test(s)) {
  s = s.replace(genCallRegex, () => {
    return `
return await withLiveGate(1200, async () => {
  return await generateParseValidate({
    ai,
    model: m,
    prompt: basePrompt,
    jsonSchema,
    thinkingLevel: THINKING_LEVEL,
    timeoutMs: modelTimeoutMs,
  });
});
`.trim();
  });
} else {
  // If your function has a slightly different formatting, we try a broader replacement.
  const genCallRegex2 =
    /return\s+await\s+generateParseValidate\(\{[\s\S]*?timeoutMs:\s*modelTimeoutMs,[\s\S]*?\}\);/m;

  if (genCallRegex2.test(s) && !s.includes("withLiveGate(1200")) {
    s = s.replace(genCallRegex2, (match) => {
      return `
return await withLiveGate(1200, async () => {
  ${match.replace(/^return\s+await\s+/, "return await ")}
});
`.trim();
    });
  } else {
    console.warn("WARN: Did not find generateParseValidate(...) return to wrap (may already be wrapped).");
  }
}

// ----------------------------
// 4) Add attemptModelWithQuotaRetry helper (near attemptModel) + use it for primary
// ----------------------------
const attemptModelDeclRegex =
  /const\s+attemptModel\s*=\s*async\s*\(m:\s*"gemini-3-flash-preview"\s*\|\s*"gemini-3-pro-preview"\)\s*=>\s*\{\s*/m;

if (attemptModelDeclRegex.test(s) && !s.includes("attemptModelWithQuotaRetry")) {
  s = s.replace(attemptModelDeclRegex, (m) => {
    return (
      m +
      `
      // Retry quota-exceeded once (live mode only) after suggested delay.
`
    );
  });

  // Insert helper right AFTER attemptModel definition block ends is tricky; easiest is to insert
  // helper near the first usage site of attemptModel(primary).
}

if (!s.includes("const attemptModelWithQuotaRetry")) {
  // Insert helper just before the "try { const parsed = ..." block (anchor: "try {" after attemptModel section)
  const anchorTry = /try\s*\{\s*\n\s*const\s+parsed\s*=\s*await\s+attemptModel\(/m;
  if (anchorTry.test(s)) {
    s = s.replace(anchorTry, (match) => {
      const helper = `
const attemptModelWithQuotaRetry = async (
  m: "gemini-3-flash-preview" | "gemini-3-pro-preview"
) => {
  try {
    return await attemptModel(m);
  } catch (err: any) {
    if (mode === "live" && isQuotaExceededError(err)) {
      const retryMs = parseRetryDelayMs(err);
      meta.warnings?.push(\`Quota exceeded for \${m}; waiting \${Math.ceil(retryMs / 1000)}s then retrying.\`);
      await sleep(retryMs);
      return await attemptModel(m);
    }
    throw err;
  }
};

`;
      return helper + match;
    });
  } else {
    console.warn("WARN: Could not anchor insertion of attemptModelWithQuotaRetry helper.");
  }
}

// Replace primary call: attemptModel(primary) -> attemptModelWithQuotaRetry(primary)
s = s.replace(
  /const\s+parsed\s*=\s*await\s+attemptModel\(primary\);/m,
  `const parsed = await attemptModelWithQuotaRetry(primary);`
);

// ----------------------------
// 5) Replace isQuotaExceededError(err) catch block:
//    - set quota blocked
//    - if live: try secondary once; else return 429 (NO offline 200)
//    - if not live: keep offline fallback behavior
// ----------------------------
const quotaCatchRegex =
  /if\s*\(isQuotaExceededError\(err\)\)\s*\{\s*([\s\S]*?)\n\s*return\s+NextResponse\.json\(\{\s*ok:\s*true,\s*data:\s*withProof,\s*meta\s*\}\);\s*\n\s*\}/m;

if (quotaCatchRegex.test(s)) {
  s = s.replace(quotaCatchRegex, () => {
    return `
if (isQuotaExceededError(err)) {
  const detailsStr = JSON.stringify((err as any)?.error || err || {});
  const retryMs = parseRetryDelayMs(err);
  setQuotaBlocked(primary, Date.now() + retryMs, detailsStr);

  meta.quota = getQuotaState(primary);

  // In live mode: do not succeed with offline output. Try secondary once, else 429 so judge can retry.
  if (mode === "live") {
    meta.warnings?.push(\`Quota exceeded for \${primary}; attempting \${secondary}.\`);

    try {
      const parsed2 = await attemptModelWithQuotaRetry(secondary);
      const withProof2 = computeProof(parsed2, capabilityText);

      RESULT_CACHE.set(cacheKey, { data: withProof2, savedAt: Date.now() });
      await writeDiskCache(cacheKey, withProof2);

      meta.modelUsed = secondary;
      meta.fallbackUsed = secondary === "gemini-3-pro-preview" ? "pro" : "none";
      meta.cache = { hit: false, key: cacheKey, source: "none", lane: cacheLane };
      meta.quota = getQuotaState(secondary);

      return NextResponse.json({ ok: true, data: withProof2, meta });
    } catch (err2: any) {
      const retryMs2 = isQuotaExceededError(err2) ? parseRetryDelayMs(err2) : retryMs;
      meta.warnings?.push("Live quota still exceeded; refusing offline fallback. Returning 429 for retry.");
      return NextResponse.json(
        { ok: false, error: "quota_exceeded", retryAfterMs: retryMs2, meta },
        { status: 429, headers: { "Retry-After": String(Math.ceil(retryMs2 / 1000)) } }
      );
    }
  }

  // Non-live modes can fall back offline.
  meta.warnings?.push("Quota exceeded; returned offline deterministic analysis (conservative).");
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
`.trim();
  });
} else {
  console.warn("WARN: Did not find isQuotaExceededError(err) block to replace (may already be patched).");
}

// ----------------------------
// Write if changed
// ----------------------------
if (s === original) {
  console.log("No changes made (already patched or patterns not found).");
} else {
  fs.writeFileSync(FILE, s, "utf8");
  console.log("Patched:", FILE);
  console.log("Notes:");
  console.log("- Added live gate (serializes live calls)");
  console.log("- Live mode returns 429 instead of offline 200 when quota blocks/exceeds");
  console.log("- Quota exceeded tries secondary once, else 429");
}

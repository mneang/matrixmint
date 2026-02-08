import path from "path";
import { promises as fs } from "fs";

export type StoredRun = any;

const DEFAULT_DIR = path.join(process.cwd(), ".matrixmint", "runs");

function runsDir() {
  return process.env.MATRIXMINT_RUNS_DIR || DEFAULT_DIR;
}

async function ensureDir() {
  await fs.mkdir(runsDir(), { recursive: true });
}

function memStore(): Map<string, StoredRun> {
  const g: any = globalThis as any;
  if (!g.__MATRIXMINT_RUN_STORE) g.__MATRIXMINT_RUN_STORE = new Map<string, StoredRun>();
  return g.__MATRIXMINT_RUN_STORE as Map<string, StoredRun>;
}

export async function saveRun(runId: string, bundle: StoredRun) {
  if (!runId) throw new Error("saveRun: missing runId");
  await ensureDir();

  // Memory (fast / intra-process)
  memStore().set(runId, bundle);

  // Disk (survive restarts / judge-friendly)
  const file = path.join(runsDir(), `${runId}.json`);
  await fs.writeFile(file, JSON.stringify(bundle, null, 2), "utf8");
}

export async function getRun(runId: string): Promise<StoredRun | null> {
  if (!runId) return null;

  // Memory first
  const m = memStore().get(runId);
  if (m) return m;

  // Disk fallback
  try {
    const file = path.join(runsDir(), `${runId}.json`);
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    // Rehydrate memory
    memStore().set(runId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export async function listRuns(limit = 50) {
  await ensureDir();

  // Disk is source of truth (survive restart)
  let files: string[] = [];
  try {
    files = await fs.readdir(runsDir());
  } catch {
    files = [];
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  // Sort newest first by mtime
  const stats = await Promise.all(
    jsonFiles.map(async (f) => {
      const full = path.join(runsDir(), f);
      const st = await fs.stat(full);
      return { f, full, mtimeMs: st.mtimeMs };
    })
  );

  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const picked = stats.slice(0, limit);

  const runs: any[] = [];
  for (const p of picked) {
    try {
      const raw = await fs.readFile(p.full, "utf8");
      const parsed = JSON.parse(raw);
      const runId = parsed?.orchestrator?.runId || parsed?.runId || p.f.replace(/\.json$/, "");
      runs.push({
        runId,
        createdAtIso: parsed?.orchestrator?.startedAtIso || parsed?.createdAtIso || new Date(p.mtimeMs).toISOString(),
        orchestrator: parsed?.orchestrator || { runId },
        runSummary: parsed?.runSummary || {},
      });
      // Keep memory warm
      memStore().set(runId, parsed);
    } catch {
      // ignore bad files
    }
  }

  return runs;
}

export function runsDirectory() {
  return runsDir();
}
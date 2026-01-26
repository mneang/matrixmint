import { NextResponse } from "next/server";

type StoredRun = {
  runId: string;
  createdAtIso: string;
  orchestrator: any;
  runSummary: any;
};

function getStore(): Map<string, any> {
  const g = globalThis as any;
  if (!g.__MATRIXMINT_RUNS) g.__MATRIXMINT_RUNS = new Map<string, any>();
  return g.__MATRIXMINT_RUNS;
}

export async function GET() {
  const store = getStore();
  const runs = Array.from(store.values())
    .map((r) => ({
      runId: r.runId,
      createdAtIso: r.createdAtIso,
      orchestrator: r.orchestrator,
      runSummary: r.runSummary,
    }) as StoredRun)
    .sort((a, b) => (a.createdAtIso < b.createdAtIso ? 1 : -1))
    .slice(0, 25);

  return NextResponse.json({ ok: true, runs });
}
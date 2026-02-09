import path from "path";

export function isVercel() {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}

export function matrixmintWritableRoot() {
  // Vercel serverless: /var/task is read-only, but /tmp is writable.
  return isVercel() ? "/tmp" : process.cwd();
}

export function matrixmintCacheDir() {
  return process.env.MATRIXMINT_CACHE_DIR?.trim()
    ? process.env.MATRIXMINT_CACHE_DIR.trim()
    : path.join(matrixmintWritableRoot(), ".matrixmint_cache");
}

export function matrixmintRunsDir() {
  return process.env.MATRIXMINT_RUNS_DIR?.trim()
    ? process.env.MATRIXMINT_RUNS_DIR.trim()
    : path.join(matrixmintWritableRoot(), ".matrixmint", "runs");
}
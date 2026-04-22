/**
 * Short-lived in-memory cache for GET /api/admin/stats to avoid many aggregations per page load.
 * Invalidated when orders change (TTL also applies). Multi-instance: each process has its own cache.
 */
const DEFAULT_TTL_MS = 45_000;

function ttlMs() {
  const n = parseInt(String(process.env.ADMIN_STATS_CACHE_TTL_MS || ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

let payload = null;
let expiresAt = 0;

export function getCachedAdminStats() {
  if (payload != null && Date.now() < expiresAt) {
    return payload;
  }
  return null;
}

export function setCachedAdminStats(data) {
  const t = ttlMs();
  if (t === 0) {
    payload = null;
    expiresAt = 0;
    return;
  }
  payload = data;
  expiresAt = Date.now() + t;
}

export function invalidateAdminStatsCache() {
  payload = null;
  expiresAt = 0;
}

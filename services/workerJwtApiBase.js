/**
 * API origin headless worker pages should call (embedded in JWT).
 * Prefer API_PUBLIC_URL so the storefront SPA can work without VITE_API_URL at build time.
 */
export function workerApiBaseForHeadlessWorker() {
  const explicit = String(process.env.API_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const app = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  try {
    const u = new URL(app);
    if (/^api\./i.test(u.hostname)) return app;
  } catch {
    /* ignore */
  }
  return "";
}

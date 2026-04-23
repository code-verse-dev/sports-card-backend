import fs from "fs";

/**
 * Shared Chromium launch options for headless PDF / card capture.
 *
 * On Linux servers, Puppeteer’s bundled Chrome needs system libraries. If you see
 * `libatk-bridge-2.0.so.0: cannot open shared object file`, install deps (Debian/Ubuntu):
 *
 *   sudo apt-get update && sudo apt-get install -y \
 *     ca-certificates fonts-liberation libasound2t64 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
 *     libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 \
 *     libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 \
 *     libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 xdg-utils
 *
 * (On older Ubuntu, use `libasound2` instead of `libasound2t64` if the latter doesn’t exist.)
 *
 * Or set `PUPPETEER_EXECUTABLE_PATH` / `CHROME_BIN` to a full Chrome/Chromium binary that
 * already matches your OS (e.g. `/usr/bin/chromium` or `/usr/bin/google-chrome-stable`).
 */

function resolveChromiumExecutablePath() {
  const fromEnv =
    String(process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || "").trim() || undefined;
  if (fromEnv) return fromEnv;
  if (process.platform !== "linux") return undefined;
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export function getPuppeteerLaunchOptions() {
  const executablePath = resolveChromiumExecutablePath();
  const ignoreHTTPSErrors = String(process.env.PUPPETEER_IGNORE_HTTPS_ERRORS || "").trim() === "1";
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  };
}

/** Turn Puppeteer “missing .so” / exit 127 into an actionable API message. */
export function augmentPuppeteerLaunchError(err) {
  const raw = err instanceof Error ? err.message : String(err);
  if (
    raw.includes("libatk-bridge") ||
    raw.includes("shared libraries") ||
    raw.includes("Code: 127") ||
    raw.includes("error while loading shared libraries")
  ) {
    return (
      `${raw} ` +
      "| Fix: on Ubuntu/Debian run: sudo apt-get install -y libatk-bridge2.0-0 libgtk-3-0 libgbm1 libnss3 libdrm2 libcups2 libasound2 libxdamage1 libxfixes3 libxrandr2 " +
      "(full list in puppeteerLaunchConfig.js). Or install chromium: sudo apt-get install -y chromium-browser " +
      "and set PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium. Shared hosting without apt often cannot run Chrome — use a VPS or Docker."
    );
  }
  return raw;
}

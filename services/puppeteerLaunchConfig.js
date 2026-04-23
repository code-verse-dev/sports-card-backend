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
export function getPuppeteerLaunchOptions() {
  const executablePath =
    String(process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || "").trim() || undefined;
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  };
}

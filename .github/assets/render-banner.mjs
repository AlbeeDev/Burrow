/**
 * Turn banner.html into banner.png.
 *
 *     node .github/assets/render-banner.mjs
 *
 * Rendered at 2x and displayed at 640px wide in the README, so it stays sharp on a retina screen.
 * Needs Playwright, which the repo does not depend on: `npx playwright install chromium` once.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const WIDTH = 1280;
const HEIGHT = 520;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
});

await page.goto("file://" + join(here, "banner.html"));
// The fonts load from disk through file://, and a screenshot taken before they arrive silently
// falls back to a system face, which looks almost right and is not.
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);

const out = join(here, "banner.png");
await page.screenshot({ path: out });
await browser.close();

console.log(`wrote ${out} at ${WIDTH * 2}x${HEIGHT * 2}`);

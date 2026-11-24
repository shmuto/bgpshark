/**
 * The link-preview image: the card Slack, Discord, X and the like show when
 * someone pastes a BGPShark link.
 *
 *   bun run og-image        # writes public/og-image.png
 *
 * A pasted link without one unfurls as a bare title, which says nothing about
 * what is on the other end. The card is the first thing a teammate sees of the
 * tool, so it shows the real workspace rather than a logo alone.
 *
 * It is generated rather than drawn for the same reason the manual's
 * screenshots are: the picture on the right is `public/manual/workspace.png`,
 * so re-running `bun run screenshots` and then this keeps the card in step with
 * the app. Fonts are the ones the app bundles, embedded as data URIs so the
 * page renders identically wherever this runs. The shark is the system's emoji
 * font (Noto Color Emoji on Linux), so it looks like the one in the header.
 *
 * 1200×630 is the size every major unfurler crops to without letterboxing.
 * The output is committed: crawlers fetch it from the deployed site, and the
 * build cannot run a browser.
 */
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'og-image.png')

/** Must match the `og:image:width` / `og:image:height` emitted by vite.config.ts. */
const SIZE = { width: 1200, height: 630 }

function dataUri(path: string, type: string): string {
  return `data:${type};base64,${readFileSync(join(ROOT, path)).toString('base64')}`
}

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @font-face { font-family: Inter; font-weight: 400; src: url(${dataUri('src/assets/fonts/inter-400.woff2', 'font/woff2')}) format('woff2'); }
  @font-face { font-family: Inter; font-weight: 600; src: url(${dataUri('src/assets/fonts/inter-600.woff2', 'font/woff2')}) format('woff2'); }
  @font-face { font-family: 'JetBrains Mono'; font-weight: 500; src: url(${dataUri('src/assets/fonts/jetbrains-mono-500.woff2', 'font/woff2')}) format('woff2'); }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${SIZE.width}px; height: ${SIZE.height}px; overflow: hidden; }
  body {
    position: relative;
    font-family: Inter, sans-serif;
    color: #e2e8f0;
    background:
      radial-gradient(900px 500px at 110% 120%, rgba(59, 130, 246, 0.45), transparent 60%),
      linear-gradient(135deg, #0b1220 0%, #0f1b3d 55%, #1e3a8a 100%);
  }
  .text { position: absolute; left: 72px; top: 76px; width: 520px; }
  .brand { display: flex; align-items: center; gap: 18px; }
  .brand .shark { font-size: 64px; line-height: 1; font-family: 'Noto Color Emoji', sans-serif; }
  .brand h1 { font-size: 64px; font-weight: 600; letter-spacing: -0.02em; color: #fff; }
  .tagline { margin-top: 28px; font-size: 32px; line-height: 1.3; font-weight: 600; color: #fff; }
  .sub { margin-top: 16px; font-size: 22px; line-height: 1.45; color: #94a3b8; }
  .chips { margin-top: 36px; display: flex; flex-wrap: wrap; gap: 10px; }
  .chip {
    font-family: 'JetBrains Mono', monospace; font-weight: 500; font-size: 17px;
    padding: 7px 12px; border-radius: 6px;
    background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.14);
  }
  .open { color: #4ade80; } .update { color: #60a5fa; } .notif { color: #f87171; } .ka { color: #cbd5e1; }
  .footer {
    position: absolute; left: 72px; bottom: 56px;
    display: flex; align-items: center; gap: 10px;
    font-size: 19px; color: #cbd5e1;
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #4ade80; }
  .shot {
    position: absolute; left: 660px; top: 92px; width: 840px;
    border-radius: 12px; overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.18);
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
  }
  .shot img { display: block; width: 100%; }
</style>
</head>
<body>
  <div class="text">
    <div class="brand"><span class="shark">🦈</span><h1>BGPShark</h1></div>
    <p class="tagline">BGP session troubleshooting, straight from a pcap.</p>
    <p class="sub">Decode, filter and query BGP messages in the browser — no Wireshark needed.</p>
    <div class="chips">
      <span class="chip open">OPEN</span>
      <span class="chip update">UPDATE</span>
      <span class="chip notif">NOTIFICATION</span>
      <span class="chip ka">KEEPALIVE</span>
    </div>
  </div>
  <div class="footer"><span class="dot"></span>Runs locally — captures never leave your machine</div>
  <div class="shot"><img src="${dataUri('public/manual/workspace.png', 'image/png')}" /></div>
</body>
</html>`

// CHROMIUM_PATH is the same escape hatch playwright.config.ts and
// screenshots.ts offer, for a machine whose browser is not Playwright's pinned one.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
)
try {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: OUT })
  console.log(`wrote ${OUT}`)
} finally {
  await browser.close()
}

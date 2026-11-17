// Exports the scene's poster as PNGs with transparent corners, in the light
// and the dark theme.
//
//   STAGESHOW_DIR=<stageshow folder> CHROME_PATH=<chrome binary> node export.mjs [out-dir]
//
// Needs the Stageshow preview running (see README.md in this folder). The
// scene has to be in Stageshow's examples/ folder as "otp-bridge".
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

if (!process.env.STAGESHOW_DIR) {
  console.error('Set STAGESHOW_DIR to the Stageshow folder; its playwright-core does the filming.')
  process.exit(2)
}
const { chromium } = createRequire(path.join(path.resolve(process.env.STAGESHOW_DIR), 'package.json'))('playwright-core')

const URL = process.env.STAGE_URL || 'http://127.0.0.1:5199/?capture=otp-bridge'
const outDir = path.resolve(process.argv[2] || '.')
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' })
try {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1000, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: 'reduce', // the stage shows its poster
    })
    const page = await context.newPage()
    await page.addInitScript((dark) => { window.__stageshow = dark ? { theme: 'dark' } : {} }, scheme === 'dark')
    await page.goto(URL)
    const stage = page.locator('.ob .ss-stage').first()
    await stage.waitFor({ state: 'visible' })
    // Nothing behind the stage, so its rounded corners come out transparent.
    await page.addStyleTag({ content: 'html, body, #root, #example { background: transparent !important; }' })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(900)
    const file = path.join(outDir, scheme === 'dark' ? 'poster-dark.png' : 'poster.png')
    await stage.screenshot({ path: file, omitBackground: true })
    console.log(file)
    await context.close()
  }
} finally {
  await browser.close()
}

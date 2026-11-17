// Films one loop of the scene and writes it as an animated GIF.
//
//   STAGESHOW_DIR=<stageshow folder> CHROME_PATH=<chrome binary> \
//     node capture.cjs <out.gif> [--scale 2] [--fps 12.5] [--slow 6] [--dither 14] [--dark]
//
// Needs two small packages next to this file: npm install --no-save gifenc pngjs
//
// The scene runs <slow> times slower while it is filmed, so every frame is
// taken at an exact scene time. The GIF starts on the calm frame where the code
// is on offer (the frame that tells the story on its own) and runs one loop.
// Needs the Stageshow preview running (see README.md in this folder). The
// scene has to be in Stageshow's examples/ folder as "otp-bridge".
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { PNG } = require('pngjs')
const { GIFEncoder, quantize, applyPalette } = require('gifenc')
if (!process.env.STAGESHOW_DIR) {
  console.error('Set STAGESHOW_DIR to the Stageshow folder; its playwright-core does the filming.')
  process.exit(2)
}
const { chromium } = createRequire(path.join(path.resolve(process.env.STAGESHOW_DIR), 'package.json'))('playwright-core')
const URL = process.env.STAGE_URL || 'http://127.0.0.1:5199/?capture=otp-bridge'

const args = process.argv.slice(2)
const out = path.resolve(args[0] || 'hero.gif')
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : fallback }
const scale = opt('scale', 2)
const fps = opt('fps', 12.5)
const slow = opt('slow', 6)
const dark = args.includes('--dark')
const step = 1000 / fps // scene ms between frames
const dither = opt('dither', 14) // strength of the pattern, in color levels
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
]

;(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: scale, colorScheme: dark ? 'dark' : 'light' })
  const page = await context.newPage()
  await page.addInitScript(([slow, dark]) => { window.__stageshow = { slow, ...(dark ? { theme: 'dark' } : {}) } }, [slow, dark])
  const cdp = await context.newCDPSession(page)
  await cdp.send('Animation.enable')
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / slow })
  await page.goto(URL)
  const stage = page.locator('.ob .ss-stage').first()
  await stage.waitFor({ state: 'visible' })
  await page.addStyleTag({ content: 'html, body, #root, #example { background: transparent !important; }' })
  const mark = () => stage.getAttribute('data-mark')

  // Wait for the code to go on offer, then a little longer so the suggestion
  // has settled: the first frame is that calm picture.
  await page.waitForFunction((el) => el.getAttribute('data-mark') === 'offer', await stage.elementHandle(), { timeout: 60000 * slow, polling: 16 })
  await page.waitForTimeout(450 * slow)

  const frames = []
  const start = Date.now()
  let seenOther = false
  let loopEnd = null
  for (let k = 0; k < 400; k += 1) {
    const due = start + k * step * slow
    await page.waitForTimeout(Math.max(0, due - Date.now()))
    const taken = (Date.now() - start) / slow
    const png = await stage.screenshot({ omitBackground: true })
    const m = await mark()
    if (m !== 'offer') seenOther = true
    // One loop later the code goes on offer again; stop a settle after that.
    if (seenOther && m === 'offer' && loopEnd === null) loopEnd = taken + 450
    if (loopEnd !== null && taken >= loopEnd - step / 2) break
    frames.push({ at: taken, png })
  }
  await browser.close()
  const loopMs = loopEnd
  console.log(`${frames.length} frames over ${(loopMs / 1000).toFixed(2)}s of scene time`)

  const decoded = frames.map((f) => PNG.sync.read(f.png))
  const { width, height } = decoded[0]

  // One palette for the whole film, from a sample of frames; index 0 is kept
  // for "see-through" (the rounded corners, and pixels a frame leaves as they were).
  const sampleEvery = Math.max(1, Math.floor(decoded.length / 14))
  const chunks = []
  decoded.forEach((img, i) => {
    if (i % sampleEvery) return
    const d = img.data
    const opaque = Buffer.alloc(d.length)
    let n = 0
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3] < 128) continue
      opaque[n] = d[p]; opaque[n + 1] = d[p + 1]; opaque[n + 2] = d[p + 2]; opaque[n + 3] = 255
      n += 4
    }
    chunks.push(opaque.subarray(0, n))
  })
  const colors = quantize(Buffer.concat(chunks), 255, { format: 'rgb565' })
  const palette = [[0, 0, 0], ...colors]

  const gif = GIFEncoder()
  let previous = null
  decoded.forEach((img, i) => {
    const d = img.data
    // 256 colors cannot hold the wallpaper's gradient or the soft shadows, so
    // each pixel is nudged by a fixed 8x8 pattern before it is matched. The
    // pattern depends only on where the pixel is, so a pixel that does not
    // change between frames still maps to the same color.
    const nudged = Buffer.from(d)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = (y * width + x) * 4
        const n = (BAYER[(y & 7) * 8 + (x & 7)] / 64 - 0.5) * dither
        nudged[p] = Math.max(0, Math.min(255, d[p] + n))
        nudged[p + 1] = Math.max(0, Math.min(255, d[p + 1] + n))
        nudged[p + 2] = Math.max(0, Math.min(255, d[p + 2] + n))
      }
    }
    const indexed = applyPalette(nudged, colors, 'rgb565')
    const frame = new Uint8Array(indexed.length)
    for (let p = 0; p < indexed.length; p += 1) {
      const solid = d[p * 4 + 3] >= 128
      const value = solid ? indexed[p] + 1 : 0
      frame[p] = previous && previous[p] === value ? 0 : value
      if (previous) previous[p] = value
    }
    if (!previous) previous = Uint8Array.from(frame)
    const next = i + 1 < frames.length ? frames[i + 1].at : loopMs
    const delay = Math.max(20, Math.round((next - frames[i].at) / 10) * 10)
    gif.writeFrame(frame, width, height, { palette: i === 0 ? palette : undefined, delay, transparent: true, transparentIndex: 0, dispose: 1, repeat: 0 })
  })
  gif.finish()
  fs.writeFileSync(out, gif.bytes())
  console.log(`${out}  ${width}x${height}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`)
})().catch((err) => { console.error(err); process.exit(1) })

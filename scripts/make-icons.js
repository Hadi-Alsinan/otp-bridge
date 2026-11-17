'use strict';

/*
 * Renders companion/web/icon.svg into the PNG sizes the browser extension
 * needs. Run with `npm run icons` after changing the SVG (needs Playwright).
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'companion', 'web', 'icon.svg'), 'utf8');
const outDir = path.join(root, 'extension', 'icons');

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const size of [16, 32, 48, 128]) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
      await page.screenshot({ path: path.join(outDir, `icon${size}.png`), omitBackground: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  fs.copyFileSync(path.join(root, 'companion', 'web', 'icon.svg'), path.join(outDir, 'icon.svg'));
  console.log(`Icons written to ${outDir}`);
})();

'use strict';

/*
 * End-to-end test: the real companion, a real Chromium with the extension
 * loaded, and pages built the ways real sites build their code fields.
 *
 *   npm run test:e2e                 run everything
 *   npm run test:e2e -- react rtl    run only tests whose name contains a word
 *
 * Needs Playwright with Chromium (npm install, then npx playwright install chromium).
 * Screenshots are written to e2e/output/.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const { createCompanion } = require('../companion/lib/server');
const { newToken } = require('../companion/lib/config');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION = path.join(ROOT, 'extension');
const FIXTURES = path.join(__dirname, 'fixtures');
const OUTPUT = path.join(__dirname, 'output');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const filters = process.argv.slice(2).map((word) => word.toLowerCase());

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

function startFixtureServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const vendor = {};
  try {
    // Through package.json: the UMD builds are not listed in the packages' "exports".
    const umd = (name) => path.join(path.dirname(require.resolve(`${name}/package.json`)), 'umd', `${name}.production.min.js`);
    if (fs.existsSync(umd('react')) && fs.existsSync(umd('react-dom'))) {
      vendor['/vendor/react.js'] = umd('react');
      vendor['/vendor/react-dom.js'] = umd('react-dom');
    }
  } catch { /* React tests are skipped when it is not installed */ }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixtures.invalid');
    const file = vendor[url.pathname] || path.join(FIXTURES, path.basename(url.pathname));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (url.pathname === '/csp.html') {
      headers['Content-Security-Policy'] = "default-src 'none'; style-src 'self'; script-src 'self'; require-trusted-types-for 'script'";
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => resolve({ server, port: server.address().port, hasReact: Boolean(vendor['/vendor/react.js']) }));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  fs.mkdirSync(OUTPUT, { recursive: true });

  let clockSkew = 0;
  const config = { port: 0, localToken: newToken(), phoneToken: newToken(), clipboard: false };
  const app = createCompanion({ config, version: '0.0.0-e2e', now: () => Date.now() + clockSkew, extensionPath: EXTENSION });
  const port = await app.listen(0, '0.0.0.0');
  const base = `http://127.0.0.1:${port}`;
  const fixtures = await startFixtureServer();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-bridge-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    viewport: { width: 1100, height: 820 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;

  // --- helpers ---------------------------------------------------------------

  async function sms(text, extra = {}) {
    const res = await fetch(`${base}/p/${config.phoneToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, ...extra }),
    });
    assert.equal(res.status, 200);
    return res.json();
  }

  function entryFor(code) {
    return app.store.list().find((entry) => entry.code === code);
  }

  async function open(pathname, host = '127.0.0.1') {
    const page = await context.newPage();
    await page.goto(`http://${host}:${fixtures.port}${pathname}`);
    return page;
  }

  /** Runs code inside an extension page, where the extension APIs are available. */
  async function inExtension(fn, arg) {
    const page = await context.newPage();
    try {
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      return await page.evaluate(fn, arg);
    } finally {
      await page.close();
    }
  }

  const chip = (scope) => scope.locator('[data-otp-bridge][data-state="codes"]');
  const note = (scope) => scope.locator('[data-otp-bridge][data-state="note"]');

  async function waitChip(scope, timeout = 9000) {
    await chip(scope).waitFor({ state: 'visible', timeout });
    return chip(scope).boundingBox();
  }

  async function waitNoChip(scope, timeout = 6000) {
    await chip(scope).waitFor({ state: 'detached', timeout });
  }

  /** Waits long enough for a scan and a poll, then insists nothing is offered. */
  async function expectNoChip(scope, ms = 2600) {
    await sleep(ms);
    assert.equal(await chip(scope).count(), 0, 'no suggestion expected here');
  }

  // The suggestion ignores clicks for a moment after it appears or moves, so
  // that it cannot catch a click meant for something else.
  const ARMING_MS = 480;

  // Layout of the suggestion card: rows of 44px starting 4px from the top, a 30px close strip on the right.
  async function clickRow(page, scope, index = 0, { wait = ARMING_MS } = {}) {
    await sleep(wait);
    const box = await chip(scope).boundingBox();
    await page.mouse.click(box.x + 70, box.y + 26 + index * 44);
  }

  async function clickClose(page, scope) {
    await sleep(ARMING_MS);
    const box = await chip(scope).boundingBox();
    await page.mouse.click(box.x + box.width - 15, box.y + box.height / 2);
  }

  /** Reads the text inside the closed shadow root, through the DevTools protocol. */
  async function chipText(page) {
    const session = await context.newCDPSession(page);
    try {
      const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      let hostNode = null;
      (function walk(node) {
        if (hostNode) return;
        const attrs = node.attributes || [];
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === 'data-otp-bridge') { hostNode = node; return; }
        }
        for (const child of node.children || []) walk(child);
        for (const shadowRoot of node.shadowRoots || []) walk(shadowRoot);
        if (node.contentDocument) walk(node.contentDocument);
      }(root));
      if (!hostNode || !hostNode.shadowRoots) return null;
      // The wording is drawn from "data-say" attributes; there are no text nodes.
      const texts = [];
      let textNodes = 0;
      (function collect(node) {
        if (node.nodeName === 'STYLE') return;
        if (node.nodeType === 3 && node.nodeValue.trim()) textNodes += 1;
        const attrs = node.attributes || [];
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === 'data-say') texts.push(attrs[i + 1]);
        }
        for (const child of node.children || []) collect(child);
      }(hostNode.shadowRoots[0]));
      assert.equal(textNodes, 0, 'the suggestion must not contain real text');
      return texts.join(' ').replace(/\s+/g, ' ').trim();
    } finally {
      await session.detach();
    }
  }

  async function shot(page, name) {
    await sleep(250);                                      // let the fade-in finish
    await page.screenshot({ path: path.join(OUTPUT, `${name}.png`) });
  }

  const sameSpot = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;

  // --- tests -----------------------------------------------------------------

  const tests = [];
  const test = (name, fn, options = {}) => tests.push({ name, fn, ...options });

  test('pairing: opening the dashboard connects the extension', async () => {
    const page = await context.newPage();
    await page.goto(`${base}/?k=${config.localToken}`);
    await page.waitForFunction(() => document.querySelector('#pill-browser').textContent === 'Browser: connected', null, { timeout: 15000 });
    assert.equal(page.url(), `${base}/`, 'the private link is traded for a cookie');
    const stored = await inExtension(() => chrome.storage.local.get('pairing'));
    assert.equal(stored.pairing.baseUrl, base);
    assert.equal(stored.pairing.token, config.localToken);
    assert.equal(await page.locator('#state-browser').textContent(), 'Connected');
    await page.close();
  });

  test('single field: the code appears under it and one click fills it', async () => {
    const page = await open('/single.html');
    await expectNoChip(page, 1500);
    const sentAt = Date.now();
    await sms('Your Acme verification code is 482913');
    const box = await waitChip(page);
    const latency = Date.now() - sentAt;
    const field = await page.locator('#otp').boundingBox();
    assert.ok(sameSpot(box.x, field.x), 'left edges line up');
    assert.ok(box.y >= field.y + field.height && box.y <= field.y + field.height + 10, 'sits just below the field');
    assert.match(await chipText(page), /Fill code 482 913 From your phone/);
    assert.equal(await page.inputValue('#otp'), '', 'nothing is typed before the click');

    // The page itself cannot read the suggestion.
    const seen = await page.evaluate(() => {
      const host = document.querySelector('[data-otp-bridge]');
      return { shadow: host.shadowRoot, text: host.textContent, html: host.innerHTML, body: document.body.innerText.includes('482') };
    });
    assert.deepEqual(seen, { shadow: null, text: '', html: '', body: false });

    // ...not through text search, selection or copy either.
    const probe = await page.evaluate(() => {
      const out = { found: [] };
      for (const needle of ['482', '913', '482 913', '482913', 'Fill code', 'From your phone']) {
        getSelection().removeAllRanges();
        if (window.find(needle, false, false, true)) out.found.push(needle);
      }
      getSelection().removeAllRanges();
      document.execCommand('selectAll');
      out.selectAll = getSelection().toString();
      getSelection().selectAllChildren(document.documentElement);
      out.selectChildren = getSelection().toString();
      getSelection().removeAllRanges();
      out.innerText = document.documentElement.innerText;
      out.outer = document.documentElement.outerHTML;
      return out;
    });
    assert.deepEqual(probe.found, [], 'window.find() must not see inside the suggestion');
    for (const key of ['selectAll', 'selectChildren', 'innerText', 'outer']) {
      assert.ok(!/482|913|Fill code/.test(probe[key]), `${key} leaks: ${probe[key].slice(0, 200)}`);
    }

    await shot(page, 'chip-single');
    await clickRow(page, page);
    assert.equal(await page.inputValue('#otp'), '482913');
    await note(page).waitFor({ state: 'visible', timeout: 2000 });
    assert.match(await chipText(page), /Filled in/);
    await note(page).waitFor({ state: 'detached', timeout: 4000 });
    await expectNoChip(page, 1200);
    assert.ok(entryFor('482913').usedAt, 'the companion knows the code was used');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'otp', 'the field keeps the cursor');
    await page.close();
    return `code visible ${latency} ms after the message arrived`;
  });

  test('a code that arrived before the page opened is offered too', async () => {
    await sms('Your code is 135246');
    const page = await open('/single.html');
    await waitChip(page);
    assert.match(await chipText(page), /135 246/);
    await page.close();
  });

  test('a less obvious field gets the suggestion only once it is focused', async () => {
    const page = await open('/weak.html');
    await sms('Your code is 246135');
    await expectNoChip(page);
    await page.click('#code');
    await waitChip(page);
    await page.click('input[name="q"]');
    await waitNoChip(page);
    await page.click('#code');
    await waitChip(page);
    await clickRow(page, page);
    assert.equal(await page.inputValue('#code'), '246135');
    await page.close();
  });

  test('split boxes: six separate inputs are filled one digit each', async () => {
    const page = await open('/boxes.html');
    await sms('Your code is 908172');
    const box = await waitChip(page);
    const first = await page.locator('#boxes input').first().boundingBox();
    assert.ok(sameSpot(box.x, first.x));
    await shot(page, 'chip-boxes');
    await clickRow(page, page);
    const values = await page.locator('#boxes input').evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.deepEqual(values, ['9', '0', '8', '1', '7', '2']);
    assert.equal(await page.textContent('#joined'), '908172', "the page's own script saw every digit");
    await page.close();
  });

  test('react: a controlled field keeps the value', async () => {
    const page = await open('/react.html');
    await page.waitForSelector('#r-otp');
    await sms('Your code is 665544');
    await page.click('#r-otp');
    await waitChip(page);
    await clickRow(page, page);
    assert.equal(await page.inputValue('#r-otp'), '665544');
    assert.equal(await page.textContent('#r-single-state'), '665544', 'React state was updated, not just the box');
    await sleep(400);
    assert.equal(await page.inputValue('#r-otp'), '665544', 'and React did not put the old value back');
    await page.close();
  }, { needsReact: true });

  test('react: state-driven split boxes', async () => {
    const page = await open('/react.html');
    await page.waitForSelector('#r-boxes input');
    await sms('Your code is 314159');
    await page.locator('#r-boxes input').first().click();
    await waitChip(page);
    await clickRow(page, page);
    assert.equal(await page.textContent('#r-split-state'), '314159');
    const values = await page.locator('#r-boxes input').evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.deepEqual(values, ['3', '1', '4', '1', '5', '9']);
    await page.close();
  }, { needsReact: true });

  test('react: key-driven split boxes (the page cancels key presses)', async () => {
    const page = await open('/react.html');
    await page.waitForSelector('#r-keys input');
    await sms('Your PIN code is 2718');
    await page.locator('#r-keys input').first().click();
    await waitChip(page);
    await clickRow(page, page);
    assert.equal(await page.textContent('#r-keys-state'), '2718');
    await page.close();
  }, { needsReact: true });

  test('a bank page inside a frame from another site', async () => {
    const page = await open('/frame-host.html');
    const frame = page.frameLocator('#bank');
    await frame.locator('#challenge').waitFor();
    await sms('Your OTP for purchase of SAR 150.00 at JARIR on card ending 1234 is 739105. Do not share it.');
    await expectNoChip(frame, 2000);                       // an unnamed field: wait for the click
    await frame.locator('#challenge').click();
    await waitChip(frame);
    assert.equal(await chip(page).count(), 0, 'nothing is drawn in the outer page');
    await shot(page, 'chip-frame');
    await clickRow(page, frame);
    assert.equal(await frame.locator('#challenge').inputValue(), '739105');
    await page.close();
  });

  test('a native modal dialog', async () => {
    const page = await open('/dialog.html');
    await sms('Your code is 112358');
    await page.click('#open');
    await waitChip(page);
    assert.equal(await page.locator('#dlg [data-otp-bridge]').count(), 1, 'drawn inside the dialog, where it can be clicked');
    await clickRow(page, page);
    assert.equal(await page.inputValue('#otp'), '112358');
    assert.equal(await page.evaluate(() => document.getElementById('dlg').open), true);
    await page.close();
  });

  test('a pop-up that closes on "click outside" stays open', async () => {
    const page = await open('/outside.html');
    await sms('Your code is 224466');
    await waitChip(page);
    await clickRow(page, page);
    assert.equal(await page.title(), 'Click-outside modal', 'the page never saw the click');
    assert.equal(await page.locator('#overlay').count(), 1);
    assert.equal(await page.inputValue('#otp'), '224466');
    await page.close();
  });

  test('fields that are not for codes are left alone', async () => {
    const page = await open('/negative.html');
    await sms('Your code is 975310');
    await expectNoChip(page);
    const ids = await page.locator('form input, form textarea').evaluateAll((fields) => fields.map((field) => field.id));
    assert.equal(ids.length, 20);
    for (const id of ids) {
      await page.focus(`#${id}`);
      await sleep(350);
      assert.equal(await chip(page).count(), 0, `no suggestion on #${id}`);
    }
    await sleep(2500);
    assert.equal(await chip(page).count(), 0);
    await page.close();
  });

  test('typing the code by hand makes the suggestion go away', async () => {
    const page = await open('/single.html');
    await sms('Your code is 864213');
    await waitChip(page);
    await page.click('#otp');
    await page.keyboard.type('864213', { delay: 30 });
    await waitNoChip(page);
    await sleep(300);
    assert.ok(entryFor('864213').usedAt);
    await page.close();
  });

  test('Escape hides it until a new code arrives', async () => {
    const page = await open('/single.html');
    await sms('Your code is 100200');
    await waitChip(page);
    await page.click('#otp');
    await page.keyboard.press('Escape');
    await waitNoChip(page);
    await expectNoChip(page, 2200);
    assert.equal(entryFor('100200').usedAt, null, 'hiding is not using');
    await sms('Your code is 300400');
    await waitChip(page);
    await page.close();
  });

  test('keyboard: arrow down, then Enter', async () => {
    const page = await open('/single.html');
    await sms('Your code is 555777');
    await page.click('#otp');
    await waitChip(page);
    await page.keyboard.press('Enter');                    // not highlighted yet: Enter belongs to the page
    assert.equal(await page.inputValue('#otp'), '');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.inputValue('#otp'), '555777');
    await page.close();
  });

  test('the close button hides it on this page only', async () => {
    const page = await open('/single.html');
    await sms('Your code is 121314');
    await waitChip(page);
    await clickClose(page, page);
    await waitNoChip(page);
    await expectNoChip(page, 2200);
    assert.equal(await page.inputValue('#otp'), '');
    assert.equal(entryFor('121314').usedAt, null);
    const other = await open('/single.html');
    await waitChip(other);
    await other.close();
    await page.close();
  });

  test('two codes: both are listed, newest first', async () => {
    const page = await open('/single.html');
    await sms('Your Alpha code is 111222');
    await sleep(50);
    await sms('Your Beta code is 333444', { sender: 'Beta Bank' });
    await waitChip(page);
    await page.waitForFunction(() => document.querySelector('[data-otp-bridge]').dataset.count === '2');
    const text = await chipText(page);
    assert.ok(text.indexOf('333 444') < text.indexOf('111 222'), text);
    assert.match(text, /From Beta Bank/);
    await shot(page, 'chip-two');
    await clickRow(page, page, 1);
    assert.equal(await page.inputValue('#otp'), '111222');
    await page.close();
  });

  test('a code older than three minutes is no longer offered', async () => {
    const page = await open('/single.html');
    await sms('Your code is 909090');
    await waitChip(page);
    clockSkew += 4 * 60 * 1000;
    await sms('Your code is 818181');
    await page.waitForFunction(() => document.querySelector('[data-otp-bridge]').dataset.count === '1', null, { timeout: 8000 });
    await sleep(600);
    const text = await chipText(page);
    assert.match(text, /818 181/);
    assert.ok(!text.includes('909'), text);
    await page.close();
  });

  test('a code that names its website is offered on that website only', async () => {
    const page = await open('/single.html');
    await sms('Your Example code is 111999.\n@example.com #111999');
    await expectNoChip(page);
    await page.click('#otp');
    await expectNoChip(page, 1200);
    assert.equal(entryFor('111999').domain, 'example.com');

    await sms('Your code is 222888.\n@127.0.0.1 #222888');
    await waitChip(page);
    const text = await chipText(page);
    assert.match(text, /222 888/);
    assert.ok(!text.includes('111'), text);

    // The same page under another host name does not get it.
    const elsewhere = await open('/single.html', 'localhost');
    await elsewhere.click('#otp');
    await expectNoChip(elsewhere);
    await elsewhere.close();
    await page.close();
  });

  test('a strict Content-Security-Policy does not break the suggestion', async () => {
    const page = await open('/csp.html');
    await sms('Your code is 606060');
    const box = await waitChip(page);
    assert.ok(box.width >= 200 && box.height >= 44 && box.height <= 70, `styled card, got ${box.width}x${box.height}`);
    await shot(page, 'chip-csp');
    await clickRow(page, page);
    assert.equal(await page.inputValue('#otp'), '606060');
    await page.close();
  });

  test('Arabic, right-to-left page and Arabic digits in the message', async () => {
    const page = await open('/rtl.html');
    await sms('عزيزي العميل، رمز التحقق لمرة واحدة هو ٤٨٢٩١٣ صالح لمدة ٥ دقائق');
    await page.click('#f');
    const box = await waitChip(page);
    const field = await page.locator('#f').boundingBox();
    assert.ok(sameSpot(box.x + box.width, field.x + field.width), 'right edges line up in a right-to-left page');
    await shot(page, 'chip-rtl');
    await clickRow(page, page);
    assert.equal(await page.inputValue('#f'), '482913');
    await page.close();
  });

  test('a field that is added to the page later', async () => {
    const page = await open('/late.html');
    await sms('Your code is 717273');
    await waitChip(page);
    await clickRow(page, page);
    assert.equal(await page.inputValue('#inserted'), '717273');
    await page.close();
  });

  test('a field that was hidden and is then shown', async () => {
    const page = await open('/late.html?mode=reveal');
    await sms('Your code is 747576');
    await waitChip(page);
    await clickRow(page, page);
    assert.equal(await page.inputValue('#revealed'), '747576');
    await page.close();
  });

  test('a code that cannot fit the field is not offered', async () => {
    const page = await open('/pin4.html');
    await sms('Your code is 123456');
    await page.click('#otp');
    await expectNoChip(page);
    await sms('Your OTP is 4821');
    await waitChip(page);
    assert.match(await chipText(page), /4821/);
    await clickRow(page, page);
    assert.equal(await page.inputValue('#otp'), '4821');
    await page.close();
  });

  test('a field inside a web component', async () => {
    const page = await open('/shadow.html');
    await sms('Your code is 192837');
    await page.locator('code-entry input').click();
    await waitChip(page);
    await clickRow(page, page);
    assert.equal(await page.locator('code-entry input').inputValue(), '192837');
    await page.close();
  });

  test('an input of type number keeps leading zeros', async () => {
    const page = await open('/number.html');
    await sms('Your OTP is 004217');
    await waitChip(page);
    await clickRow(page, page);
    assert.equal(await page.inputValue('#otp'), '004217');
    await page.close();
  });

  test('toolbar and right-click filling', async () => {
    const page = await open('/single.html');
    const url = page.url();
    const ask = (message) => inExtension(async ({ target, payload }) => {
      const [tab] = await chrome.tabs.query({ url: target });
      try {
        return await chrome.tabs.sendMessage(tab.id, payload);
      } catch (err) {
        return { error: String(err.message || err) };
      }
    }, { target: url, payload: message });

    // Nothing has the cursor: "focused" must stay silent so other frames may answer.
    const silent = await ask({ type: 'fill', mode: 'focused', code: '111111' });
    assert.ok(!silent || silent.error, JSON.stringify(silent));
    assert.equal(await page.inputValue('#otp'), '');

    const best = await ask({ type: 'fill', mode: 'best', code: '222333' });
    assert.deepEqual(best, { ok: true });
    assert.equal(await page.inputValue('#otp'), '222333');

    await page.click('#otp', { button: 'right' });
    const menu = await ask({ type: 'fill', mode: 'context', code: '444555' });
    assert.deepEqual(menu, { ok: true });
    assert.equal(await page.inputValue('#otp'), '444555');

    // Anything that is not a plain code is refused.
    await ask({ type: 'fill', mode: 'best', code: '<img src=x>' });
    assert.equal(await page.inputValue('#otp'), '444555');
    await page.close();

    const boxes = await open('/boxes.html');
    const filled = await inExtension(async (target) => {
      const [tab] = await chrome.tabs.query({ url: target });
      return chrome.tabs.sendMessage(tab.id, { type: 'fill', mode: 'best', code: '678901' });
    }, boxes.url());
    assert.deepEqual(filled, { ok: true });
    assert.equal(await boxes.textContent('#joined'), '678901');
    await boxes.close();
  });

  test('web pages cannot talk to the extension or forge pairing', async () => {
    const page = await open('/single.html');
    const result = await page.evaluate(async (id) => {
      const out = {};
      out.runtime = Boolean(typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function');
      try {
        const res = await fetch(`chrome-extension://${id}/popup.html`);
        out.fetch = res.status;
      } catch (err) {
        out.fetch = 'blocked';
      }
      window.postMessage({ type: 'otp-bridge:pair-offer', token: 'A'.repeat(24) }, location.origin);
      return out;
    }, extensionId);
    assert.equal(result.runtime, false);
    assert.equal(result.fetch, 'blocked');
    await sleep(500);
    const stored = await inExtension(() => chrome.storage.local.get('pairing'));
    assert.equal(stored.pairing.token, config.localToken, 'pairing unchanged');
    await page.close();
  });

  test('a page cannot click the suggestion for the user', async () => {
    const page = await open('/single.html');
    await sms('Your code is 787878');
    await waitChip(page);
    await sleep(ARMING_MS);
    // Everything a page script could try: synthetic events on the suggestion, on the field, on the window.
    await page.evaluate(() => {
      const host = document.querySelector('[data-otp-bridge]');
      const box = host.getBoundingClientRect();
      const at = { clientX: box.left + 70, clientY: box.top + 26, bubbles: true, cancelable: true, composed: true, button: 0 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        host.dispatchEvent(new MouseEvent(type, at));
        document.elementFromPoint(at.clientX, at.clientY).dispatchEvent(new MouseEvent(type, at));
      }
      host.click();
      const field = document.getElementById('otp');
      field.focus();
      for (const key of ['ArrowDown', 'Enter']) {
        field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      }
    });
    await sleep(400);
    assert.equal(await page.inputValue('#otp'), '', 'synthetic events fill nothing');
    assert.equal(entryFor('787878').usedAt, null);
    assert.equal(await chip(page).count(), 1, 'and the suggestion is still there for the real user');
    await clickRow(page, page);
    assert.equal(await page.inputValue('#otp'), '787878');
    await page.close();
  });

  test('a suggestion that the page has hidden or moved does not take clicks', async () => {
    const page = await open('/single.html');
    await sms('Your code is 565656');
    const box = await waitChip(page);

    // Clicking the instant it appears does nothing (it may have popped up under the pointer).
    await page.mouse.click(box.x + 70, box.y + 26);
    await sleep(200);
    assert.equal(await page.inputValue('#otp'), '');

    // Made invisible by the page: the click is refused and the styling is put back.
    await sleep(ARMING_MS);
    await page.evaluate(() => document.querySelector('[data-otp-bridge]').style.setProperty('opacity', '0', 'important'));
    await page.mouse.click(box.x + 70, box.y + 26);
    await sleep(200);
    assert.equal(await page.inputValue('#otp'), '');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-otp-bridge]')).opacity), '1');

    // Faded out through its surroundings.
    await sleep(ARMING_MS);
    await page.evaluate(() => { document.documentElement.style.opacity = '0.05'; });
    await page.mouse.click(box.x + 70, box.y + 26);
    await sleep(200);
    assert.equal(await page.inputValue('#otp'), '');
    await page.evaluate(() => { document.documentElement.style.opacity = ''; });

    // Moved under the pointer: the field jumps, the suggestion follows, the click lands at once.
    await sleep(ARMING_MS);
    await page.evaluate(() => { document.getElementById('otp').style.marginLeft = '180px'; });
    await page.waitForFunction((x) => document.querySelector('[data-otp-bridge]').getBoundingClientRect().left > x + 100, box.x, { timeout: 5000 });
    const moved = await chip(page).boundingBox();
    await page.mouse.click(moved.x + 70, moved.y + 26);
    await sleep(200);
    assert.equal(await page.inputValue('#otp'), '');

    // Harmless extras that other extensions add (dark-mode tools set custom properties) are not tampering.
    await sleep(ARMING_MS);
    await page.evaluate(() => {
      const host = document.querySelector('[data-otp-bridge]');
      host.style.setProperty('--darkreader-inline-bgcolor', '#181a1b');
      host.setAttribute('data-darkreader-inline-bgcolor', '');
    });
    await clickRow(page, page);
    assert.equal(await page.inputValue('#otp'), '565656');
    await page.close();
  });

  test('the practice page works from start to finish', async () => {
    const page = await context.newPage();
    await page.goto(`${base}/demo`);
    await page.click('#send');
    await waitChip(page);
    await shot(page, 'demo-chip');
    await clickRow(page, page);
    await page.locator('#success').waitFor({ state: 'visible' });
    await sleep(1500);
    await page.click('#send');
    await page.locator('#boxes input').first().click();
    await waitChip(page);
    await clickRow(page, page);
    await page.locator('#success-boxes').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#no-extension').isVisible(), false);
    await shot(page, 'demo-done');
    await page.close();
  });

  test('the toolbar popup lists codes and can disconnect and reconnect', async () => {
    await sms('Your Gamma code is 505152', { sender: 'Gamma' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 340, height: 420 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.locator('#view-online').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.code .value').first().textContent(), '505 152');
    assert.match(await page.locator('.code .meta').first().textContent(), /Gamma/);
    await shot(page, 'popup-online');
    await page.locator('.code button', { hasText: 'Copy' }).first().click();
    await page.locator('.code button', { hasText: 'Copied' }).first().waitFor({ timeout: 2000 });

    await page.click('#disconnect');
    await page.locator('#view-unpaired').waitFor({ state: 'visible' });
    await shot(page, 'popup-unpaired');
    await page.click('summary');
    await page.fill('#link', 'https://example.com/?k=nope');
    await page.click('#connect');
    await page.locator('#link-error').waitFor({ state: 'visible' });
    await page.fill('#link', `${base}/?k=${config.localToken}`);
    await page.click('#connect');
    await page.locator('#view-online').waitFor({ state: 'visible' });
    await page.close();
  });

  test('screenshots of the dashboard, phone page and dark mode', async () => {
    await sms('Your Delta verification code is 778899', { sender: 'Delta Bank' });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1100, height: 1500 });
    await page.goto(`${base}/`);
    await page.locator('.code-row').first().waitFor();
    await page.waitForFunction(() => document.querySelector('#qr svg') !== null);
    await shot(page, 'dashboard-light');
    await page.screenshot({ path: path.join(OUTPUT, 'guide-dashboard.png'), clip: { x: 110, y: 10, width: 880, height: 640 } });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'dashboard-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await page.locator('#pill-phone').textContent(), 'Phone: last code just now');
    await page.close();

    const phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${base}/p/${config.phoneToken}`);
    await phone.waitForFunction(() => document.querySelector('#hook-url').textContent.length > 10);
    assert.equal(await phone.textContent('#hook-url'), `${base}/p/${config.phoneToken}`);
    await phone.click('#send-test');
    await phone.waitForFunction(() => /Sent \d{3} \d{3}/.test(document.querySelector('#test-out').textContent));
    await phone.screenshot({ path: path.join(OUTPUT, 'phone-page.png'), fullPage: true });
    await phone.close();

    const dark = await open('/single.html');
    await dark.emulateMedia({ colorScheme: 'dark' });
    await waitChip(dark);
    await shot(dark, 'chip-dark');
    await dark.close();

    // The picture at the top of the README.
    app.store.clear();
    const guide = await open('/single.html');
    await sms('Your Acme verification code is 482913');
    await waitChip(guide);
    await sleep(300);
    await guide.screenshot({ path: path.join(OUTPUT, 'guide-suggestion.png'), clip: { x: 20, y: 20, width: 620, height: 310 } });
    await guide.close();
  });

  test('the suggestion stays put for over a minute while the browser recycles the background script', async () => {
    const page = await open('/single.html');
    await sms('Your code is 646464');
    await waitChip(page);
    let gaps = 0;
    const until = Date.now() + 75000;
    while (Date.now() < until) {
      await sleep(500);
      if (await chip(page).count() === 0) gaps += 1;
    }
    assert.equal(gaps, 0, `the suggestion disappeared ${gaps} time(s)`);
    // And a new code still gets through afterwards.
    await sms('Your code is 656565');
    await page.waitForFunction(() => document.querySelector('[data-otp-bridge]').dataset.count === '2', null, { timeout: 8000 });
    await clickRow(page, page);
    assert.equal(await page.inputValue('#otp'), '656565');
    await page.close();
  });

  test('when the companion stops, pages recover and the popup says so', async () => {
    const page = await open('/single.html');
    await sms('Your code is 131313');
    await waitChip(page);
    await app.close();
    await waitNoChip(page, 30000);
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 300 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator('#view-offline').waitFor({ state: 'visible', timeout: 10000 });
    await shot(popup, 'popup-offline');
    await popup.close();
    await page.close();
  }, { last: true });

  // --- run -------------------------------------------------------------------

  const selected = tests.filter((t) => {
    if (t.name.startsWith('pairing')) return true;         // everything depends on it
    return filters.length === 0 || filters.some((word) => t.name.toLowerCase().includes(word));
  });

  let failed = 0;
  let skipped = 0;
  for (const t of selected) {
    if (t.needsReact && !fixtures.hasReact) {
      skipped += 1;
      console.log(`  skip  ${t.name} (React is not installed)`);
      continue;
    }
    if (!t.last) {
      app.store.clear();
      clockSkew = 0;
    }
    const started = Date.now();
    try {
      const detail = await t.fn();
      console.log(`  ok    ${t.name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ''}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${t.name}\n        ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n        ')}`);
      const pages = context.pages();
      const last = pages[pages.length - 1];
      if (last) await last.screenshot({ path: path.join(OUTPUT, `FAILED-${t.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}.png`) }).catch(() => {});
      for (const stale of context.pages()) await stale.close().catch(() => {});
    }
  }

  await context.close();
  await app.close().catch(() => {});
  fixtures.server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });

  console.log(`\n${selected.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

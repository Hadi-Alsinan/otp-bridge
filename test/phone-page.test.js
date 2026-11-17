'use strict';

// The phone's setup page chooses which address the phone is told to use. The
// page's script is run here against a stand-in for the browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'companion', 'web', 'phone.js'), 'utf8');

const NUMBER = 'http://192.168.1.23:4812/p/TOKEN';
const NAME = 'http://study-pc.local:4812/p/TOKEN';
const INFO = { ok: true, port: 4812, address: '192.168.1.23', localHostname: 'study-pc.local', computerName: 'study-pc' };

/**
 * Opens the page the way a browser would.
 * @param {string} origin       What is in the address bar, without the path.
 * @param {object} [options]
 * @param {boolean} [options.nameAnswers]  Whether "<name>.local" reaches the computer from this device.
 * @param {boolean} [options.infoFails]    Whether the computer cannot be asked for its details.
 */
async function openPage(origin, { nameAnswers = false, infoFails = false } = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      const handlers = {};
      elements.set(selector, {
        textContent: '',
        hidden: false,
        handlers,
        addEventListener(type, handler) { handlers[type] = handler; },
        setAttribute() {},
        getAttribute() { return null; },
      });
    }
    return elements.get(selector);
  };

  const copied = [];
  let lastInput = null;
  const document = {
    querySelector: element,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => ({ value: '', style: {}, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() {} }),
    body: { appendChild(node) { lastInput = node; } },
    execCommand(command) {
      if (command === 'copy') copied.push(lastInput.value);
      return true;
    },
  };
  const window = {
    location: { pathname: '/p/TOKEN', origin, hostname: new URL(origin).hostname },
    isSecureContext: false,
  };
  const fetch = (url) => {
    if (url.endsWith('/info')) {
      return infoFails ? Promise.reject(new Error('offline')) : Promise.resolve({ json: () => INFO });
    }
    if (url.endsWith('/ping')) {
      return nameAnswers
        ? Promise.resolve({ json: () => ({ ok: true, app: 'otp-bridge' }) })
        : Promise.reject(new Error('no route'));
    }
    return new Promise(() => {});
  };

  vm.runInNewContext(source, { document, window, navigator: { userAgent: 'iPhone' }, fetch, setTimeout, clearTimeout });
  await new Promise((resolve) => setTimeout(resolve, 20));

  return {
    get address() { return element('#hook-url').textContent; },
    get note() { return element('#url-note').textContent; },
    get switchLabel() { return element('#url-switch').hidden ? null : element('#url-switch').textContent; },
    get shortcutStatus() { return element('#shortcut-out').textContent; },
    copied,
    switchAddress() { element('#url-switch').handlers.click(); },
    addShortcut() { element('#add-shortcut').handlers.click({ preventDefault() {} }); },
  };
}

test('a phone that can reach the computer by name is given the name address', async () => {
  const page = await openPage('http://192.168.1.23:4812', { nameAnswers: true });
  assert.equal(page.address, NAME);
  assert.match(page.note, /stays the same on every Wi-Fi/);
  assert.doesNotMatch(page.note, /not been checked/);
  assert.equal(page.switchLabel, 'Use the number address instead');

  page.switchAddress();
  assert.equal(page.address, NUMBER);
  assert.match(page.note, /stops working when the computer joins a different Wi-Fi/);
  assert.equal(page.switchLabel, 'Use the name address instead');
});

test('a phone that cannot reach the name keeps the number and is told what to do when it changes', async () => {
  const page = await openPage('http://192.168.1.23:4812', { nameAnswers: false });
  assert.equal(page.address, NUMBER);
  assert.equal(page.switchLabel, null, 'an address that does not work from here is not offered');
  assert.match(page.note, /Change the address/);
});

test('opened by name, the page keeps the name and offers the number as well', async () => {
  const page = await openPage('http://study-pc.local:4812');
  assert.equal(page.address, NAME);
  assert.doesNotMatch(page.note, /not been checked/);

  page.switchAddress();
  assert.equal(page.address, NUMBER);
  page.switchAddress();
  assert.equal(page.address, NAME);
});

test('opened by name, the page shows the name even when the computer cannot be asked for details', async () => {
  const page = await openPage('http://study-pc.local:4812', { infoFails: true });
  assert.equal(page.address, NAME);
  assert.equal(page.switchLabel, null);
});

test('on the computer itself the number is shown: a check made there says nothing about the phone', async () => {
  for (const origin of ['http://127.0.0.1:4812', 'http://localhost:4812']) {
    const page = await openPage(origin, { nameAnswers: true });
    assert.equal(page.address, NUMBER, origin);
    assert.match(page.note, /Open this page on the phone/);
    assert.equal(page.switchLabel, 'Use the name address instead');

    page.switchAddress();
    assert.equal(page.address, NAME, origin);
    assert.match(page.note, /not been checked from your phone/);
  }
});

test('Add the shortcut copies the address that is showing', async () => {
  const page = await openPage('http://192.168.1.23:4812', { nameAnswers: true });
  page.addShortcut();
  assert.deepEqual(page.copied, [NAME]);
  assert.match(page.shortcutStatus, /Address copied/);

  page.switchAddress();
  page.addShortcut();
  assert.deepEqual(page.copied, [NAME, NUMBER]);
});

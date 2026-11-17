'use strict';

// What the dashboard says about the address the phone sends to. The page's
// script is run here against a stand-in for the browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'companion', 'web', 'dashboard.js'), 'utf8');

/** Stands in for any element: every property can be read, written or called. */
function anything(initial = {}) {
  const values = new Map(Object.entries(initial));
  return new Proxy(function () {}, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'then') return undefined;
      if (!values.has(key)) values.set(key, anything());
      return values.get(key);
    },
    set(_, key, value) { values.set(key, value); return true; },
    apply() { return anything(); },
  });
}

/** Renders the dashboard for a phone in the given state and returns what it says about it. */
async function phoneSection(phone, network = {}) {
  const state = {
    ok: true, now: Date.now(), version: '1.0.0', computerName: 'study-pc', platform: 'darwin', port: 4812,
    pairing: { baseUrl: 'http://127.0.0.1:4812', token: 'LOCAL' },
    network: {
      addresses: [{ address: '192.168.1.23', interface: 'en0', kind: 'home', virtual: false, primary: true, url: 'http://192.168.1.23:4812/p/TOKEN' }],
      localHostname: 'study-pc.local',
      localUrl: 'http://study-pc.local:4812/p/TOKEN',
      ...network,
    },
    phone: { lastSeenAt: null, lastMessageAt: null, lastCodeAt: null, received: 0, withoutCode: 0, setupAt: null, host: null, hostStale: false, ...phone },
    extension: { lastSeenAt: null, client: null }, extensionPath: null,
    settings: { clipboard: false, clipboardSupported: true }, autostart: { supported: false },
    rev: 0, codes: [], activity: [],
  };
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, anything({ textContent: '', hidden: false, value: '', className: '' }));
    return elements.get(selector);
  };
  vm.runInNewContext(source, {
    document: {
      querySelector: element, querySelectorAll: () => [], createElement: () => anything({ textContent: '' }),
      addEventListener() {}, visibilityState: 'visible', activeElement: null,
    },
    window: {
      localStorage: { getItem: () => null, setItem() {} }, location: { reload() {} },
      addEventListener() {}, postMessage() {}, confirm: () => false,
      OtpBridgeQR: { encode: () => ({}), toSvg: () => '<svg/>' },
    },
    navigator: anything(),
    fetch: () => Promise.resolve({ status: 200, json: () => state }),
    setInterval() {}, setTimeout, clearTimeout,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    state: element('#state-phone').textContent,
    warning: element('#phone-stale').hidden ? null : element('#phone-stale').textContent,
    advice: element('#phone-advice').hidden ? null : element('#phone-advice').textContent,
  };
}

const SET_UP = { setupAt: '2026-01-01T00:00:00.000Z' };

test('a phone that sends to the computer\'s number is told it is tied to this Wi-Fi', async () => {
  const page = await phoneSection({ ...SET_UP, host: '192.168.1.23:4812' });
  assert.equal(page.state, 'Set up · this Wi-Fi only');
  assert.equal(page.warning, null);
  assert.match(page.advice, /192\.168\.1\.23, this computer's number/);
  assert.match(page.advice, /ending in "\.local".*Change the address/);

  // Without a name to offer, the advice does not point at one.
  const noName = await phoneSection({ ...SET_UP, host: '192.168.1.23:4812' }, { localHostname: null, localUrl: null });
  assert.match(noName.advice, /this computer's number/);
  assert.doesNotMatch(noName.advice, /\.local/);
});

test('a phone that sends to the computer\'s name is told nothing more is needed', async () => {
  const page = await phoneSection({ ...SET_UP, host: 'study-pc.local:4812' });
  assert.equal(page.state, 'Set up');
  assert.equal(page.warning, null);
  assert.match(page.advice, /study-pc\.local, this computer's name.*does not need setting up again/);
});

test('once the number has changed, the warning takes over from the advice', async () => {
  const page = await phoneSection({ ...SET_UP, host: '192.168.1.50:4812', hostStale: true });
  assert.equal(page.state, 'Set up');
  assert.match(page.warning, /192\.168\.1\.50:4812.*Change the address/);
  assert.equal(page.advice, null);
});

test('no advice before the phone is set up, or for messages sent from this computer', async () => {
  const fresh = await phoneSection({});
  assert.equal(fresh.state, 'Not set up');
  assert.equal(fresh.advice, null);

  const local = await phoneSection({ ...SET_UP, host: '127.0.0.1:4812' });
  assert.equal(local.state, 'Set up');
  assert.equal(local.advice, null);
});

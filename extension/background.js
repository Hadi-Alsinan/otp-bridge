/*
 * OTP Bridge background script.
 *
 * The only part of the extension that talks to the companion app, at
 * http://127.0.0.1:<port>, using the token it was paired with. Pages never get
 * the token; content scripts ask this script for codes instead.
 *
 * The browser stops and restarts it whenever it likes. Codes and the pairing
 * are not kept in memory, so that does not matter for them. What it remembers
 * of the mailbox between looks is lost in a restart, and mail that arrives
 * around one is left alone (see mail.js).
 */
'use strict';

const api = globalThis.browser ?? globalThis.chrome;

// Chromium runs this file alone and loads the rest here; Firefox loads both
// from the manifest.
if (typeof importScripts === 'function') importScripts('mail.js');
const Mail = globalThis.OtpBridgeMail;

const VERSION = api.runtime.getManifest().version;
const BROWSER = /Firefox\//.test(navigator.userAgent) ? 'firefox'
  : /Edg\//.test(navigator.userAgent) ? 'edge'
    : /OPR\//.test(navigator.userAgent) ? 'opera' : 'chrome';
const CLIENT = `extension/${VERSION} ${BROWSER}`;

const APP_ID = 'otp-bridge';
const FRESH_MS = 3 * 60 * 1000;          // how long a code is offered next to a field
const MENU_MAX_AGE_MS = 10 * 60 * 1000;  // how old a code the right-click menu may use
const MENU_ID = 'otp-bridge-fill';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

// --- pairing ------------------------------------------------------------------

async function getPairing() {
  const { pairing } = await api.storage.local.get('pairing');
  return pairing && typeof pairing.baseUrl === 'string' && typeof pairing.token === 'string' ? pairing : null;
}

/** "http://127.0.0.1:<port>" for a page served by the companion, else null. */
function loopbackBase(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(url.hostname)) return null;
    return `http://127.0.0.1:${url.port || '80'}`;
  } catch {
    return null;
  }
}

async function call(pairing, path, { method = 'GET', body = null, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Authorization: `Bearer ${pairing.token}`, 'X-OTP-Bridge-Client': CLIENT };
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(pairing.baseUrl + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    if (response.status === 401) return { ok: false, error: 'rejected' };
    if (!response.ok) return { ok: false, error: `http-${response.status}` };
    const data = await response.json();
    return data && typeof data === 'object' ? data : { ok: false, error: 'bad-answer' };
  } catch {
    return { ok: false, error: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

async function verify(candidate) {
  const status = await call(candidate, '/api/status', { timeoutMs: 4000 });
  return status.ok === true && status.app === APP_ID;
}

async function savePairing(baseUrl, token) {
  await api.storage.local.set({ pairing: { baseUrl, token, pairedAt: Date.now() } });
}

/**
 * The dashboard page offers its token. A first pairing is accepted, and so is
 * a new token from the address already paired with. Switching to a different
 * address needs the user to disconnect in the popup first: any page served
 * from this computer could otherwise point the extension at itself.
 */
async function handlePairOffer(message, sender) {
  const baseUrl = loopbackBase(sender.url || '');
  if (!baseUrl || sender.frameId !== 0) return { ok: false, reason: 'not-local' };
  if (typeof message.token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(message.token)) {
    return { ok: false, reason: 'bad-token' };
  }
  const current = await getPairing();
  if (current && current.baseUrl === baseUrl && current.token === message.token) {
    return { ok: await verify(current), reason: 'unreachable', version: VERSION };
  }
  if (current && current.baseUrl !== baseUrl) {
    return { ok: false, reason: 'paired-elsewhere', version: VERSION };
  }
  const candidate = { baseUrl, token: message.token };
  if (!await verify(candidate)) return { ok: false, reason: 'unreachable', version: VERSION };
  await savePairing(baseUrl, message.token);
  return { ok: true, version: VERSION };
}

/** The popup's manual route: the private dashboard link, pasted by the user. */
async function handlePairLink(message) {
  let url;
  try {
    url = new URL(String(message.link || '').trim());
  } catch {
    return { ok: false, reason: 'bad-link' };
  }
  const baseUrl = loopbackBase(url.href);
  const token = url.searchParams.get('k');
  if (!baseUrl || !token) return { ok: false, reason: 'bad-link' };
  if (!await verify({ baseUrl, token })) return { ok: false, reason: 'unreachable' };
  await savePairing(baseUrl, token);
  return { ok: true };
}

// --- codes --------------------------------------------------------------------

function forPage(entry) {
  return {
    id: entry.id,
    code: entry.code,
    sender: entry.sender || null,
    receivedAt: entry.receivedAt,
    domain: entry.domain || null,
    frameDomain: entry.frameDomain || null,
  };
}

async function handlePoll(message) {
  const pairing = await getPairing();
  if (!pairing) return { ok: false, error: 'unpaired' };
  const rev = Number(message.rev) || 0;
  const wait = Math.max(0, Math.min(20, Number(message.wait) || 0));
  // A page asks only while it shows a code field, so this is when a code in
  // the mailbox is worth looking for. The companion answers as soon as it has one.
  const stopWatching = watchMail(pairing);
  let answer;
  try {
    answer = await call(pairing, `/api/codes?rev=${rev}&wait=${wait}`, { timeoutMs: (wait + 6) * 1000 });
  } finally {
    stopWatching();
  }
  if (!answer.ok) return { ok: false, error: answer.error || 'offline' };
  const codes = (answer.codes || [])
    .filter((entry) => !entry.usedAt && answer.now - entry.receivedAt < FRESH_MS)
    .map(forPage);
  return { ok: true, rev: answer.rev, now: answer.now, freshMs: FRESH_MS, codes };
}

async function handleUsed(message) {
  const pairing = await getPairing();
  if (!pairing || !/^[a-f0-9]{1,64}$/.test(String(message.id))) return { ok: false };
  return call(pairing, `/api/codes/${message.id}/used`, { method: 'POST', body: {} });
}

async function handleStatus() {
  const pairing = await getPairing();
  if (!pairing) return { ok: true, paired: false };
  const state = await call(pairing, '/api/state', { timeoutMs: 4000 });
  if (!state.ok) return { ok: true, paired: true, online: false, error: state.error, baseUrl: pairing.baseUrl };
  return {
    ok: true,
    paired: true,
    online: true,
    now: state.now,
    version: state.version,
    computerName: state.computerName,
    dashboardUrl: `${pairing.baseUrl}/?k=${encodeURIComponent(pairing.token)}`,
    phone: {
      setupAt: state.phone.setupAt,
      lastCodeAt: state.phone.lastCodeAt,
      hostStale: state.phone.hostStale === true,
    },
    codes: (state.codes || []).map((entry) => ({ ...forPage(entry), preview: entry.preview || null, usedAt: entry.usedAt })),
  };
}

// --- codes that arrive by email ---------------------------------------------------
//
// Gmail gives a browser that is signed in to it a list of its unread mail. With
// the user's say-so (a switch in the popup), that list is read while a page
// waits for a code, and what is new in it goes to the companion on this
// computer, which finds the code. Nothing of the mail is stored here: only
// which entries were listed, when, and a mark that stands for their words.

const MAIL_ORIGIN = 'https://mail.google.com';
const MAIL_ACCESS = { origins: [`${MAIL_ORIGIN}/*`] };
const MAIL_MAX_ACCOUNTS = 4;               // Google accounts signed in side by side
const MAIL_QUICK_MS = 4000;                // how often to look while a code is expected
const MAIL_QUICK_FOR_MS = 3 * 60 * 1000;   // after this long without a break, look less often
const MAIL_SLOW_MS = 15000;
const MAIL_SEEN_MAX = 2000;                // entries remembered: an earlier email is only recognised while it is one of them

let mailLook = null;         // the look in progress; pages that wait together share it
let mailLookedAt = 0;
let mailWantedAt = 0;        // when a page last waited for a code
let mailWaitingSince = 0;    // when the current stretch of waiting began
let mailAccounts = { count: MAIL_MAX_ACCOUNTS, at: 0 };
const mailPrevious = new Map();   // account -> what its list looked like at the last look

async function mailSwitchedOn() {
  const { mail } = await api.storage.local.get('mail');
  return !!mail && mail.on === true;
}

async function mailAllowed() {
  try {
    return !!api.permissions && await api.permissions.contains(MAIL_ACCESS);
  } catch {
    return false;
  }
}

/** One signed-in account's unread mail, or what went wrong. */
async function readMailbox(index) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${MAIL_ORIGIN}/mail/u/${index}/feed/atom`, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return { problem: 'signed-out' };
    if (!response.ok) return { problem: 'unreadable' };
    const feed = Mail.parseFeed(await response.text());
    if (!feed) return { problem: 'signed-out' };   // a sign-in page came back instead
    // Gmail's own clock decides what is recent, so a wrong clock here does not matter.
    return { feed, now: Date.parse(response.headers.get('date') || '') || Date.now() };
  } catch {
    return { problem: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function readMail() {
  const known = Date.now() - mailAccounts.at < 5 * 60 * 1000;
  const limit = known ? mailAccounts.count : MAIL_MAX_ACCOUNTS;
  const boxes = [];
  let problem = null;
  for (let index = 0; index < limit; index += 1) {
    const box = await readMailbox(index);
    if (box.problem) {
      if (index === 0) problem = box.problem;
      break;
    }
    // A number past the last account can show an earlier account again.
    const account = box.feed.account;
    if (index > 0 && (!account || boxes.some((other) => other.feed.account === account))) break;
    boxes.push(box);
  }
  if (!known && boxes.length) mailAccounts = { count: boxes.length, at: Date.now() };
  return { boxes, problem };
}

/** One look at the mailbox. Null when the user has it switched off. */
async function lookAtMail(pairing) {
  // Asked every time: the switch can be turned off while a page is still waiting.
  if (!await mailSwitchedOn() || !await mailAllowed()) return null;
  const { boxes, problem } = await readMail();
  const { mailSeen } = await api.storage.local.get('mailSeen');
  const known = Array.isArray(mailSeen) ? mailSeen.filter((note) => note && typeof note === 'object') : [];
  const fresh = [];
  const skipped = [];
  const notes = [];
  const looks = [];
  boxes.forEach((box, index) => {
    const key = box.feed.account || `#${index}`;
    const sorted = Mail.sortMail(box.feed, { now: box.now, maxAgeMs: FRESH_MS, known, previous: mailPrevious.get(key) });
    fresh.push(...sorted.fresh);
    skipped.push(...sorted.skipped);
    notes.push(...sorted.notes);
    looks.push([key, sorted.look]);
  });
  if ((fresh.length || skipped.length) && pairing) {
    const answer = await call(pairing, '/api/mail', {
      method: 'POST',
      body: {
        messages: fresh.map(({ from, text }) => ({ from, text })),
        // Mail whose code could not be read safely. The companion says why on the dashboard.
        skipped: skipped.map(({ from, reason }) => ({ from, reason })),
      },
    });
    // Not handed over (the companion is not running): nothing is remembered,
    // so the next look sees the same mail against the same earlier look.
    if (answer.ok !== true) return { accounts: boxes.map((box) => box.feed.account).filter(Boolean), problem };
  }
  // Everything listed is remembered: an entry is not looked at twice, its
  // words are known the next time, and this look is what the next is compared with.
  for (const [key, look] of looks) mailPrevious.set(key, look);
  const same = (x, y) => x.id === y.id && x.at === y.at && x.mark === y.mark;
  if (notes.some((note) => !known.some((old) => same(old, note)))) {
    const merged = [...known.filter((old) => !notes.some((note) => same(old, note))), ...notes];
    await api.storage.local.set({ mailSeen: merged.slice(-MAIL_SEEN_MAX) });
  }
  return { accounts: boxes.map((box) => box.feed.account).filter(Boolean), problem };
}

function startLook(pairing) {
  if (!mailLook) {
    mailLookedAt = Date.now();
    mailLook = lookAtMail(pairing)
      .catch(() => ({ accounts: [], problem: 'unreachable' }))
      .finally(() => { mailLook = null; });
  }
  return mailLook;
}

/** Looks again if it is time. Every page that waits calls this once a second. */
function lookIfDue(pairing) {
  const now = Date.now();
  if (now - mailWantedAt > 30000) mailWaitingSince = now;   // nobody was waiting: a new stretch begins
  mailWantedAt = now;
  const every = now - mailWaitingSince < MAIL_QUICK_FOR_MS ? MAIL_QUICK_MS : MAIL_SLOW_MS;
  if (!mailLook && now - mailLookedAt >= every) startLook(pairing);
}

/** Watches the mailbox for as long as a page waits for a code. Returns the way to stop. */
function watchMail(pairing) {
  lookIfDue(pairing);
  const timer = setInterval(() => lookIfDue(pairing), 1000);
  return () => clearInterval(timer);
}

/** For the popup: is it on, and does Gmail answer right now? */
async function handleMailStatus() {
  // Asked first: a look that began before the switch was turned off must not answer "on".
  if (!await mailSwitchedOn() || !await mailAllowed()) return { ok: true, on: false };
  const look = await startLook(await getPairing());
  return look ? { ok: true, on: true, ...look } : { ok: true, on: false };
}

async function handleMailSet(message) {
  await api.storage.local.set({ mail: { on: message.on === true } });
  if (message.on !== true) {
    mailAccounts = { count: MAIL_MAX_ACCOUNTS, at: 0 };
    mailPrevious.clear();
  }
  return { ok: true };
}

// --- messages -----------------------------------------------------------------

function isOwnPage(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(api.runtime.getURL(''));
}

async function handleMessage(message, sender) {
  if (!message || typeof message !== 'object' || sender.id !== api.runtime.id) return { ok: false };
  switch (message.type) {
    // From content scripts on web pages.
    case 'poll': return handlePoll(message);
    case 'used': return handleUsed(message);
    case 'pair-offer': return handlePairOffer(message, sender);
    // From the extension's own popup only.
    case 'status': return isOwnPage(sender) ? handleStatus() : { ok: false };
    case 'pair-link': return isOwnPage(sender) ? handlePairLink(message) : { ok: false };
    case 'mail-status': return isOwnPage(sender) ? handleMailStatus() : { ok: false };
    case 'mail-set': return isOwnPage(sender) ? handleMailSet(message) : { ok: false };
    case 'unpair':
      if (!isOwnPage(sender)) return { ok: false };
      await api.storage.local.remove('pairing');
      return { ok: true };
    default: return { ok: false };
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
  return true;   // the answer comes later
});

// --- right-click menu ----------------------------------------------------------

function createMenu() {
  if (!api.contextMenus) return;
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({
      id: MENU_ID,
      title: 'Fill in the code from my phone',
      contexts: ['editable'],
    }, () => void api.runtime.lastError);
  });
}

api.runtime.onInstalled.addListener(createMenu);
api.runtime.onStartup.addListener(createMenu);

if (api.contextMenus) {
  api.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
    const options = info.frameId != null ? { frameId: info.frameId } : undefined;
    const tell = (message) => api.tabs.sendMessage(tab.id, message, options).catch(() => {});

    const pairing = await getPairing();
    if (!pairing) {
      tell({ type: 'notice', text: 'OTP Bridge is not connected yet. Click its toolbar icon to set it up.' });
      return;
    }
    const answer = await call(pairing, '/api/codes');
    if (!answer.ok) {
      tell({ type: 'notice', text: 'OTP Bridge is not running on this computer.' });
      return;
    }
    const recent = (answer.codes || []).filter((entry) => answer.now - entry.receivedAt < MENU_MAX_AGE_MS);
    const entry = recent.find((e) => !e.usedAt) || recent[0];
    if (!entry) {
      tell({ type: 'notice', text: 'No code has arrived from your phone in the last 10 minutes.' });
      return;
    }
    tell({ type: 'fill', mode: 'context', code: entry.code, id: entry.id });
  });
}

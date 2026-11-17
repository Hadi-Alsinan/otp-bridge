/*
 * OTP Bridge background script.
 *
 * The only part of the extension that talks to the companion app, at
 * http://127.0.0.1:<port>, using the token it was paired with. Pages never get
 * the token; content scripts ask this script for codes instead.
 *
 * It keeps no state in memory between messages, so it does not matter that
 * the browser stops and restarts it whenever it likes.
 */
'use strict';

const api = globalThis.browser ?? globalThis.chrome;

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
  const answer = await call(pairing, `/api/codes?rev=${rev}&wait=${wait}`, { timeoutMs: (wait + 6) * 1000 });
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

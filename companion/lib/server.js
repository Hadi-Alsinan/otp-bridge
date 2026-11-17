'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { extractOtp } = require('./otp-parser');
const { CodeStore } = require('./store');
const { newToken } = require('./config');
const netinfo = require('./netinfo');

const APP_ID = 'otp-bridge';
const SESSION_COOKIE = 'otp_bridge_session';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_LONG_POLL_SECONDS = 25;
const MAX_WAITERS = 200;
const BAD_TOKEN_LIMIT = 30;           // wrong phone links per minute, per address
const TEST_SENDER = 'OTP Bridge test';

const ASSETS = {
  'app.css': 'text/css; charset=utf-8',
  'dashboard.js': 'text/javascript; charset=utf-8',
  'phone.js': 'text/javascript; charset=utf-8',
  'demo.js': 'text/javascript; charset=utf-8',
  'qr.js': 'text/javascript; charset=utf-8',
  'icon.svg': 'image/svg+xml',
  // The iPhone shortcut, built and signed by scripts/make-shortcut.js.
  'otp-bridge.shortcut': 'application/octet-stream',
};

// Assets that are saved rather than shown. The Shortcuts app names the
// shortcut after the file, so the phone has to receive it under this name.
const DOWNLOAD_NAMES = {
  'otp-bridge.shortcut': 'OTP Bridge.shortcut',
};

const TEXT_FIELDS = ['message', 'text', 'body', 'content', 'sms', 'msg', 'smsbody', 'messagebody',
  'data', 'value1', 'value', 'payload', 'notification', 'bigtext', 'description'];
const SENDER_FIELDS = ['sender', 'from', 'number', 'phone', 'phonenumber', 'address', 'originatingaddress',
  'title', 'contact', 'name'];

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'too-large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!failed) { failed = true; reject(new HttpError(400, 'bad-request')); } });
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    throw new HttpError(400, 'bad-json');
  }
}

function cleanLine(value, max) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function stringify(value, depth = 0) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth > 2) return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => stringify(v, depth + 1)).filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  if (typeof value === 'object') return pickFields(value, depth + 1).text;
  return null;
}

/** Finds the message text (and sender, if any) in whatever shape the phone sent. */
function pickFields(obj, depth = 0) {
  const lower = new Map();
  for (const [key, value] of Object.entries(obj)) lower.set(key.toLowerCase().replace(/[^a-z0-9]/g, ''), value);

  let text = null;
  for (const field of TEXT_FIELDS) {
    if (lower.has(field)) {
      text = stringify(lower.get(field), depth);
      if (text && text.trim()) break;
      text = null;
    }
  }
  let sender = null;
  for (const field of SENDER_FIELDS) {
    const value = lower.get(field);
    if (typeof value === 'string' || typeof value === 'number') {
      sender = String(value);
      if (sender.trim()) break;
      sender = null;
    }
  }
  if (text == null) {
    // Unknown field names: take the longest piece of text that was sent.
    let longest = null;
    for (const value of lower.values()) {
      if (typeof value === 'string' && (!longest || value.length > longest.length)) longest = value;
    }
    if (longest && longest !== sender) text = longest;
  }
  return { text, sender };
}

/** Whether parsed JSON holds any text or number at all, however it is nested. */
function carriesText(value, depth = 0) {
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return true;
  if (depth > 20) return true;
  if (value && typeof value === 'object') return Object.values(value).some((v) => carriesText(v, depth + 1));
  return false;
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!match) return null;
  const boundary = `--${match[1] || match[2]}`;
  const fields = {};
  for (const part of buffer.toString('utf8').split(boundary)) {
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const name = /content-disposition:[^\r\n]*\bname="([^"]*)"/i.exec(part.slice(0, split));
    if (!name) continue;
    fields[name[1]] = part.slice(split + 4).replace(/\r\n$/, '');
  }
  return fields;
}

/**
 * Accepts JSON, form posts (url-encoded or multipart), plain text, or query
 * parameters, so that iOS Shortcuts and the various Android SMS forwarders
 * all work without special settings.
 */
function parseIncomingMessage(buffer, contentType, searchParams) {
  const type = String(contentType || '').toLowerCase();
  const raw = buffer.toString('utf8');
  let found = { text: null, sender: null };
  let blankJson = false;

  if (type.includes('json') || /^\s*[[{"]/.test(raw)) {
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'string') found.text = value;
      else if (Array.isArray(value)) found.text = stringify(value);
      else if (value && typeof value === 'object') found = pickFields(value);
      // {"message": ""} is an empty message, not a message that reads '{"message": ""}'.
      // The iPhone shortcut sends exactly that when the automation hands it nothing.
      blankJson = value !== null && typeof value === 'object' && !carriesText(value);
    } catch {
      // not JSON after all; treated as plain text below
    }
  }
  if (found.text == null && type.includes('multipart/form-data')) {
    const fields = parseMultipart(buffer, contentType);
    if (fields) found = pickFields(fields);
  }
  if (found.text == null && type.includes('x-www-form-urlencoded')) {
    found = pickFields(Object.fromEntries(new URLSearchParams(raw)));
  }
  if (found.text == null && raw.trim() && !blankJson && !type.includes('multipart/form-data')) {
    found.text = raw;
  }
  if (searchParams) {
    const fromQuery = pickFields(Object.fromEntries(searchParams));
    if (found.text == null) found.text = fromQuery.text;
    if (found.sender == null) found.sender = fromQuery.sender;
  }

  const text = found.text == null ? '' : String(found.text).slice(0, MAX_MESSAGE_CHARS).trim();
  const sender = found.sender == null ? null : cleanLine(found.sender, 64) || null;
  return { text, sender };
}

function hostIsLoopback(hostHeader, port) {
  const match = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(String(hostHeader || '').trim());
  if (!match) return false;
  return Number(match[2] || 80) === port;
}

// ---------------------------------------------------------------------------
// The companion
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.config          Loaded config (tokens, port, settings).
 * @param {(config: object) => void} [options.persist]  Saves config changes.
 * @param {string} [options.version]
 * @param {object} [options.clipboard]     { supported: boolean, copy(text): Promise<boolean> }
 * @param {object} [options.autostart]     { supported, status(): object, enable(): object, disable(): object }
 * @param {string} [options.extensionPath] Folder of the browser extension, shown in the setup steps.
 * @param {() => void} [options.onShutdown] Called when "stop" is requested through the API.
 * @param {(line: string) => void} [options.log]
 */
function createCompanion(options) {
  const config = options.config;
  const persist = options.persist || (() => {});
  const version = options.version || '0.0.0';
  const webDir = options.webDir || path.join(__dirname, '..', 'web');
  const now = options.now || Date.now;
  const log = options.log || (() => {});
  const clipboard = options.clipboard || { supported: false, copy: async () => false };
  const autostart = options.autostart || null;
  const extensionPath = options.extensionPath || null;
  const onShutdown = options.onShutdown || null;
  const store = options.store || new CodeStore({ now });

  const state = {
    startedAt: now(),
    phone: { lastSeenAt: null, lastMessageAt: null, lastCodeAt: null, received: 0, withoutCode: 0 },
    extension: { lastSeenAt: null, client: null },
    activity: [],
  };
  const badTokenHits = new Map();
  let boundPort = null;
  let waiters = 0;
  let networkCache = null;
  let localHostname;

  function note(kind, text) {
    state.activity.unshift({ at: now(), kind, text });
    if (state.activity.length > 30) state.activity.length = 30;
    log(text);
  }

  /**
   * Like note(), for something that happens many times in a row: the run is
   * one line with a count, and is written to the log once.
   * @param {(count: number) => string} wording
   */
  function noteRepeated(kind, key, wording) {
    const latest = state.activity[0];
    if (latest && latest.key === key) {
      latest.count += 1;
      latest.at = now();
      latest.text = wording(latest.count);
      return;
    }
    state.activity.unshift({ at: now(), kind, text: wording(1), key, count: 1 });
    if (state.activity.length > 30) state.activity.length = 30;
    log(wording(1));
  }

  // --- responses -----------------------------------------------------------

  function baseHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
  }

  function sendJson(res, status, payload) {
    if (res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function sendHtml(res, status, html) {
    const csp = [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      // The phone page probes whether "<name>.local" reaches this computer.
      `connect-src 'self' http://*.local:${boundPort}`,
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Frame-Options': 'DENY',
    });
    res.end(html);
  }

  function sendPage(res, file) {
    sendHtml(res, 200, fs.readFileSync(path.join(webDir, file), 'utf8'));
  }

  function sendLocked(res) {
    sendHtml(res, 403, `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>OTP Bridge</title>
<link rel="stylesheet" href="/assets/app.css"></head><body><main class="locked">
<h1>OTP Bridge is running</h1>
<p>This page needs the private link that was shown when OTP Bridge started.</p>
<p>Open that link, or run <code>node companion/cli.js open</code> in the OTP Bridge folder.</p>
</main></body></html>`);
  }

  // --- who is asking? ------------------------------------------------------

  function remoteAddress(req) {
    return String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
  }

  /** True only for requests made from this computer to its own loopback name. */
  function isLocalRequest(req) {
    return netinfo.isLoopbackAddress(req.socket.remoteAddress) && hostIsLoopback(req.headers.host, boundPort);
  }

  function authenticate(req) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && /^Bearer /i.test(header)) {
      return safeEqual(header.slice(7).trim(), config.localToken) ? 'bearer' : null;
    }
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return cookie && safeEqual(cookie, config.localToken) ? 'cookie' : null;
  }

  /** Cookie-authenticated writes must come from our own pages. */
  function isOwnPageRequest(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return false;
    return req.headers['x-otp-bridge'] === '1';
  }

  function isExtensionOrigin(origin) {
    return typeof origin === 'string' && /^(?:chrome|moz|safari-web)-extension:\/\/[a-z0-9-]+$/i.test(origin);
  }

  function tooManyBadTokens(address) {
    const t = now();
    const hit = badTokenHits.get(address);
    if (!hit || hit.resetAt <= t) return false;
    return hit.count >= BAD_TOKEN_LIMIT;
  }

  function recordBadToken(address) {
    const t = now();
    if (badTokenHits.size > 1000) badTokenHits.clear();
    const hit = badTokenHits.get(address);
    if (!hit || hit.resetAt <= t) badTokenHits.set(address, { count: 1, resetAt: t + 60 * 1000 });
    else hit.count += 1;
  }

  // --- network info for the pairing screen ---------------------------------

  async function networkInfo() {
    const t = now();
    if (networkCache && t - networkCache.at < 4000) return networkCache.value;
    if (localHostname === undefined) localHostname = await netinfo.detectLocalHostname();
    const primary = await netinfo.detectPrimaryAddress();
    const addresses = netinfo.listLanAddresses(primary);
    const value = { addresses, localHostname };
    networkCache = { at: t, value };
    return value;
  }

  /**
   * The number a phone should send to. That is the address this request
   * arrived on; when the page is opened on the computer itself, the best guess.
   */
  function phoneFacingAddress(req, addresses) {
    const reached = String(req.socket.localAddress || '').replace(/^::ffff:/i, '');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(reached) && !netinfo.isLoopbackAddress(reached)) return reached;
    return addresses.length ? addresses[0].address : null;
  }

  // --- messages from the phone ---------------------------------------------

  /** Remembers that the phone is set up, and which address it sends to. */
  function rememberPhone(hostHeader) {
    const host = cleanLine(hostHeader || '', 120).toLowerCase();
    const known = config.phone || {};
    if (known.setupAt && known.host === host) return;
    config.phone = { setupAt: known.setupAt || new Date(now()).toISOString(), host };
    persist(config);
  }

  /** True when the phone still sends to an IP address this computer no longer has. */
  function phoneHostIsStale(addresses) {
    const host = config.phone && config.phone.host;
    if (!host) return false;
    const name = host.replace(/:\d+$/, '');
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) || netinfo.isLoopbackAddress(name)) return false;
    return !addresses.some((a) => a.address === name);
  }

  function acceptMessage(text, sender) {
    const result = extractOtp(text);
    if (!result) return { codeFound: false };
    const preview = cleanLine(text, 140);
    const { entry, duplicate } = store.add({
      code: result.code, sender, preview, domain: result.domain || null, frameDomain: result.frameDomain || null,
    });
    if (!duplicate && config.clipboard && clipboard.supported) {
      clipboard.copy(entry.code).catch(() => {});
    }
    return { codeFound: true, duplicate, entry };
  }

  async function handlePhone(req, res, url, token, sub) {
    const address = remoteAddress(req);
    if (tooManyBadTokens(address)) throw new HttpError(429, 'slow-down');
    if (!safeEqual(token, config.phoneToken)) {
      recordBadToken(address);
      throw new HttpError(404, 'not-found');
    }
    state.phone.lastSeenAt = now();

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (sub === 'info') {
        const net = await networkInfo();
        sendJson(res, 200, {
          ok: true,
          app: APP_ID,
          version,
          computerName: netinfo.computerName(),
          port: boundPort,
          address: phoneFacingAddress(req, net.addresses),
          localHostname: net.localHostname,
        });
        return;
      }
      if (sub) throw new HttpError(405, 'use-post');
      sendPage(res, 'phone.html');
      return;
    }
    if (req.method !== 'POST' && req.method !== 'PUT') throw new HttpError(405, 'use-post');
    if (sub === 'info') throw new HttpError(405, 'use-get');

    const body = await readBody(req);
    const { text, sender } = parseIncomingMessage(body, req.headers['content-type'], url.searchParams);
    if (!text) {
      note('warn', 'The phone sent an empty message. In the automation on the phone, the message has to be passed on as Shortcut Input.');
      throw new HttpError(400, 'empty-message');
    }
    // The "send a test code" button on the phone's setup page.
    const isTest = url.searchParams.get('test') === '1';
    if (isTest) {
      const outcome = acceptMessage(text, TEST_SENDER);
      if (outcome.codeFound && !outcome.duplicate) note('code', 'Test code received from the phone.');
      sendJson(res, 200, { ok: true, codeFound: outcome.codeFound });
      return;
    }

    rememberPhone(req.headers.host);
    state.phone.lastMessageAt = now();
    state.phone.received += 1;
    const outcome = acceptMessage(text, sender);
    if (outcome.codeFound) {
      state.phone.lastCodeAt = now();
      if (!outcome.duplicate) note('code', 'Code received from the phone.');
    } else {
      state.phone.withoutCode += 1;
      // An iPhone passes on every text with a number in it, so these come in runs.
      noteRepeated('info', 'no-code', (count) => (count === 1
        ? 'A message arrived from the phone, but there was no code in it.'
        : `${count} messages arrived from the phone, but there was no code in them.`));
    }
    // The code is never echoed back to the sender.
    sendJson(res, 200, { ok: true, codeFound: outcome.codeFound });
  }

  // --- API for the dashboard and the browser extension ---------------------

  function publicCode(entry) {
    return {
      id: entry.id,
      code: entry.code,
      sender: entry.sender,
      preview: entry.preview,
      domain: entry.domain || null,
      frameDomain: entry.frameDomain || null,
      receivedAt: entry.receivedAt,
      usedAt: entry.usedAt,
    };
  }

  function phoneUrl(host) {
    return `http://${host}:${boundPort}/p/${config.phoneToken}`;
  }

  async function fullState() {
    const net = await networkInfo();
    return {
      ok: true,
      app: APP_ID,
      version,
      now: now(),
      startedAt: state.startedAt,
      computerName: netinfo.computerName(),
      platform: process.platform,
      port: boundPort,
      pairing: { baseUrl: `http://127.0.0.1:${boundPort}`, token: config.localToken },
      network: {
        addresses: net.addresses.map((a) => ({ ...a, url: phoneUrl(a.address) })),
        localHostname: net.localHostname,
        localUrl: net.localHostname ? phoneUrl(net.localHostname) : null,
      },
      phone: {
        ...state.phone,
        setupAt: (config.phone && config.phone.setupAt) || null,
        host: (config.phone && config.phone.host) || null,
        hostStale: phoneHostIsStale(net.addresses),
      },
      extension: { ...state.extension },
      extensionPath,
      settings: { clipboard: config.clipboard === true, clipboardSupported: clipboard.supported === true },
      autostart: autostart ? safeAutostartStatus() : { supported: false },
      rev: store.rev,
      codes: store.list().map(publicCode),
      activity: state.activity.slice(0, 12).map(({ at, kind, text }) => ({ at, kind, text })),
    };
  }

  function safeAutostartStatus() {
    try {
      return autostart.status();
    } catch (err) {
      return { supported: false, error: String(err.message || err) };
    }
  }

  async function handleApi(req, res, url) {
    const origin = req.headers.origin;
    const fromExtension = isExtensionOrigin(origin);
    if (fromExtension) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!fromExtension) throw new HttpError(403, 'forbidden');
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE',
        'Access-Control-Allow-Headers': 'authorization, content-type, x-otp-bridge-client',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    const auth = authenticate(req);
    if (!auth) throw new HttpError(401, 'unauthorized');
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
    if (isWrite && auth === 'cookie' && !isOwnPageRequest(req)) throw new HttpError(403, 'forbidden');

    const client = req.headers['x-otp-bridge-client'];
    if (auth === 'bearer' && typeof client === 'string' && client) {
      if (!state.extension.lastSeenAt) note('info', 'Browser extension connected.');
      state.extension.lastSeenAt = now();
      state.extension.client = cleanLine(client, 80);
    }

    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/status') {
      sendJson(res, 200, { ok: true, app: APP_ID, version });
      return;
    }

    if (route === 'GET /api/state') {
      sendJson(res, 200, await fullState());
      return;
    }

    if (route === 'GET /api/codes') {
      const known = Number(url.searchParams.get('rev')) || 0;
      const wait = Math.max(0, Math.min(MAX_LONG_POLL_SECONDS, Number(url.searchParams.get('wait')) || 0));
      if (wait > 0 && store.rev === known && waiters < MAX_WAITERS) {
        waiters += 1;
        const pending = store.waitForChange(known, wait * 1000);
        res.on('close', () => pending.cancel());
        try {
          await pending;
        } finally {
          waiters -= 1;
        }
      }
      sendJson(res, 200, { ok: true, rev: store.rev, now: now(), codes: store.list().map(publicCode) });
      return;
    }

    const codeAction = /^\/api\/codes\/([a-f0-9]{1,64})(\/used)?$/.exec(url.pathname);
    if (codeAction && req.method === 'POST' && codeAction[2]) {
      await readBody(req);
      sendJson(res, 200, { ok: store.markUsed(codeAction[1]) });
      return;
    }
    if (codeAction && req.method === 'DELETE' && !codeAction[2]) {
      sendJson(res, 200, { ok: store.remove(codeAction[1]) });
      return;
    }
    if (route === 'DELETE /api/codes') {
      store.clear();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === 'POST /api/test') {
      const body = await readJson(req);
      let text = typeof body.message === 'string' ? body.message.slice(0, MAX_MESSAGE_CHARS) : '';
      if (!text.trim()) {
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        text = `Your OTP Bridge test code is ${code}`;
      }
      const outcome = acceptMessage(text, TEST_SENDER);
      if (outcome.codeFound) note('code', 'Test code created.');
      sendJson(res, 200, { ok: true, codeFound: outcome.codeFound, code: outcome.codeFound ? outcome.entry.code : null });
      return;
    }

    if (route === 'POST /api/check') {
      const body = await readJson(req);
      const text = typeof body.message === 'string' ? body.message.slice(0, MAX_MESSAGE_CHARS) : '';
      const result = extractOtp(text);
      sendJson(res, 200, { ok: true, code: result ? result.code : null });
      return;
    }

    if (route === 'POST /api/settings') {
      const body = await readJson(req);
      if (typeof body.clipboard === 'boolean') {
        config.clipboard = body.clipboard;
        persist(config);
      }
      sendJson(res, 200, { ok: true, settings: { clipboard: config.clipboard === true } });
      return;
    }

    if (route === 'POST /api/reset-phone-link') {
      await readBody(req);
      config.phoneToken = newToken();
      delete config.phone;
      persist(config);
      state.phone = { lastSeenAt: null, lastMessageAt: null, lastCodeAt: null, received: 0, withoutCode: 0 };
      note('info', 'The phone link was reset. Update the address on your phone.');
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === 'POST /api/autostart') {
      const body = await readJson(req);
      if (!autostart) throw new HttpError(501, 'not-supported');
      try {
        const result = body.enabled ? autostart.enable() : autostart.disable();
        note('info', body.enabled ? 'Start at login turned on.' : 'Start at login turned off.');
        sendJson(res, 200, { ok: true, autostart: result });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: String(err.message || err) });
      }
      return;
    }

    if (route === 'POST /api/shutdown') {
      await readBody(req);
      if (!onShutdown) throw new HttpError(501, 'not-supported');
      sendJson(res, 200, { ok: true });
      setImmediate(onShutdown);
      return;
    }

    throw new HttpError(404, 'not-found');
  }

  // --- pages for this computer's browser -----------------------------------

  function handlePage(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'use-get');
    const key = url.searchParams.get('k');
    if (key !== null) {
      if (!safeEqual(key, config.localToken)) {
        sendLocked(res);
        return;
      }
      // Trade the link for a cookie so the token does not stay in the address bar.
      res.writeHead(302, {
        'Set-Cookie': `${SESSION_COOKIE}=${config.localToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
        Location: url.pathname,
      });
      res.end();
      return;
    }
    if (authenticate(req) !== 'cookie') {
      sendLocked(res);
      return;
    }
    sendPage(res, url.pathname === '/' ? 'dashboard.html' : 'demo.html');
  }

  function handleAsset(req, res, name) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'use-get');
    const type = Object.prototype.hasOwnProperty.call(ASSETS, name) ? ASSETS[name] : null;
    if (!type) throw new HttpError(404, 'not-found');
    const body = fs.readFileSync(path.join(webDir, name));
    const headers = { 'Content-Type': type, 'Content-Length': body.length };
    if (Object.prototype.hasOwnProperty.call(DOWNLOAD_NAMES, name)) {
      headers['Content-Disposition'] = `attachment; filename="${DOWNLOAD_NAMES[name]}"`;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // --- router ---------------------------------------------------------------

  async function route(req, res) {
    baseHeaders(res);
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) throw new HttpError(400, 'bad-request');
    let url;
    try {
      url = new URL(req.url, 'http://otp-bridge.invalid');
    } catch {
      throw new HttpError(400, 'bad-request');
    }
    const { pathname } = url;

    if (pathname === '/ping') {
      // Lets the phone page test whether a host name reaches this computer.
      res.setHeader('Access-Control-Allow-Origin', '*');
      sendJson(res, 200, { ok: true, app: APP_ID });
      return;
    }
    if (pathname.startsWith('/assets/')) {
      handleAsset(req, res, pathname.slice('/assets/'.length));
      return;
    }
    const phone = /^\/p\/([A-Za-z0-9_-]{1,128})(?:\/(info|sms))?\/?$/.exec(pathname);
    if (phone) {
      await handlePhone(req, res, url, phone[1], phone[2] === 'sms' ? null : phone[2] || null);
      return;
    }

    // Everything below is for this computer only.
    if (!isLocalRequest(req)) throw new HttpError(404, 'not-found');
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (pathname === '/' || pathname === '/demo') {
      handlePage(req, res, url);
      return;
    }
    throw new HttpError(404, 'not-found');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { ok: false, error: err.code });
      } else {
        log(`Unexpected error: ${err && err.message}`);
        sendJson(res, 500, { ok: false, error: 'internal-error' });
      }
    });
  });
  server.requestTimeout = 30 * 1000;
  server.headersTimeout = 15 * 1000;
  server.maxHeadersCount = 100;

  return {
    server,
    store,
    state,
    get port() { return boundPort; },
    /** Starts listening. Rejects with the original error (e.g. EADDRINUSE). */
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen({ port, host, exclusive: true }, () => {
          server.removeListener('error', onError);
          boundPort = server.address().port;
          resolve(boundPort);
        });
      });
    },
    close() {
      store.close();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

module.exports = {
  APP_ID,
  SESSION_COOKIE,
  createCompanion,
  parseIncomingMessage,
  hostIsLoopback,
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');

const { createCompanion, parseIncomingMessage, hostIsLoopback, SESSION_COOKIE } = require('../companion/lib/server');
const { newToken } = require('../companion/lib/config');

const LOCAL_TOKEN = newToken();
const PHONE_TOKEN = newToken();

/** A non-loopback IPv4 address of this machine, to play the part of "the phone". */
function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return null;
}

async function start(overrides = {}) {
  const saved = [];
  const copied = [];
  const config = { port: 0, localToken: LOCAL_TOKEN, phoneToken: PHONE_TOKEN, clipboard: false, ...overrides.config };
  const app = createCompanion({
    config,
    version: '9.9.9',
    persist: (c) => saved.push(JSON.parse(JSON.stringify(c))),
    clipboard: { supported: true, copy: async (text) => { copied.push(text); return true; } },
    extensionPath: '/somewhere/extension',
    ...overrides.options,
  });
  const port = await app.listen(0, overrides.host || '0.0.0.0');
  return { app, port, config, saved, copied };
}

function request(port, { method = 'GET', path = '/', headers = {}, body = null, host = '127.0.0.1', hostHeader } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (hostHeader) finalHeaders.Host = hostHeader;
    if (payload) {
      finalHeaders['Content-Length'] = payload.length;
      if (!Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'content-type') && typeof body === 'object' && !Buffer.isBuffer(body)) {
        finalHeaders['Content-Type'] = 'application/json';
      }
    }
    const req = http.request({ host, port, method, path, headers: finalHeaders, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const bearer = { Authorization: `Bearer ${LOCAL_TOKEN}` };
const cookie = { Cookie: `${SESSION_COOKIE}=${LOCAL_TOKEN}` };
const phonePath = `/p/${PHONE_TOKEN}`;

async function codes(port) {
  const res = await request(port, { path: '/api/codes', headers: bearer });
  return res.json.codes;
}

// ---------------------------------------------------------------------------

test('ping identifies the app to anyone', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const res = await request(port, { path: '/ping' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, app: 'otp-bridge' });
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('the phone can post a message in every common shape', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());

  const shapes = [
    { body: { message: 'Your code is 100001' }, code: '100001' },
    { body: { text: 'Your code is 100002', from: '+15550100' }, code: '100002', sender: '+15550100' },
    { body: { body: 'Your code is 100003' }, code: '100003' },
    { body: { Message: 'Your code is 100004', Sender: 'STC Pay' }, code: '100004', sender: 'STC Pay' },
    { body: { content: { text: 'Your code is 100005' } }, code: '100005' },
    { body: { whatever: 'Your code is 100006' }, code: '100006' },
    { body: 'Your code is 100007', headers: { 'Content-Type': 'text/plain' }, code: '100007' },
    { body: 'text=Your+code+is+100008&from=Bank', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, code: '100008', sender: 'Bank' },
    { body: '"Your code is 100009"', headers: { 'Content-Type': 'application/json' }, code: '100009' },
    { body: 'رمز التحقق: ١٠٠٠١٠', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, code: '100010' },
    {
      body: '--XX\r\nContent-Disposition: form-data; name="message"\r\n\r\nYour code is 100011\r\n--XX\r\nContent-Disposition: form-data; name="sender"\r\n\r\nApple\r\n--XX--\r\n',
      headers: { 'Content-Type': 'multipart/form-data; boundary=XX' },
      code: '100011',
      sender: 'Apple',
    },
    { body: '', path: `${phonePath}?message=${encodeURIComponent('Your code is 100012')}`, code: '100012' },
    { body: { message: 'Your code is 100013' }, path: `${phonePath}/sms`, code: '100013' },
    { body: ['Your code is', '100014'], code: '100014' },
  ];

  for (const shape of shapes) {
    const res = await request(port, { method: 'POST', path: shape.path || phonePath, headers: shape.headers, body: shape.body });
    assert.equal(res.status, 200, JSON.stringify(shape.body));
    assert.deepEqual(res.json, { ok: true, codeFound: true }, JSON.stringify(shape.body));
    const [latest] = await codes(port);
    assert.equal(latest.code, shape.code);
    if (shape.sender) assert.equal(latest.sender, shape.sender);
    assert.ok(!res.text.includes(shape.code), 'the code is never echoed back');
  }
  assert.equal((await codes(port)).length, shapes.length);
});

test('what the usual Android forwarding apps and automation tools send', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const shapes = [
    // "SMS to URL Forwarder": JSON built from its template.
    {
      name: 'SMS to URL Forwarder',
      body: '{"from":"+966500000001","text":"Your code is 200001","sentStamp":1763300000000,"receivedStamp":1763300001000,"sim":"sim1"}',
      type: 'application/json; charset=utf-8',
      code: '200001',
      sender: '+966500000001',
    },
    // A template filled in without escaping: the quotes and the line break make it invalid JSON.
    {
      name: 'hand-written JSON template',
      body: '{"text":"Your "Acme" code is 200002\nDo not share it"}',
      type: 'application/json',
      code: '200002',
    },
    // Tasker / MacroDroid / Automate: the message text as the whole body.
    { name: 'plain text', body: 'Your code is 200003', type: 'text/plain', code: '200003' },
    { name: 'plain text, no content type', body: 'Your code is 200004', type: undefined, code: '200004' },
    { name: 'plain text sent as a form', body: 'Your code is 200005', type: 'application/x-www-form-urlencoded', code: '200005' },
    // Form fields, as some forwarders post them.
    {
      name: 'form fields',
      body: 'from=%2B966500000006&content=%D8%B1%D9%85%D8%B2+%D8%A7%D9%84%D8%AA%D8%AD%D9%82%D9%82%3A+200006&timestamp=1763300000',
      type: 'application/x-www-form-urlencoded',
      code: '200006',
      sender: '+966500000006',
    },
    // A gateway app that wraps the message in an event.
    {
      name: 'event wrapper',
      body: JSON.stringify({ deviceId: 'abc', event: 'sms:received', id: 'x1', payload: { message: 'Your code is 200007', phoneNumber: '+966500000007', receivedAt: '2026-11-16T21:00:00Z' }, webhookId: 'w1' }),
      type: 'application/json',
      code: '200007',
    },
    // A long message that arrived in two parts, joined with a line break.
    { name: 'two-part message', body: JSON.stringify({ text: 'Dear customer, your one-time password for the transfer is\n200008. Do not share it.' }), type: 'application/json', code: '200008' },
  ];
  for (const shape of shapes) {
    const headers = shape.type ? { 'Content-Type': shape.type } : {};
    const res = await request(port, { method: 'POST', path: phonePath, headers, body: shape.body });
    assert.deepEqual(res.json, { ok: true, codeFound: true }, shape.name);
    const [latest] = await codes(port);
    assert.equal(latest.code, shape.code, shape.name);
    if (shape.sender) assert.equal(latest.sender, shape.sender, shape.name);
  }
});

test('a code bound to a website keeps that binding on its way to the browser', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 482913\n@example.com #482913 %pay.example.net' } });
  await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 135790' } });
  const [plain, bound] = await codes(port);
  assert.equal(bound.domain, 'example.com');
  assert.equal(bound.frameDomain, 'pay.example.net');
  assert.equal(plain.domain, null);
  assert.equal(plain.frameDomain, null);
});

test('messages without a code are dropped and nothing of them is kept', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const res = await request(port, { method: 'POST', path: phonePath, body: { message: 'Lunch at 1230 tomorrow? My pin is secret' } });
  assert.deepEqual(res.json, { ok: true, codeFound: false });
  assert.equal((await codes(port)).length, 0);
  const state = await request(port, { path: '/api/state', headers: bearer });
  assert.equal(state.json.phone.withoutCode, 1);
  assert.ok(!state.text.includes('Lunch'));
});

test('an empty or oversized message is refused', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const empty = await request(port, { method: 'POST', path: phonePath, body: '' });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'empty-message');
  const blank = await request(port, { method: 'POST', path: phonePath, body: { message: '   ' } });
  assert.equal(blank.status, 400);
  const huge = await request(port, { method: 'POST', path: phonePath, body: 'x'.repeat(70 * 1024) });
  assert.equal(huge.status, 413);
});

test('a wrong phone link is a 404, and guessing gets rate limited', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const wrong = await request(port, { method: 'POST', path: `/p/${newToken()}`, body: { message: 'Your code is 123456' } });
  assert.equal(wrong.status, 404);
  assert.equal((await codes(port)).length, 0);
  let last;
  for (let i = 0; i < 31; i += 1) last = await request(port, { path: `/p/${newToken()}` });
  assert.equal(last.status, 429);
  // Even the right link has to wait once the address is blocked.
  const blocked = await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 123456' } });
  assert.equal(blocked.status, 429);
});

test('the phone setup page, its details and its test button', async (t) => {
  const { app, port, saved } = await start();
  t.after(() => app.close());
  const page = await request(port, { path: phonePath });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.text, /Connect this phone/);

  const info = await request(port, { path: `${phonePath}/info` });
  assert.equal(info.json.ok, true);
  assert.equal(info.json.port, port);
  assert.equal(typeof info.json.computerName, 'string');
  assert.ok(!info.text.includes(LOCAL_TOKEN));

  const testPost = await request(port, { method: 'POST', path: `${phonePath}?test=1`, body: { message: 'Your OTP Bridge test code is 246810' } });
  assert.deepEqual(testPost.json, { ok: true, codeFound: true });
  const [entry] = await codes(port);
  assert.equal(entry.code, '246810');
  assert.equal(entry.sender, 'OTP Bridge test');
  assert.equal(saved.length, 0, 'a test does not count as the phone being set up');
});

test('the first real message marks the phone as set up and remembers its address', async (t) => {
  const { app, port, saved, config } = await start();
  t.after(() => app.close());
  await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 135790' } });
  assert.equal(saved.length, 1);
  assert.equal(config.phone.host, `127.0.0.1:${port}`);
  assert.ok(config.phone.setupAt);
  await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 135791' } });
  assert.equal(saved.length, 1, 'no rewrite when nothing changed');
  const state = await request(port, { path: '/api/state', headers: bearer });
  assert.equal(state.json.phone.hostStale, false);
  assert.equal(state.json.phone.received, 2);
});

test('a phone that still uses an old IP address is flagged', async (t) => {
  const { app, port } = await start({ config: { phone: { setupAt: '2026-01-01T00:00:00.000Z', host: '10.250.250.250:4812' } } });
  t.after(() => app.close());
  const state = await request(port, { path: '/api/state', headers: bearer });
  assert.equal(state.json.phone.hostStale, true);
  assert.equal(state.json.phone.host, '10.250.250.250:4812');
});

test('the API needs the local token', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  for (const path of ['/api/state', '/api/codes', '/api/status']) {
    assert.equal((await request(port, { path })).status, 401, path);
    assert.equal((await request(port, { path, headers: { Authorization: 'Bearer nope' } })).status, 401, path);
    assert.equal((await request(port, { path, headers: { Authorization: `Bearer ${PHONE_TOKEN}` } })).status, 401, path);
    assert.equal((await request(port, { path, headers: bearer })).status, 200, path);
  }
  const status = await request(port, { path: '/api/status', headers: bearer });
  assert.deepEqual(status.json, { ok: true, app: 'otp-bridge', version: '9.9.9' });
});

test('requests that claim another host name are refused (DNS rebinding)', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  for (const hostHeader of ['evil.example:' + port, 'evil.example', `127.0.0.1:${port + 1}`, '127.0.0.1', `127.0.0.1.evil.example:${port}`]) {
    const res = await request(port, { path: '/api/state', headers: bearer, hostHeader });
    assert.equal(res.status, 404, hostHeader);
    const page = await request(port, { path: '/', headers: cookie, hostHeader });
    assert.equal(page.status, 404, hostHeader);
  }
  const ok = await request(port, { path: '/api/status', headers: bearer, hostHeader: `localhost:${port}` });
  assert.equal(ok.status, 200);
});

test('other devices on the network reach the phone link and nothing else', { skip: !lanAddress() }, async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const lan = lanAddress();
  assert.equal((await request(port, { host: lan, path: '/ping' })).status, 200);
  assert.equal((await request(port, { host: lan, path: phonePath })).status, 200);
  const post = await request(port, { host: lan, method: 'POST', path: phonePath, body: { message: 'Your code is 864209' } });
  assert.deepEqual(post.json, { ok: true, codeFound: true });
  assert.equal((await request(port, { host: lan, path: '/assets/app.css' })).status, 200);

  // The right token and a spoofed Host header are still not enough from outside.
  for (const path of ['/api/state', '/api/codes', '/', '/demo', `/?k=${LOCAL_TOKEN}`]) {
    const res = await request(port, { host: lan, path, headers: { ...bearer, ...cookie } });
    assert.equal(res.status, 404, path);
    const spoofed = await request(port, { host: lan, path, headers: { ...bearer, ...cookie }, hostHeader: `127.0.0.1:${port}` });
    assert.equal(spoofed.status, 404, `${path} with spoofed host`);
    assert.ok(!spoofed.text.includes('864209'));
  }
});

test('the private link sets a cookie, which then opens the dashboard', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const locked = await request(port, { path: '/' });
  assert.equal(locked.status, 403);
  assert.match(locked.text, /private link/);
  assert.ok(!locked.text.includes(LOCAL_TOKEN));

  const wrong = await request(port, { path: '/?k=wrong' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.headers['set-cookie'], undefined);

  const login = await request(port, { path: `/?k=${LOCAL_TOKEN}` });
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, '/');
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=${LOCAL_TOKEN};`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);

  const dashboard = await request(port, { path: '/', headers: cookie });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Latest codes/);
  assert.equal(dashboard.headers['x-frame-options'], 'DENY');
  assert.ok(!dashboard.text.includes(LOCAL_TOKEN), 'the page itself carries no secret');
  const demo = await request(port, { path: '/demo', headers: cookie });
  assert.equal(demo.status, 200);
  assert.match(demo.text, /one-time-code/);
});

test('cookie-authenticated changes must come from our own pages', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${port}`;

  // Reading with the cookie is fine.
  assert.equal((await request(port, { path: '/api/state', headers: cookie })).status, 200);
  // A form on another website can send the cookie, but not our header.
  const noHeader = await request(port, { method: 'POST', path: '/api/test', headers: cookie, body: {} });
  assert.equal(noHeader.status, 403);
  const crossOrigin = await request(port, { method: 'POST', path: '/api/test', headers: { ...cookie, 'X-OTP-Bridge': '1', Origin: 'https://evil.example' }, body: {} });
  assert.equal(crossOrigin.status, 403);
  const crossSite = await request(port, { method: 'POST', path: '/api/test', headers: { ...cookie, 'X-OTP-Bridge': '1', 'Sec-Fetch-Site': 'cross-site' }, body: {} });
  assert.equal(crossSite.status, 403);
  assert.equal((await codes(port)).length, 0);

  const own = await request(port, { method: 'POST', path: '/api/test', headers: { ...cookie, 'X-OTP-Bridge': '1', Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, body: {} });
  assert.equal(own.status, 200);
  assert.match(own.json.code, /^\d{6}$/);
  assert.equal((await codes(port))[0].code, own.json.code);
});

test('browser extensions get CORS answers, websites do not', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const preflight = await request(port, { method: 'OPTIONS', path: '/api/codes', headers: { Origin: ext, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], ext);
  assert.match(preflight.headers['access-control-allow-headers'], /authorization/);

  const fromExt = await request(port, { path: '/api/codes', headers: { ...bearer, Origin: ext } });
  assert.equal(fromExt.headers['access-control-allow-origin'], ext);

  const web = await request(port, { method: 'OPTIONS', path: '/api/codes', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(web.status, 403);
  assert.equal(web.headers['access-control-allow-origin'], undefined);
  const webGet = await request(port, { path: '/api/codes', headers: { ...bearer, Origin: 'https://evil.example' } });
  assert.equal(webGet.headers['access-control-allow-origin'], undefined);
});

test('the extension is noticed when it identifies itself', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  let state = await request(port, { path: '/api/state', headers: bearer });
  assert.equal(state.json.extension.lastSeenAt, null);
  await request(port, { path: '/api/codes', headers: { ...bearer, 'X-OTP-Bridge-Client': 'extension/1.0.0 chrome' } });
  state = await request(port, { path: '/api/state', headers: bearer });
  assert.ok(state.json.extension.lastSeenAt);
  assert.equal(state.json.extension.client, 'extension/1.0.0 chrome');
  assert.ok(state.json.activity.some((a) => /extension connected/i.test(a.text)));
});

test('long polling answers as soon as a code arrives', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const first = await request(port, { path: '/api/codes', headers: bearer });
  const started = Date.now();
  const waiting = request(port, { path: `/api/codes?rev=${first.json.rev}&wait=20`, headers: bearer });
  setTimeout(() => {
    request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 777123' } });
  }, 150);
  const res = await waiting;
  assert.ok(Date.now() - started < 5000, 'did not wait for the timeout');
  assert.equal(res.json.codes[0].code, '777123');
  assert.ok(res.json.rev > first.json.rev);
  assert.equal(typeof res.json.now, 'number');
});

test('long polling gives up quietly after the wait, and answers at once when stale', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const first = await request(port, { path: '/api/codes', headers: bearer });
  const started = Date.now();
  const idle = await request(port, { path: `/api/codes?rev=${first.json.rev}&wait=1`, headers: bearer });
  const took = Date.now() - started;
  assert.ok(took >= 900 && took < 3000, `took ${took}ms`);
  assert.equal(idle.json.rev, first.json.rev);

  const stale = Date.now();
  await request(port, { path: `/api/codes?rev=${first.json.rev - 1}&wait=20`, headers: bearer });
  assert.ok(Date.now() - stale < 1000);
});

test('an abandoned long poll is cleaned up', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const first = await request(port, { path: '/api/codes', headers: bearer });
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/codes?rev=${first.json.rev}&wait=20`, headers: bearer, agent: false });
    req.on('error', () => {});
    req.end();
    setTimeout(() => { req.destroy(); setTimeout(resolve, 100); }, 150);
  });
  assert.equal(app.store._waiters.size, 0);
});

test('codes can be marked used, removed and cleared', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 111222' } });
  await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 333444' } });
  const [newest, oldest] = await codes(port);
  assert.equal(newest.code, '333444');

  const used = await request(port, { method: 'POST', path: `/api/codes/${newest.id}/used`, headers: bearer });
  assert.deepEqual(used.json, { ok: true });
  assert.ok((await codes(port))[0].usedAt);
  const missing = await request(port, { method: 'POST', path: '/api/codes/deadbeef/used', headers: bearer });
  assert.deepEqual(missing.json, { ok: false });

  await request(port, { method: 'DELETE', path: `/api/codes/${oldest.id}`, headers: bearer });
  assert.deepEqual((await codes(port)).map((c) => c.code), ['333444']);
  await request(port, { method: 'DELETE', path: '/api/codes', headers: bearer });
  assert.equal((await codes(port)).length, 0);
});

test('test codes, message checks and settings', async (t) => {
  const { app, port, saved, copied, config } = await start();
  t.after(() => app.close());

  const made = await request(port, { method: 'POST', path: '/api/test', headers: bearer, body: {} });
  assert.match(made.json.code, /^\d{6}$/);
  const custom = await request(port, { method: 'POST', path: '/api/test', headers: bearer, body: { message: 'رمز التحقق: 9081' } });
  assert.equal(custom.json.code, '9081');
  const none = await request(port, { method: 'POST', path: '/api/test', headers: bearer, body: { message: 'hello there' } });
  assert.deepEqual(none.json, { ok: true, codeFound: false, code: null });

  const check = await request(port, { method: 'POST', path: '/api/check', headers: bearer, body: { message: 'G-246802 is your Google verification code.' } });
  assert.deepEqual(check.json, { ok: true, code: '246802' });
  assert.ok(!(await codes(port)).some((c) => c.code === '246802'), 'checking does not store anything');

  assert.deepEqual(copied, [], 'clipboard is off by default');
  const on = await request(port, { method: 'POST', path: '/api/settings', headers: bearer, body: { clipboard: true } });
  assert.deepEqual(on.json, { ok: true, settings: { clipboard: true } });
  assert.equal(config.clipboard, true);
  assert.equal(saved.at(-1).clipboard, true);
  await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 565656' } });
  assert.deepEqual(copied, ['565656']);
  // The same message again is not copied twice.
  await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 565656' } });
  assert.deepEqual(copied, ['565656']);

  const bad = await request(port, { method: 'POST', path: '/api/settings', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
});

test('resetting the phone link invalidates the old address', async (t) => {
  const { app, port, config } = await start();
  t.after(() => app.close());
  await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 112233' } });
  assert.ok(config.phone);
  const reset = await request(port, { method: 'POST', path: '/api/reset-phone-link', headers: bearer, body: {} });
  assert.deepEqual(reset.json, { ok: true });
  assert.notEqual(config.phoneToken, PHONE_TOKEN);
  assert.equal(config.phone, undefined);
  const old = await request(port, { method: 'POST', path: phonePath, body: { message: 'Your code is 445566' } });
  assert.equal(old.status, 404);
  const fresh = await request(port, { method: 'POST', path: `/p/${config.phoneToken}`, body: { message: 'Your code is 445566' } });
  assert.equal(fresh.status, 200);
});

test('state gives the dashboard what it needs', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  const { json } = await request(port, { path: '/api/state', headers: bearer });
  assert.equal(json.app, 'otp-bridge');
  assert.equal(json.port, port);
  assert.deepEqual(json.pairing, { baseUrl: `http://127.0.0.1:${port}`, token: LOCAL_TOKEN });
  assert.equal(json.extensionPath, '/somewhere/extension');
  assert.ok(Array.isArray(json.network.addresses));
  for (const a of json.network.addresses) assert.equal(a.url, `http://${a.address}:${port}/p/${PHONE_TOKEN}`);
  assert.deepEqual(json.settings, { clipboard: false, clipboardSupported: true });
  assert.deepEqual(json.autostart, { supported: false });
  assert.deepEqual(json.codes, []);
});

test('autostart is switched through the API when available', async (t) => {
  let enabled = false;
  const autostart = {
    status: () => ({ supported: true, enabled }),
    enable: () => { enabled = true; return { supported: true, enabled }; },
    disable: () => { throw new Error('launchctl said no'); },
  };
  const { app, port } = await start({ options: { autostart } });
  t.after(() => app.close());
  const on = await request(port, { method: 'POST', path: '/api/autostart', headers: bearer, body: { enabled: true } });
  assert.deepEqual(on.json, { ok: true, autostart: { supported: true, enabled: true } });
  const state = await request(port, { path: '/api/state', headers: bearer });
  assert.deepEqual(state.json.autostart, { supported: true, enabled: true });
  const off = await request(port, { method: 'POST', path: '/api/autostart', headers: bearer, body: { enabled: false } });
  assert.deepEqual(off.json, { ok: false, error: 'launchctl said no' });
});

test('only the listed asset files are served', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  for (const name of ['app.css', 'dashboard.js', 'phone.js', 'demo.js', 'qr.js', 'icon.svg']) {
    const res = await request(port, { path: `/assets/${name}` });
    assert.equal(res.status, 200, name);
    assert.ok(res.text.length > 100, name);
  }
  for (const path of ['/assets/dashboard.html', '/assets/../lib/server.js', '/assets/%2e%2e/lib/server.js', '/assets/', '/assets/nope.js', '/favicon.ico', '/nope']) {
    const res = await request(port, { path });
    assert.equal(res.status, 404, path);
  }
});

test('unknown routes and methods', async (t) => {
  const { app, port } = await start();
  t.after(() => app.close());
  assert.equal((await request(port, { path: '/api/nope', headers: bearer })).status, 404);
  assert.equal((await request(port, { method: 'DELETE', path: phonePath })).status, 405);
  assert.equal((await request(port, { method: 'POST', path: '/', headers: cookie })).status, 405);
  assert.equal((await request(port, { method: 'POST', path: `${phonePath}/info` })).status, 405);
});

// --- pure helpers ---------------------------------------------------------------

test('hostIsLoopback', () => {
  assert.equal(hostIsLoopback('127.0.0.1:4812', 4812), true);
  assert.equal(hostIsLoopback('localhost:4812', 4812), true);
  assert.equal(hostIsLoopback('LOCALHOST:4812', 4812), true);
  assert.equal(hostIsLoopback('[::1]:4812', 4812), true);
  assert.equal(hostIsLoopback('127.0.0.1', 80), true);
  assert.equal(hostIsLoopback('127.0.0.1:4813', 4812), false);
  assert.equal(hostIsLoopback('192.168.1.5:4812', 4812), false);
  assert.equal(hostIsLoopback('evil.example:4812', 4812), false);
  assert.equal(hostIsLoopback('127.0.0.1.evil.example:4812', 4812), false);
  assert.equal(hostIsLoopback('', 4812), false);
  assert.equal(hostIsLoopback(undefined, 4812), false);
});

test('parseIncomingMessage trims and limits what it accepts', () => {
  const long = parseIncomingMessage(Buffer.from(JSON.stringify({ message: 'a'.repeat(9000) })), 'application/json');
  assert.equal(long.text.length, 4000);
  const sender = parseIncomingMessage(Buffer.from(JSON.stringify({ message: 'code 123456', sender: `Bank\n${'x'.repeat(200)}` })), 'application/json');
  assert.equal(sender.sender.length, 64);
  assert.ok(!sender.sender.includes('\n'));
  assert.deepEqual(parseIncomingMessage(Buffer.from(''), 'application/json'), { text: '', sender: null });
  assert.deepEqual(parseIncomingMessage(Buffer.from('{"message":'), 'application/json'), { text: '{"message":', sender: null });
  assert.deepEqual(parseIncomingMessage(Buffer.from(JSON.stringify({ message: 4829 })), 'application/json'), { text: '4829', sender: null });
});

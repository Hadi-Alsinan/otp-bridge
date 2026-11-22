'use strict';

// Codes that arrive by email: reading Gmail's list of unread mail, and the
// part of the extension's background script that watches it.
//
// The list behaves as measured on a real mailbox: one entry for each
// conversation with unread mail, carrying the newest email's id and time and
// the oldest unread email's first lines, plus a count of those conversations.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { parseFeed, sortMail } = require('../extension/mail.js');

const EXTENSION = path.join(__dirname, '..', 'extension');
const NOW = Date.parse('2026-11-21T21:40:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

let serial = 0;

/** One conversation in Gmail's list: the newest email's time, and the first lines Gmail shows for it. */
function entry({ subject, summary, from = 'GitHub', email = 'noreply@github.com', at = NOW - 20 * SECOND, number }) {
  serial += 1;
  const id = number || ((BigInt(at) << 20n) + BigInt(serial)).toString();   // Gmail builds ids from the time
  const time = new Date(at).toISOString().replace('.000', '');
  return `<entry>
<title>${subject}</title>
<summary>${summary}</summary>
<link rel="alternate" href="https://mail.google.com/mail/u/0?account_id=me@example.com&amp;message_id=${BigInt(id).toString(16)}&amp;view=conv&amp;extsrc=atom" type="text/html" />
<modified>${time}</modified>
<issued>${time}</issued>
<id>tag:gmail.google.com,2004:${id}</id>
<author>
<name>${from}</name>
<email>${email}</email>
</author>
</entry>`;
}

/** The list. `count` is Gmail's count of unread conversations, which can be more than the list shows. */
function feed(account, entries, count = entries.length) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed version="0.3" xmlns="http://purl.org/atom/ns#">
<title>Gmail - Inbox for ${account}</title>
<tagline>New messages in your Gmail Inbox</tagline>
<fullcount>${count}</fullcount>
<link rel="alternate" href="https://mail.google.com/mail/u/0" type="text/html" />
<modified>2026-11-21T21:40:00Z</modified>
${entries.join('\n')}
</feed>`;
}

/** One look at a list, as the background script takes it. */
function look(xml, { now = NOW, known = [], previous } = {}) {
  return sortMail(parseFeed(xml), { now, maxAgeMs: 3 * MINUTE, known, previous });
}

const subjects = (items) => items.map((item) => (item.text || '').split('\n')[0] || item.from);

test('the list of unread mail is read into messages', () => {
  const parsed = parseFeed(feed('Me@Example.com', [
    entry({ number: '1700000000000000001', subject: 'Your sign-in code', summary: 'Use 482913 to sign in. It&#39;s valid for 10 minutes &amp; one use.' }),
    entry({ subject: 'Weekly &lt;digest&gt;', summary: '', from: '', email: 'news@example.com' }),
  ], 57));
  assert.equal(parsed.account, 'me@example.com');
  assert.equal(parsed.count, 57, 'the count is Gmail\'s, not the number of entries shown');
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries[0], {
    id: 'tag:gmail.google.com,2004:1700000000000000001',
    subject: 'Your sign-in code',
    summary: "Use 482913 to sign in. It's valid for 10 minutes & one use.",
    from: 'GitHub',
    at: NOW - 20 * SECOND,
  });
  assert.equal(parsed.entries[1].subject, 'Weekly <digest>');
  assert.equal(parsed.entries[1].from, 'news@example.com', 'the address stands in for a missing name');
});

test('a page that is not the list is told apart from an empty mailbox', () => {
  assert.equal(parseFeed('<!doctype html><html><title>Sign in</title></html>'), null);
  assert.equal(parseFeed(''), null);
  assert.equal(parseFeed(undefined), null);
  assert.deepEqual(parseFeed(feed('me@example.com', [])), { account: 'me@example.com', count: 0, entries: [] });
});

test('an email that starts a conversation of its own, seen arriving, is passed on', () => {
  const old = entry({ subject: 'Old code', summary: 'Your code is 111111.', at: NOW - 2 * HOUR });
  const before = look(feed('me@example.com', [old]), { now: NOW - 4 * SECOND });
  assert.deepEqual([before.fresh, before.skipped], [[], []]);

  const after = look(feed('me@example.com', [
    entry({ subject: 'New code', summary: 'Your code is 482913.', at: NOW - 2 * SECOND }),
    entry({ subject: 'Hello', summary: 'Shall we meet tomorrow?', at: NOW - 2 * SECOND }),
    entry({ subject: 'Code 333333', summary: '', at: NOW + 30 * SECOND }),          // the clocks differ a little
    entry({ subject: 'رمز التحقق', summary: 'رمز التحقق الخاص بك هو ٤٨٢٩١٣', at: NOW - 1 * SECOND }),
    old,
  ]), { known: before.notes, previous: before.look });
  assert.deepEqual(subjects(after.fresh), ['New code', 'Code 333333', 'رمز التحقق']);
  assert.equal(after.fresh[0].text, 'New code\nYour code is 482913.');
  assert.equal(after.fresh[0].from, 'GitHub');
  assert.deepEqual(after.skipped, []);
  assert.equal(after.notes.length, 5, 'every entry is noted, passed on or not');
  assert.deepEqual(Object.keys(after.notes[0]).sort(), ['at', 'id', 'mark'], 'and no words of the mail are kept');

  // Looked at once, the same entries are not brought up again.
  const again = look(feed('me@example.com', []), { known: after.notes, previous: after.look });
  assert.deepEqual([again.fresh, again.skipped], [[], []]);
});

test('an email that joins a conversation with an older unread email is never read as the new one', () => {
  // What happened on 22 November 2026: a sign-in code was emailed at 16:54 and
  // left unread. At 02:12 the next one joined the same conversation. Gmail
  // gave the entry the new email's id and time and kept the old email's words.
  const arrived = Date.parse('2026-11-21T23:12:01Z');
  const words = { from: 'noreply', subject: 'Your Contoso sign-in code', summary: 'Use 906173 to sign in. It expires in 10 minutes.' };
  const others = Array.from({ length: 19 }, (_, i) => entry({ subject: `Newsletter ${i}`, summary: 'No numbers here', at: arrived - HOUR }));
  const afternoon = entry({ ...words, number: '1700000000000000001', at: Date.parse('2026-11-21T13:54:27Z') });
  const night = entry({ ...words, number: '1700000000000000002', at: arrived });

  // The extension was watching, and the afternoon's email was in the list.
  const before = look(feed('me@example.com', [...others, afternoon], 35), { now: arrived - 3 * SECOND });
  const seen = look(feed('me@example.com', [night, ...others], 35), { now: arrived + 5 * SECOND, known: before.notes, previous: before.look });
  assert.deepEqual(seen.fresh, [], 'the code from the afternoon is not offered');
  assert.deepEqual(seen.skipped.map((s) => [s.from, s.reason]), [['noreply', 'older']]);

  // The afternoon's email was further down than the 20 entries Gmail shows, so
  // its words were never seen. The count gives it away: a new entry, and not
  // one conversation more.
  const twenty = [...others, entry({ subject: 'One more', summary: 'No numbers', at: arrived - HOUR })];
  const blind = look(feed('me@example.com', twenty, 35), { now: arrived - 3 * SECOND });
  const hidden = look(feed('me@example.com', [night, ...others], 35), { now: arrived + 5 * SECOND, known: blind.notes, previous: blind.look });
  assert.deepEqual(hidden.fresh, []);
  assert.deepEqual(hidden.skipped.map((s) => s.reason), ['older']);

  // Had it started a conversation of its own, the count would be one higher.
  const own = look(feed('me@example.com', [night, ...others], 36), { now: arrived + 5 * SECOND, known: blind.notes, previous: blind.look });
  assert.deepEqual(subjects(own.fresh), ['Your Contoso sign-in code']);
});

test('mail that was there before anyone was watching is left alone', () => {
  const code = entry({ subject: 'Your code', summary: 'Use 482913 to sign in.', at: NOW - 10 * SECOND });

  // The first look of all: nothing to compare it with.
  const first = look(feed('me@example.com', [code]));
  assert.deepEqual(first.fresh, []);
  assert.deepEqual(first.skipped.map((s) => s.reason), ['early']);

  // The last look was too long ago to say anything about now.
  const stale = look(feed('me@example.com', []), { now: NOW - 2 * MINUTE });
  const later = look(feed('me@example.com', [code]), { known: stale.notes, previous: stale.look });
  assert.deepEqual(later.skipped.map((s) => s.reason), ['early']);

  // It arrived before the last look and was not in the list then (it was read, and is unread again).
  const recent = look(feed('me@example.com', []), { now: NOW - 4 * SECOND });
  const back = look(feed('me@example.com', [code]), { known: recent.notes, previous: recent.look });
  assert.deepEqual(back.skipped.map((s) => s.reason), ['early']);
});

test('when the count does not add up, nothing that arrived in that moment is trusted', () => {
  const before = look(feed('me@example.com', [], 12), { now: NOW - 4 * SECOND });
  // Two new entries, but only one conversation more: one of them joined an
  // unread conversation, and there is no telling which.
  const after = look(feed('me@example.com', [
    entry({ subject: 'Your code', summary: 'Use 482913 to sign in.', at: NOW - 2 * SECOND }),
    entry({ subject: 'Your other code', summary: 'Use 271828 to sign in.', at: NOW - 1 * SECOND }),
  ], 13), { known: before.notes, previous: before.look });
  assert.deepEqual(after.fresh, []);
  assert.deepEqual(after.skipped.map((s) => s.reason), ['older', 'older']);

  // A list without a count cannot be checked either.
  const uncounted = feed('me@example.com', [entry({ subject: 'Your code', summary: 'Use 482913.', at: NOW - 2 * SECOND })])
    .replace(/<fullcount>\d+<\/fullcount>/, '');
  assert.deepEqual(look(uncounted, { known: before.notes, previous: before.look }).fresh, []);
});

test('an entry whose words change later is not taken for new mail', () => {
  // Two unread emails in one conversation; the list shows the first one's
  // words. Then the first is opened, and the list shows the second one's.
  const at = NOW - 30 * SECOND;
  const stuck = entry({ number: '1700000000000000002', subject: 'Your code', summary: 'Use 111111 to sign in.', at });
  const moved = entry({ number: '1700000000000000002', subject: 'Your code', summary: 'Use 333333 to sign in.', at });
  const before = look(feed('me@example.com', [stuck]), { now: NOW - 4 * SECOND });
  const after = look(feed('me@example.com', [moved]), { known: before.notes, previous: before.look });
  assert.deepEqual(after.fresh, [], 'which email these words belong to cannot be known');
  assert.deepEqual(after.skipped.map((s) => s.reason), ['changed']);
});

// --- the background script, with the browser played by stand-ins ---------------

const PAIRING = { baseUrl: 'http://127.0.0.1:4812', token: 'k'.repeat(32) };

/**
 * Loads the extension's background script the way the browser does, with
 * stand-ins for the browser, Gmail and the companion.
 */
function loadBackground({ mailOn = true, allowed = true, mailboxes = {}, companionUp = true } = {}) {
  const world = {
    clock: NOW,
    storage: { pairing: PAIRING, ...(mailOn == null ? {} : { mail: { on: mailOn } }) },
    allowed,
    mailboxes,              // account number -> the list's text, or a status number
    companionUp,
    gmailRequests: [],
    posted: [],             // what reached the companion as mail
    releaseCodes: null,
    listener: null,
  };

  async function fakeFetch(url, options = {}) {
    const address = new URL(url);
    if (address.origin === 'https://mail.google.com') {
      world.gmailRequests.push({ path: address.pathname, credentials: options.credentials });
      if (world.gmailGate) await world.gmailGate;   // Gmail takes its time, for as long as a test wants
      const number = Number(/\/mail\/u\/(\d+)\/feed\/atom$/.exec(address.pathname)[1]);
      const box = world.mailboxes[number];
      const status = typeof box === 'number' ? box : box === undefined ? 404 : 200;
      return {
        status,
        ok: status === 200,
        headers: { get: (name) => (name.toLowerCase() === 'date' ? new Date(world.clock).toUTCString() : null) },
        text: async () => (typeof box === 'string' ? box : ''),
      };
    }
    assert.equal(address.origin, PAIRING.baseUrl);
    assert.equal(options.headers.Authorization, `Bearer ${PAIRING.token}`);
    const json = (data) => ({ status: 200, ok: true, json: async () => data });
    if (address.pathname === '/api/mail') {
      if (!world.companionUp) throw new TypeError('Failed to fetch');
      world.posted.push(JSON.parse(options.body));
      return json({ ok: true, codes: 1 });
    }
    if (address.pathname === '/api/codes') {
      // A page waiting for a code: the companion answers when the test lets it.
      await new Promise((resolve) => { world.releaseCodes = resolve; });
      return json({ ok: true, rev: 1, now: world.clock, codes: [] });
    }
    throw new Error(`unexpected request to ${url}`);
  }

  const event = { addListener() {} };
  const chrome = {
    runtime: {
      id: 'otp-bridge-extension',
      getManifest: () => ({ version: '1.0.0' }),
      getURL: (file) => `chrome-extension://otp-bridge-extension/${file}`,
      onMessage: { addListener(listener) { world.listener = listener; } },
      onInstalled: event,
      onStartup: event,
    },
    storage: {
      local: {
        async get(key) { return key in world.storage ? { [key]: world.storage[key] } : {}; },
        async set(values) { Object.assign(world.storage, JSON.parse(JSON.stringify(values))); },
        async remove(key) { delete world.storage[key]; },
      },
    },
    permissions: {
      async contains(wanted) {
        assert.deepEqual([...wanted.origins], ['https://mail.google.com/*']);
        return world.allowed;
      },
    },
  };

  const context = vm.createContext({
    chrome,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/130.0.0.0' },
    fetch: fakeFetch,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    // The watching ticks once a second for as long as a page waits. A test that
    // fails before its page stops waiting must not keep this file running.
    setInterval: (...args) => setInterval(...args).unref(),
    clearInterval,
    console,
  });
  context.importScripts = (file) => {
    vm.runInContext(fs.readFileSync(path.join(EXTENSION, file), 'utf8'), context, { filename: file });
  };
  vm.runInContext('Date.now = () => __clock();', Object.assign(context, { __clock: () => world.clock }));
  vm.runInContext(fs.readFileSync(path.join(EXTENSION, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  /** A message to the background script, from a web page or from the extension's own popup. */
  world.send = (message, { ownPage = false } = {}) => new Promise((resolve) => {
    const sender = {
      id: chrome.runtime.id,
      url: ownPage ? chrome.runtime.getURL('popup.html') : 'https://shop.example/sign-in',
    };
    // Answers are made inside the stand-in browser; copied, they compare like any other object.
    world.listener(message, sender, (answer) => resolve(JSON.parse(JSON.stringify(answer))));
  });
  /** Lets everything that can happen without the clock moving happen. */
  world.settle = async () => {
    for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  /** A page shows a code field and waits; returns once the mailbox has been looked at. */
  world.pageWaits = async () => {
    const answer = world.send({ type: 'poll', rev: 1, wait: 20 });
    await world.settle();
    return async () => {
      world.releaseCodes();
      assert.equal((await answer).ok, true);
    };
  };
  /** One look at the mailbox by a waiting page, a few seconds after the last. */
  world.look = async () => {
    world.clock += 5 * SECOND;
    await (await world.pageWaits())();
  };
  return world;
}

/** A code email that has just arrived, by the stand-in clock. */
const codeMail = (world, words = {}) => entry({
  subject: 'Your sign-in code', summary: 'Use 482913 to sign in.', at: world.clock + 3 * SECOND, ...words,
});

test('while a page waits for a code, mail that arrives goes to the companion, once', async () => {
  const world = loadBackground({ mailboxes: { 0: feed('me@example.com', []) } });
  await world.look();
  assert.deepEqual(world.gmailRequests[0], { path: '/mail/u/0/feed/atom', credentials: 'include' });
  assert.deepEqual(world.posted, [], 'an empty mailbox gives nothing to pass on');

  world.mailboxes[0] = feed('me@example.com', [codeMail(world)]);
  await world.look();
  assert.deepEqual(world.posted, [{ messages: [{ from: 'GitHub', text: 'Your sign-in code\nUse 482913 to sign in.' }], skipped: [] }]);

  // The same mail is still unread a few seconds later. It is not passed on again.
  await world.look();
  assert.equal(world.posted.length, 1);
});

test('the mailbox is not read more often than every few seconds', async () => {
  const world = loadBackground({ mailboxes: { 0: feed('me@example.com', []) } });
  let done = await world.pageWaits();
  const first = world.gmailRequests.length;
  await done();
  world.clock += 1000;
  done = await world.pageWaits();
  assert.equal(world.gmailRequests.length, first, 'one second later is too soon');
  await done();
});

test('with the switch off, or without the browser\'s permission, Gmail is never asked', async () => {
  for (const options of [{ mailOn: false }, { mailOn: null }, { allowed: false }]) {
    const world = loadBackground({ ...options, mailboxes: { 0: feed('me@example.com', []) } });
    await world.look();
    world.mailboxes[0] = feed('me@example.com', [codeMail(world)]);
    await world.look();
    assert.deepEqual(world.gmailRequests, []);
    assert.deepEqual(world.posted, []);
    assert.deepEqual(await world.send({ type: 'mail-status' }, { ownPage: true }), { ok: true, on: false });
  }
});

test('turning the switch off stops the watching at once, even for a page that is still waiting', async () => {
  const world = loadBackground({ mailboxes: { 0: feed('me@example.com', []) } });
  const done = await world.pageWaits();
  const before = world.gmailRequests.length;
  assert.ok(before > 0);

  await world.send({ type: 'mail-set', on: false }, { ownPage: true });
  world.clock += 5000;
  world.mailboxes[0] = feed('me@example.com', [codeMail(world)]);
  await new Promise((resolve) => setTimeout(resolve, 1200));   // the waiting page's next tick
  await world.settle();
  assert.equal(world.gmailRequests.length, before);
  assert.deepEqual(world.posted, []);
  await done();
});

test('turned off while the mailbox is being looked at, the popup is told that it is off', async () => {
  const world = loadBackground({ mailboxes: { 0: feed('me@example.com', []) } });
  let letGmailAnswer;
  world.gmailGate = new Promise((resolve) => { letGmailAnswer = resolve; });
  const waiting = world.send({ type: 'poll', rev: 1, wait: 20 });   // a page waits, and its look is held up by Gmail
  await world.settle();
  assert.equal(world.gmailRequests.length, 1);

  await world.send({ type: 'mail-set', on: false }, { ownPage: true });
  const status = world.send({ type: 'mail-status' }, { ownPage: true });
  await world.settle();
  letGmailAnswer();
  assert.deepEqual(await status, { ok: true, on: false });

  await world.settle();
  world.releaseCodes();
  assert.equal((await waiting).ok, true);
});

test('mail that could not be handed over is tried again', async () => {
  const world = loadBackground({ companionUp: false, mailboxes: { 0: feed('me@example.com', []) } });
  await world.look();
  world.mailboxes[0] = feed('me@example.com', [codeMail(world)]);
  await world.look();
  assert.deepEqual(world.posted, []);

  world.companionUp = true;
  await world.look();
  assert.equal(world.posted.length, 1);
  assert.equal(world.posted[0].messages.length, 1);
});

test('a new email in a conversation with an older unread one: no code is offered, and the companion is told why, once', async () => {
  const words = { from: 'noreply', subject: 'Your Contoso sign-in code', summary: 'Use 906173 to sign in.' };
  const world = loadBackground({ mailboxes: { 0: feed('me@example.com', [entry({ ...words, at: NOW - 9 * HOUR })]) } });
  await world.look();

  // The next one joins the conversation: a new id and time, the old words, and no conversation more.
  world.mailboxes[0] = feed('me@example.com', [codeMail(world, words)]);
  await world.look();
  assert.deepEqual(world.posted, [{ messages: [], skipped: [{ from: 'noreply', reason: 'older' }] }]);

  await world.look();
  assert.equal(world.posted.length, 1, 'said once, not at every look');
});

test('mail that was already there when the watching began is not trusted', async () => {
  const world = loadBackground();
  world.mailboxes[0] = feed('me@example.com', [codeMail(world)]);
  await world.look();
  assert.deepEqual(world.posted, [{ messages: [], skipped: [{ from: 'GitHub', reason: 'early' }] }]);
});

test('every signed-in account is read, and the popup is told which', async () => {
  const world = loadBackground({
    mailboxes: {
      0: feed('me@example.com', []),
      1: feed('work@example.com', []),
      2: feed('me@example.com', []),          // past the last account, the first one again
      3: feed('never@example.com', []),
    },
  });
  const status = await world.send({ type: 'mail-status' }, { ownPage: true });
  assert.deepEqual(status, { ok: true, on: true, accounts: ['me@example.com', 'work@example.com'], problem: null });
  assert.deepEqual(world.gmailRequests.map((r) => r.path), ['/mail/u/0/feed/atom', '/mail/u/1/feed/atom', '/mail/u/2/feed/atom']);

  // Mail for the second account is passed on like any other.
  world.mailboxes[1] = feed('work@example.com', [codeMail(world)]);
  world.gmailRequests.length = 0;
  await world.look();
  assert.equal(world.posted.length, 1);
  assert.equal(world.posted[0].messages.length, 1);
  // The number of accounts is remembered for a while, so only those are asked.
  assert.deepEqual(world.gmailRequests.map((r) => r.path), ['/mail/u/0/feed/atom', '/mail/u/1/feed/atom']);
});

test('a browser that is not signed in to Gmail is reported as such', async () => {
  for (const mailbox of [401, '<!doctype html><html><title>Sign in - Google Accounts</title></html>']) {
    const world = loadBackground({ mailboxes: { 0: mailbox } });
    const status = await world.send({ type: 'mail-status' }, { ownPage: true });
    assert.deepEqual(status, { ok: true, on: true, accounts: [], problem: 'signed-out' });
  }
});

test('only the extension\'s own popup can ask about Gmail or switch it', async () => {
  const world = loadBackground({ mailOn: false, mailboxes: { 0: feed('me@example.com', []) } });
  assert.deepEqual(await world.send({ type: 'mail-set', on: true }), { ok: false });
  assert.deepEqual(await world.send({ type: 'mail-status' }), { ok: false });
  assert.equal(world.storage.mail.on, false);

  assert.deepEqual(await world.send({ type: 'mail-set', on: true }, { ownPage: true }), { ok: true });
  assert.equal(world.storage.mail.on, true);
  assert.equal((await world.send({ type: 'mail-status' }, { ownPage: true })).on, true);
});

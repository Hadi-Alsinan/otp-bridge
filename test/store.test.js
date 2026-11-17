'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CodeStore } = require('../companion/lib/store');

function makeStore(options = {}) {
  let t = 1_000_000;
  const store = new CodeStore({ now: () => t, ...options });
  return { store, advance: (ms) => { t += ms; }, at: () => t };
}

test('add stores a code and bumps the revision', (t) => {
  const { store } = makeStore();
  t.after(() => store.close());
  const before = store.rev;
  const { entry, duplicate } = store.add({ code: '482913', sender: 'Bank', preview: 'Your code is 482913' });
  assert.equal(duplicate, false);
  assert.equal(entry.code, '482913');
  assert.match(entry.id, /^[a-f0-9]{16}$/);
  assert.equal(entry.usedAt, null);
  assert.ok(store.rev > before);
  assert.deepEqual(store.list().map((e) => e.code), ['482913']);
});

test('the website a code is for is kept with it', (t) => {
  const { store, advance } = makeStore();
  t.after(() => store.close());
  store.add({ code: '111111' });
  assert.equal(store.list()[0].domain, null);
  store.add({ code: '482913', domain: 'example.com', frameDomain: 'pay.example.net' });
  const [bound] = store.list();
  assert.equal(bound.domain, 'example.com');
  assert.equal(bound.frameDomain, 'pay.example.net');
  // A re-send that names the site adds the binding to a code that had none.
  advance(10_000);
  store.add({ code: '111111', domain: 'other.example' });
  assert.equal(store.list().find((e) => e.code === '111111').domain, 'other.example');
});

test('newest code comes first and the list is capped', (t) => {
  const { store, advance } = makeStore({ maxEntries: 3 });
  t.after(() => store.close());
  for (const code of ['1111', '2222', '3333', '4444']) {
    store.add({ code });
    advance(1000);
  }
  assert.deepEqual(store.list().map((e) => e.code), ['4444', '3333', '2222']);
});

test('codes expire after the time to live', (t) => {
  const { store, advance } = makeStore({ ttlMs: 60_000 });
  t.after(() => store.close());
  store.add({ code: '482913' });
  advance(59_000);
  assert.equal(store.list().length, 1);
  const rev = store.rev;
  advance(2_000);
  assert.equal(store.list().length, 0);
  assert.ok(store.rev > rev, 'expiry counts as a change');
});

test('the same code arriving twice at once is ignored', (t) => {
  const { store, advance } = makeStore();
  t.after(() => store.close());
  store.add({ code: '482913' });
  const rev = store.rev;
  advance(800);
  const again = store.add({ code: '482913' });
  assert.equal(again.duplicate, true);
  assert.equal(store.list().length, 1);
  assert.equal(store.rev, rev, 'nothing changed');
});

test('a re-sent code is offered again even after it was used', (t) => {
  const { store, advance, at } = makeStore();
  t.after(() => store.close());
  const { entry } = store.add({ code: '482913' });
  store.markUsed(entry.id);
  assert.ok(store.list()[0].usedAt);
  advance(30_000);
  const again = store.add({ code: '482913' });
  assert.equal(again.duplicate, true);
  const [only] = store.list();
  assert.equal(store.list().length, 1);
  assert.equal(only.usedAt, null);
  assert.equal(only.receivedAt, at());
});

test('the same digits long after are a new code', (t) => {
  const { store, advance } = makeStore({ dedupeMs: 60_000 });
  t.after(() => store.close());
  store.add({ code: '482913' });
  advance(61_000);
  assert.equal(store.add({ code: '482913' }).duplicate, false);
  assert.equal(store.list().length, 2);
});

test('markUsed, remove and clear', (t) => {
  const { store } = makeStore();
  t.after(() => store.close());
  const a = store.add({ code: '1111' }).entry;
  const b = store.add({ code: '2222' }).entry;
  assert.equal(store.markUsed('nope'), false);
  assert.equal(store.markUsed(a.id), true);
  const rev = store.rev;
  assert.equal(store.markUsed(a.id), true);
  assert.equal(store.rev, rev, 'marking twice changes nothing');
  assert.equal(store.remove(b.id), true);
  assert.equal(store.remove(b.id), false);
  assert.deepEqual(store.list().map((e) => e.code), ['1111']);
  store.clear();
  assert.equal(store.list().length, 0);
});

test('list returns copies', (t) => {
  const { store } = makeStore();
  t.after(() => store.close());
  store.add({ code: '482913' });
  store.list()[0].code = 'tampered';
  assert.equal(store.list()[0].code, '482913');
});

test('waitForChange resolves when a code arrives', async (t) => {
  const store = new CodeStore();
  t.after(() => store.close());
  const rev = store.rev;
  const pending = store.waitForChange(rev, 5000);
  setTimeout(() => store.add({ code: '482913' }), 20);
  assert.equal(await pending, true);
});

test('waitForChange returns at once when already out of date, and times out otherwise', async (t) => {
  const store = new CodeStore();
  t.after(() => store.close());
  assert.equal(await store.waitForChange(store.rev - 1, 5000), true);
  const started = Date.now();
  assert.equal(await store.waitForChange(store.rev, 40), false);
  assert.ok(Date.now() - started >= 30);
});

test('waitForChange can be cancelled', async (t) => {
  const store = new CodeStore();
  t.after(() => store.close());
  const pending = store.waitForChange(store.rev, 60_000);
  pending.cancel();
  assert.equal(await pending, false);
  assert.equal(store._waiters.size, 0);
});

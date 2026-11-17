'use strict';

const crypto = require('node:crypto');

/**
 * Holds the codes that arrived from the phone. Everything lives in memory
 * only: nothing is written to disk and entries disappear after `ttlMs`.
 *
 * `rev` goes up every time the visible list changes, which lets a client ask
 * "tell me when something changed since rev N" (see `waitForChange`).
 */
class CodeStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 20;
    // The same code arriving again inside this window is the same SMS
    // (several phone automations fired for one message, or a re-send).
    this.dedupeMs = options.dedupeMs ?? 2 * 60 * 1000;
    // ...and inside this shorter window it is certainly the same message.
    this.echoMs = options.echoMs ?? 5 * 1000;
    this.now = options.now ?? Date.now;

    this._entries = [];   // newest first
    this._rev = 1;
    this._waiters = new Set();
    this._sweeper = setInterval(() => this._purge(), 15 * 1000);
    this._sweeper.unref?.();
  }

  get rev() {
    this._purge();
    return this._rev;
  }

  /**
   * @returns {{entry: object, duplicate: boolean}}
   */
  add({ code, sender = null, preview = null, domain = null, frameDomain = null }) {
    this._purge();
    const now = this.now();
    const existing = this._entries.find((e) => e.code === code && now - e.receivedAt < this.dedupeMs);
    if (existing) {
      if (now - existing.receivedAt >= this.echoMs) {
        // A genuine re-send of the same code: offer it again.
        existing.receivedAt = now;
        existing.usedAt = null;
        if (sender) existing.sender = sender;
        if (preview) existing.preview = preview;
        if (domain) {
          existing.domain = domain;
          existing.frameDomain = frameDomain;
        }
        this._entries.sort((a, b) => b.receivedAt - a.receivedAt);
        this._bump();
      }
      return { entry: { ...existing }, duplicate: true };
    }

    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      code,
      sender,
      preview,
      domain,          // the website the message says the code is for, if it says so
      frameDomain,
      receivedAt: now,
      usedAt: null,
    };
    this._entries.unshift(entry);
    if (this._entries.length > this.maxEntries) this._entries.length = this.maxEntries;
    this._bump();
    return { entry: { ...entry }, duplicate: false };
  }

  /** Current codes, newest first. */
  list() {
    this._purge();
    return this._entries.map((e) => ({ ...e }));
  }

  markUsed(id) {
    const entry = this._entries.find((e) => e.id === id);
    if (!entry) return false;
    if (!entry.usedAt) {
      entry.usedAt = this.now();
      this._bump();
    }
    return true;
  }

  remove(id) {
    const index = this._entries.findIndex((e) => e.id === id);
    if (index === -1) return false;
    this._entries.splice(index, 1);
    this._bump();
    return true;
  }

  clear() {
    if (this._entries.length === 0) return;
    this._entries = [];
    this._bump();
  }

  /**
   * Resolves with `true` as soon as `rev` differs from `knownRev`, or with
   * `false` after `timeoutMs`. The returned promise has a `cancel()` method
   * for when the caller goes away.
   */
  waitForChange(knownRev, timeoutMs) {
    let waiter;
    const promise = new Promise((resolve) => {
      if (this.rev !== knownRev || timeoutMs <= 0) {
        resolve(this._rev !== knownRev);
        return;
      }
      waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this._waiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      this._waiters.add(waiter);
    });
    promise.cancel = () => {
      if (waiter && this._waiters.delete(waiter)) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
    };
    return promise;
  }

  close() {
    clearInterval(this._sweeper);
    for (const waiter of this._waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this._waiters.clear();
    this._entries = [];
  }

  _purge() {
    const cutoff = this.now() - this.ttlMs;
    const before = this._entries.length;
    this._entries = this._entries.filter((e) => e.receivedAt > cutoff);
    if (this._entries.length !== before) this._bump();
  }

  _bump() {
    this._rev += 1;
    for (const waiter of this._waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    this._waiters.clear();
  }
}

module.exports = { CodeStore };

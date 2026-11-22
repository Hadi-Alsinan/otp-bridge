/*
 * Reading codes that arrive by email.
 *
 * Gmail gives a signed-in browser a short list of its unread mail. That list
 * is where a verification code is looked for: the background script fetches
 * it, this file decides what in it can be trusted, and the trusted mail goes
 * to the companion.
 *
 * How Gmail builds the list, as measured on a real mailbox (November 2026):
 *
 *  - There is one entry for each conversation that has unread mail, up to 20,
 *    and a count of all of them.
 *  - An entry's id and time are those of the NEWEST email in the conversation.
 *  - An entry's first lines are those of the OLDEST UNREAD email in it.
 *
 * So when a new email joins a conversation that still has an unread email in
 * it, the entry looks brand new and shows the older email's code. Nothing in
 * the entry itself tells the two cases apart. What does tell them apart is
 * having looked just before the email arrived: a new conversation adds one to
 * Gmail's count, and an email that joins an unread conversation does not.
 *
 * Two cases get past this, and nothing in the list gives them away:
 *
 *  - The older unread email is outside the inbox (archived without being
 *    opened). Its conversation was not counted, so the new email adds one to
 *    the count and the entry shows the older email's first lines. Measured on
 *    a real mailbox. It is caught only while those lines are among the ones
 *    remembered from earlier looks.
 *  - Two emails of one conversation arrive between two looks. They add one to
 *    the count as one new entry, which shows the first email's lines.
 *
 * It has no browser parts in it, so the tests can load it as well.
 */
'use strict';

(function (root) {
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const WATCH_GAP_MS = 45 * 1000;      // longer than this since the last look, and it says nothing about now
  const CLOCK_SLACK_MS = 5 * 1000;

  function unescapeXml(text) {
    return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (whole, name) => {
      const key = name.toLowerCase();
      if (ENTITIES[key]) return ENTITIES[key];
      const point = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      try {
        return String.fromCodePoint(point);
      } catch {
        return whole;
      }
    });
  }

  /** What is inside the first <name> element of a piece of the list, as written. */
  function inside(xml, name) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
    return match ? match[1] : '';
  }

  /** The same as plain text on one line. */
  function field(xml, name) {
    const raw = inside(xml, name).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
    return unescapeXml(raw).replace(/\s+/g, ' ').trim();
  }

  /**
   * Gmail's list of unread mail as plain objects, or null when the text is
   * something else (a sign-in page, an error page).
   *
   * The list is flat and written by a machine, so it is read with patterns.
   * The background script has no XML reader in every browser.
   */
  function parseFeed(xml) {
    if (typeof xml !== 'string' || !/<feed[\s>]/i.test(xml)) return null;
    const firstEntry = xml.search(/<entry[\s>]/i);
    const head = firstEntry === -1 ? xml : xml.slice(0, firstEntry);
    const account = /[^\s<>"']+@[^\s<>"']+/.exec(field(head, 'title'));
    const count = /^\d+$/.test(field(head, 'fullcount')) ? Number(field(head, 'fullcount')) : null;
    const entries = [];
    const pattern = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
    for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
      const body = match[1];
      const author = inside(body, 'author');
      const at = Date.parse(field(body, 'issued') || field(body, 'modified'));
      entries.push({
        id: field(body, 'id'),
        subject: field(body, 'title'),
        summary: field(body, 'summary'),
        from: field(author, 'name') || field(author, 'email'),
        at: Number.isFinite(at) ? at : null,
      });
    }
    return { account: account ? account[0].toLowerCase() : null, count, entries };
  }

  /** A short mark that stands for a text, so the text itself need not be kept. */
  function markOf(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${text.length}:${hash.toString(36)}`;
  }

  /**
   * Sorts what Gmail lists into mail to pass on, mail that has to be left
   * alone, and what to keep for the next look.
   *
   * An entry is passed on only when all of this holds:
   *  - the list was looked at shortly before, and the entry was not in it;
   *  - its email arrived after that look;
   *  - Gmail's count of unread conversations went up by exactly the number of
   *    entries that are new, so each of them began or woke a conversation of
   *    its own instead of joining one that already had unread mail;
   *  - its words were never in the list before.
   *
   * `known` is what earlier looks kept, { id, at, mark } for each entry seen.
   * `previous` is the look before this one, as returned in `look`.
   *
   * Mail that is left alone comes back in `skipped` with a reason: 'older'
   * when its conversation has an older unread email in it, 'early' when it
   * was already there before anyone was watching, 'changed' when an entry
   * shows other first lines than a moment ago and no email arrived.
   */
  function sortMail(feed, { now, maxAgeMs, known, previous }) {
    const listed = [];
    for (const entry of feed.entries) {
      if (!entry.id || entry.at == null) continue;
      const text = [entry.subject, entry.summary].filter(Boolean).join('\n');
      listed.push({ entry, text, note: { id: entry.id, at: entry.at, mark: markOf(text) } });
    }
    const look = {
      now,
      count: feed.count,
      ids: listed.map((item) => item.note.id),
      marks: listed.map((item) => item.note.mark),
    };

    const watched = previous && now - previous.now <= WATCH_GAP_MS ? previous : null;
    const arrivals = watched ? listed.filter((item) => !watched.ids.includes(item.note.id)).length : 0;
    const eachIsItsOwn = Boolean(watched) && feed.count != null && watched.count != null
      && feed.count - watched.count === arrivals;

    const fresh = [];
    const skipped = [];
    for (const { entry, text, note } of listed) {
      if (known.some((old) => old.id === note.id && old.at === note.at && old.mark === note.mark)) continue;   // looked at before
      // A little into the future is allowed: the two clocks need not agree.
      if (now - entry.at >= maxAgeMs || entry.at - now > 60 * 1000) continue;
      if (!/\p{Nd}/u.test(text)) continue;

      const wordsSeenBefore = known.some((old) => old.mark === note.mark)
        || Boolean(watched && watched.marks.includes(note.mark));
      if (wordsSeenBefore) {
        skipped.push({ note, from: entry.from, reason: 'older' });
      } else if (watched && watched.ids.includes(note.id)) {
        // No new email, and other first lines: an email in the conversation
        // was opened, or marked unread. The words can be any unread email's.
        skipped.push({ note, from: entry.from, reason: 'changed' });
      } else if (!watched || entry.at < watched.now - CLOCK_SLACK_MS) {
        skipped.push({ note, from: entry.from, reason: 'early' });
      } else if (!eachIsItsOwn) {
        skipped.push({ note, from: entry.from, reason: 'older' });
      } else {
        fresh.push({ note, from: entry.from, text });
      }
    }
    return { fresh, skipped, notes: listed.map((item) => item.note), look };
  }

  const exported = { parseFeed, sortMail };
  root.OtpBridgeMail = exported;
  if (typeof module === 'object' && module.exports) module.exports = exported;
})(globalThis);

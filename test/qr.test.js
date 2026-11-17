'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const QR = require('../companion/web/qr');

let jsQR = null;
try {
  jsQR = require('jsqr');
} catch { /* optional: npm install adds it */ }

function fingerprint(qr) {
  const rows = qr.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);
}

/** Paints the code into RGBA pixels, the way a camera would see it. */
function rasterize(qr, scale = 4, border = 4) {
  const dim = (qr.size + border * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (!qr.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const offset = (((y + border) * scale + dy) * dim + (x + border) * scale + dx) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
      }
    }
  }
  return { data, dim };
}

function hasFinder(qr, left, top) {
  for (let dy = 0; dy < 7; dy += 1) {
    for (let dx = 0; dx < 7; dx += 1) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (qr.modules[top + dy][left + dx] !== (ring !== 2)) return false;
    }
  }
  return true;
}

// These exact patterns were confirmed readable by an independent decoder.
const GOLDEN = [
  ['http://192.168.1.23:4812/p/Zk3v9QmX1aB7cD5eF2gH4jK6', 'M', 4, 2, '0b7957c954d607e2'],
  ['HELLO', 'L', 1, 3, 'eea957f1f3550546'],
  ['http://hadis-macbook-pro.local:4812/p/Zk3v9QmX1aB7cD5eF2gH4jK6', 'M', 4, 5, '41ec0baa991516bf'],
  ['x'.repeat(200), 'L', 9, 0, '71ddfbc79101aebe'],
];

for (const [text, level, version, mask, expected] of GOLDEN) {
  test(`known pattern for ${JSON.stringify(text.slice(0, 30))} (${level})`, () => {
    const qr = QR.encode(text, { level });
    assert.equal(qr.version, version);
    assert.equal(qr.mask, mask);
    assert.equal(qr.size, 17 + 4 * version);
    assert.equal(fingerprint(qr), expected);
  });
}

test('structure: size, finder patterns, timing pattern, dark module', () => {
  for (const length of [1, 20, 60, 120, 200]) {
    const qr = QR.encode('a'.repeat(length));
    assert.equal(qr.modules.length, qr.size);
    assert.ok(qr.modules.every((row) => row.length === qr.size));
    assert.ok(hasFinder(qr, 0, 0) && hasFinder(qr, qr.size - 7, 0) && hasFinder(qr, 0, qr.size - 7), `finders at length ${length}`);
    for (let i = 8; i < qr.size - 8; i += 1) {
      assert.equal(qr.modules[6][i], i % 2 === 0, 'horizontal timing');
      assert.equal(qr.modules[i][6], i % 2 === 0, 'vertical timing');
    }
    assert.equal(qr.modules[qr.size - 8][8], true, 'dark module');
  }
});

test('the smallest version that fits is chosen, and too much text is refused', () => {
  assert.equal(QR.encode('a'.repeat(14)).version, 1);
  assert.equal(QR.encode('a'.repeat(15)).version, 2);
  assert.equal(QR.encode('a'.repeat(213)).version, 10);
  assert.throws(() => QR.encode('a'.repeat(214)), RangeError);
  assert.equal(QR.encode('a'.repeat(271), { level: 'L' }).version, 10);
  assert.throws(() => QR.encode('a'.repeat(272), { level: 'L' }), RangeError);
  assert.throws(() => QR.encode('a', { level: 'H' }), RangeError);
});

test('SVG and terminal output', () => {
  const qr = QR.encode('http://192.168.1.23:4812/p/abc');
  const svg = QR.toSvg(qr, { border: 2 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) \1"/);
  assert.ok(svg.includes(`viewBox="0 0 ${qr.size + 4} ${qr.size + 4}"`));
  assert.ok(!/<script|on\w+=/i.test(svg));
  const dark = qr.modules.flat().filter(Boolean).length;
  const drawn = [...svg.matchAll(/h(\d+)v1h-\d+z/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  assert.equal(drawn, dark, 'every dark module is drawn exactly once');

  const lines = QR.toTerminal(qr).split('\n');
  assert.equal(lines.length, Math.ceil((qr.size + 4) / 2));
  assert.ok(lines.every((line) => line.length === qr.size + 4));
});

test('every length decodes with an independent reader', { skip: !jsQR && 'jsqr is not installed' }, () => {
  let seed = 20261116;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:/?=&%';
  for (const [level, max] of [['L', 271], ['M', 213]]) {
    for (let length = 1; length <= max; length += 3) {
      let text = '';
      for (let i = 0; i < length; i += 1) text += alphabet[Math.floor(random() * alphabet.length)];
      const { data, dim } = rasterize(QR.encode(text, { level }));
      const decoded = jsQR(data, dim, dim);
      assert.equal(decoded && decoded.data, text, `level ${level}, ${length} characters`);
    }
  }
  const arabic = 'رمز التحقق ٤٨٢٩١٣';
  const { data, dim } = rasterize(QR.encode(arabic));
  assert.equal(jsQR(data, dim, dim).data, arabic);
});

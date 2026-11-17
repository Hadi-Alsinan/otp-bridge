/*
 * A small QR Code generator (byte mode, versions 1-10, error correction L or M),
 * enough for the pairing link shown on the dashboard. Works in Node and in the
 * browser:
 *
 *   const qr = OtpBridgeQR.encode('http://192.168.1.20:4812/p/abc');
 *   qr.size            // modules per side
 *   qr.modules[y][x]   // true = dark
 *   OtpBridgeQR.toSvg(qr)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OtpBridgeQR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_VERSION = 10;

  // Index = version (index 0 unused).
  var ECC_CODEWORDS_PER_BLOCK = {
    L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
  };
  var NUM_ERROR_CORRECTION_BLOCKS = {
    L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
  };
  var FORMAT_BITS = { L: 1, M: 0 };

  function utf8Bytes(text) {
    return Array.prototype.slice.call(new TextEncoder().encode(String(text)));
  }

  // Number of modules available for data and error correction in a version.
  function numRawDataModules(version) {
    var result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      var numAlign = Math.floor(version / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(version, level) {
    return Math.floor(numRawDataModules(version) / 8)
      - ECC_CODEWORDS_PER_BLOCK[level][version] * NUM_ERROR_CORRECTION_BLOCKS[level][version];
  }

  // --- Reed-Solomon over GF(2^8) / 0x11D -------------------------------------

  function gfMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i -= 1) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsDivisor(degree) {
    var result = [];
    var i;
    for (i = 0; i < degree - 1; i += 1) result.push(0);
    result.push(1);
    var rootPower = 1;
    for (i = 0; i < degree; i += 1) {
      for (var j = 0; j < result.length; j += 1) {
        result[j] = gfMultiply(result[j], rootPower);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      rootPower = gfMultiply(rootPower, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMultiply(coef, factor); });
    });
    return result;
  }

  // --- Data encoding ----------------------------------------------------------

  function chooseVersion(byteLength, level) {
    for (var version = 1; version <= MAX_VERSION; version += 1) {
      var countBits = version < 10 ? 8 : 16;
      if (4 + countBits + byteLength * 8 <= numDataCodewords(version, level) * 8) return version;
    }
    throw new RangeError('Text is too long for a QR code (' + byteLength + ' bytes)');
  }

  function buildDataCodewords(bytes, version, level) {
    var bits = [];
    function push(value, length) {
      for (var i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
    }
    push(0x4, 4);                                  // byte mode
    push(bytes.length, version < 10 ? 8 : 16);     // character count
    bytes.forEach(function (b) { push(b, 8); });

    var capacity = numDataCodewords(version, level) * 8;
    push(0, Math.min(4, capacity - bits.length));  // terminator
    push(0, (8 - (bits.length % 8)) % 8);          // byte boundary
    for (var pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var value = 0;
      for (var j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
      codewords.push(value);
    }
    return codewords;
  }

  function addErrorCorrection(data, version, level) {
    var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[level][version];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[level][version];
    var rawCodewords = Math.floor(numRawDataModules(version) / 8);
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [];
    var divisor = rsDivisor(blockEccLen);
    var k = 0;
    for (var i = 0; i < numBlocks; i += 1) {
      var dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0);         // placeholder, skipped when interleaving
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var col = 0; col < blocks[0].length; col += 1) {
      for (var b = 0; b < blocks.length; b += 1) {
        if (col !== shortBlockLen - blockEccLen || b >= numShortBlocks) result.push(blocks[b][col]);
      }
    }
    return result;
  }

  // --- Matrix -----------------------------------------------------------------

  function alignmentPositions(version, size) {
    if (version === 1) return [];
    var numAlign = Math.floor(version / 7) + 2;
    var step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function createMatrix(version) {
    var size = version * 4 + 17;
    var modules = [];
    var isFunction = [];
    for (var y = 0; y < size; y += 1) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }
    function setFunction(x, y2, dark) {
      modules[y2][x] = dark;
      isFunction[y2][x] = true;
    }

    var i;
    // Timing patterns.
    for (i = 0; i < size; i += 1) {
      setFunction(6, i, i % 2 === 0);
      setFunction(i, 6, i % 2 === 0);
    }
    // Finder patterns with their separators.
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy += 1) {
        for (var dx = -4; dx <= 4; dx += 1) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          var xx = c[0] + dx;
          var yy = c[1] + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunction(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    });
    // Alignment patterns (not where the finders are).
    var align = alignmentPositions(version, size);
    var last = align.length - 1;
    align.forEach(function (ax, ai) {
      align.forEach(function (ay, aj) {
        if ((ai === 0 && aj === 0) || (ai === 0 && aj === last) || (ai === last && aj === 0)) return;
        for (var dy = -2; dy <= 2; dy += 1) {
          for (var dx = -2; dx <= 2; dx += 1) {
            setFunction(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      });
    });

    return { size: size, modules: modules, isFunction: isFunction, setFunction: setFunction };
  }

  function drawFormatBits(m, level, mask) {
    var data = (FORMAT_BITS[level] << 3) | mask;
    var rem = data;
    var i;
    for (i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    function bit(n) { return ((bits >>> n) & 1) !== 0; }

    for (i = 0; i <= 5; i += 1) m.setFunction(8, i, bit(i));
    m.setFunction(8, 7, bit(6));
    m.setFunction(8, 8, bit(7));
    m.setFunction(7, 8, bit(8));
    for (i = 9; i < 15; i += 1) m.setFunction(14 - i, 8, bit(i));

    for (i = 0; i < 8; i += 1) m.setFunction(m.size - 1 - i, 8, bit(i));
    for (i = 8; i < 15; i += 1) m.setFunction(8, m.size - 15 + i, bit(i));
    m.setFunction(8, m.size - 8, true);            // always dark
  }

  function drawVersion(m, version) {
    if (version < 7) return;
    var rem = version;
    var i;
    for (i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var bits = (version << 12) | rem;
    for (i = 0; i < 18; i += 1) {
      var dark = ((bits >>> i) & 1) !== 0;
      var a = m.size - 11 + (i % 3);
      var b = Math.floor(i / 3);
      m.setFunction(a, b, dark);
      m.setFunction(b, a, dark);
    }
  }

  function drawCodewords(m, codewords) {
    var i = 0;
    for (var right = m.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < m.size; vert += 1) {
        for (var j = 0; j < 2; j += 1) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? m.size - 1 - vert : vert;
          if (!m.isFunction[y][x] && i < codewords.length * 8) {
            m.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i += 1;
          }
        }
      }
    }
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  function applyMask(m, mask) {
    for (var y = 0; y < m.size; y += 1) {
      for (var x = 0; x < m.size; x += 1) {
        if (!m.isFunction[y][x] && maskBit(mask, x, y)) m.modules[y][x] = !m.modules[y][x];
      }
    }
  }

  // How hard the pattern is for a scanner to read; lower is better.
  function penaltyScore(m) {
    var size = m.size;
    var mod = m.modules;
    var score = 0;
    var x;
    var y;

    function linePenalty(get) {
      var total = 0;
      for (var a = 0; a < size; a += 1) {
        var runColor = get(a, 0);
        var run = 1;
        var history = '';
        for (var b = 1; b <= size; b += 1) {
          var color = b < size ? get(a, b) : null;
          if (color === runColor) {
            run += 1;
          } else {
            if (run >= 5) total += 3 + (run - 5);
            runColor = color;
            run = 1;
          }
        }
        for (var c = 0; c < size; c += 1) history += get(a, c) ? '1' : '0';
        var from = 0;
        var at;
        while ((at = history.indexOf('10111010000', from)) !== -1) { total += 40; from = at + 1; }
        from = 0;
        while ((at = history.indexOf('00001011101', from)) !== -1) { total += 40; from = at + 1; }
      }
      return total;
    }

    score += linePenalty(function (row, col) { return mod[row][col]; });
    score += linePenalty(function (col, row) { return mod[row][col]; });

    for (y = 0; y < size - 1; y += 1) {
      for (x = 0; x < size - 1; x += 1) {
        var color = mod[y][x];
        if (color === mod[y][x + 1] && color === mod[y + 1][x] && color === mod[y + 1][x + 1]) score += 3;
      }
    }

    var dark = 0;
    for (y = 0; y < size; y += 1) for (x = 0; x < size; x += 1) if (mod[y][x]) dark += 1;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += Math.max(0, k) * 10;
    return score;
  }

  /**
   * @param {string} text
   * @param {{level?: 'L'|'M'}} [options]
   * @returns {{version: number, level: string, mask: number, size: number, modules: boolean[][]}}
   */
  function encode(text, options) {
    var level = (options && options.level) || 'M';
    if (!ECC_CODEWORDS_PER_BLOCK[level]) throw new RangeError('Unsupported error correction level: ' + level);
    var bytes = utf8Bytes(text);
    var version = chooseVersion(bytes.length, level);
    var codewords = addErrorCorrection(buildDataCodewords(bytes, version, level), version, level);

    var m = createMatrix(version);
    drawFormatBits(m, level, 0);                   // reserves the format area
    drawVersion(m, version);
    drawCodewords(m, codewords);

    var bestMask = 0;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask += 1) {
      applyMask(m, mask);
      drawFormatBits(m, level, mask);
      var score = penaltyScore(m);
      if (score < bestScore) { bestScore = score; bestMask = mask; }
      applyMask(m, mask);                          // undo (XOR)
    }
    applyMask(m, bestMask);
    drawFormatBits(m, level, bestMask);

    return { version: version, level: level, mask: bestMask, size: m.size, modules: m.modules };
  }

  /** SVG markup with a quiet zone of `border` modules. */
  function toSvg(qr, options) {
    var border = options && options.border != null ? options.border : 4;
    var dark = (options && options.dark) || '#000000';
    var light = (options && options.light) || '#ffffff';
    var dim = qr.size + border * 2;
    var path = '';
    for (var y = 0; y < qr.size; y += 1) {
      var x = 0;
      while (x < qr.size) {
        if (!qr.modules[y][x]) { x += 1; continue; }
        var start = x;
        while (x < qr.size && qr.modules[y][x]) x += 1;
        path += 'M' + (start + border) + ',' + (y + border) + 'h' + (x - start) + 'v1h-' + (x - start) + 'z';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim
      + '" shape-rendering="crispEdges" role="img" aria-label="QR code">'
      + '<rect width="100%" height="100%" fill="' + light + '"/>'
      + '<path d="' + path + '" fill="' + dark + '"/></svg>';
  }

  /** Text rendering for a terminal, two modules per character row. */
  function toTerminal(qr, options) {
    var border = options && options.border != null ? options.border : 2;
    function dark(x, y) {
      return x >= 0 && y >= 0 && x < qr.size && y < qr.size && qr.modules[y][x];
    }
    var lines = [];
    for (var y = -border; y < qr.size + border; y += 2) {
      var line = '';
      for (var x = -border; x < qr.size + border; x += 1) {
        var top = dark(x, y);
        var bottom = dark(x, y + 1);
        // Drawn inverted: QR "dark" is left blank on a light block background.
        line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  return { encode: encode, toSvg: toSvg, toTerminal: toTerminal, MAX_VERSION: MAX_VERSION };
}));

(function () {
  'use strict';

  function $(selector) { return document.querySelector(selector); }

  var expected = null;
  var openedAt = Date.now();
  var single = $('#otp');
  var boxes = Array.prototype.slice.call(document.querySelectorAll('#boxes input'));

  function api(path, options) {
    options = options || {};
    var headers = { 'X-OTP-Bridge': '1' };
    if (options.body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin'
    }).then(function (res) { return res.json(); });
  }

  function check() {
    $('#success').hidden = !(expected && single.value === expected);
    var joined = boxes.map(function (box) { return box.value; }).join('');
    $('#success-boxes').hidden = !(expected && joined === expected);
  }

  function reset() {
    single.value = '';
    boxes.forEach(function (box) { box.value = ''; });
    check();
  }

  $('#send').addEventListener('click', function () {
    reset();
    $('#status').textContent = 'Sending...';
    api('/api/test', { method: 'POST', body: {} }).then(function (res) {
      if (res && res.code) {
        expected = res.code;
        $('#status').textContent = 'Test code sent. Click the suggestion under the box.';
        single.focus();
      } else {
        $('#status').textContent = 'Could not create a test code.';
      }
    }, function () {
      $('#status').textContent = 'OTP Bridge is not answering.';
    });
  });

  $('#reset').addEventListener('click', function () {
    reset();
    $('#status').textContent = '';
    single.focus();
  });

  single.addEventListener('input', check);

  // The usual behaviour of split code boxes: one character each, the cursor
  // moves on by itself, Backspace moves back, and a pasted code spreads out.
  boxes.forEach(function (box, index) {
    box.addEventListener('input', function () {
      box.value = box.value.replace(/\D/g, '').slice(-1);
      if (box.value && boxes[index + 1]) boxes[index + 1].focus();
      check();
    });
    box.addEventListener('keydown', function (event) {
      if (event.key === 'Backspace' && !box.value && boxes[index - 1]) boxes[index - 1].focus();
    });
    box.addEventListener('paste', function (event) {
      var text = (event.clipboardData && event.clipboardData.getData('text')) || '';
      var digits = text.replace(/\D/g, '').slice(0, boxes.length - index);
      if (!digits) return;
      event.preventDefault();
      digits.split('').forEach(function (digit, offset) { boxes[index + offset].value = digit; });
      var next = boxes[Math.min(index + digits.length, boxes.length - 1)];
      next.focus();
      check();
    });
  });

  // Tell the visitor when the extension is missing, instead of leaving them
  // waiting for a suggestion that cannot appear.
  function watchExtension() {
    api('/api/state').then(function (state) {
      if (!state || !state.ok) return;
      var seen = state.extension && state.extension.lastSeenAt;
      var offset = state.now - Date.now();
      var connected = !!seen && seen > openedAt + offset - 15000;
      $('#no-extension').hidden = connected || Date.now() - openedAt < 4000;
    }).catch(function () { /* keep the last known state */ });
  }
  setInterval(watchExtension, 3000);
  setTimeout(watchExtension, 4200);
}());

(function () {
  'use strict';

  function $(selector) { return document.querySelector(selector); }

  var basePath = window.location.pathname.replace(/\/+$/, '');
  var host = window.location.hostname;
  var onThisComputer = host === 'localhost' || /^127\./.test(host);
  var byName = !onThisComputer && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host);

  // Two addresses lead to the computer. The one with its name stays the same
  // on every network; the one with its number changes with the Wi-Fi. The
  // name is only chosen once this device has reached the computer by it: a
  // check made on the computer itself says nothing about the phone.
  var numericUrl = byName ? null : window.location.origin + basePath;
  var namedUrl = byName ? window.location.origin + basePath : null;
  var nameProven = byName;
  var showing = byName ? 'named' : 'numeric';

  function show(which) {
    if (which === 'named' && !namedUrl) which = 'numeric';
    if (which === 'numeric' && !numericUrl) which = 'named';
    showing = which;
    $('#hook-url').textContent = which === 'named' ? namedUrl : numericUrl;
    var note = $('#url-note');
    var toggle = $('#url-switch');
    toggle.hidden = !(namedUrl && numericUrl);
    toggle.textContent = which === 'named' ? 'Use the number address instead' : 'Use the name address instead';

    if (which === 'named') {
      note.textContent = 'This address uses your computer\'s name. It stays the same on every Wi-Fi, so you only set this up once.'
        + (nameProven ? '' : ' It has not been checked from your phone yet: open this page on the phone to make sure.');
    } else if (onThisComputer) {
      note.textContent = 'This is the computer\'s number on the network it is on now. The number changes when the computer joins '
        + 'a different Wi-Fi. Open this page on the phone: it checks whether the phone can use the name address, which does not change.';
    } else if (namedUrl) {
      note.textContent = 'This address uses your computer\'s current number. It stops working when the computer joins '
        + 'a different Wi-Fi. The name address keeps working.';
    } else {
      note.textContent = 'This address uses your computer\'s current number. If the computer joins a different Wi-Fi, '
        + 'the number changes: scan the code on the computer again and follow "Change the address" below.';
    }
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  // This page is served over plain http on the local network, where the
  // modern clipboard API is not available.
  function legacyCopy(text) {
    var input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.top = '0';
    input.style.opacity = '0';
    input.style.fontSize = '16px';
    document.body.appendChild(input);
    input.focus();
    input.select();
    input.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    input.remove();
    return ok;
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(function (value) { clearTimeout(timer); resolve(value); },
        function (err) { clearTimeout(timer); reject(err); });
    });
  }

  $('#copy-url').addEventListener('click', function () {
    var button = $('#copy-url');
    copy($('#hook-url').textContent).then(function (ok) {
      button.textContent = ok ? 'Copied' : 'Hold the address to copy';
      setTimeout(function () { button.textContent = 'Copy'; }, 2200);
    });
  });

  // "Add the shortcut" also copies the address: the Shortcuts app asks for it
  // a moment later, when this page is no longer in view. The copy is done the
  // old way because it has to finish before the download takes over.
  var copyFailed = false;
  $('#add-shortcut').addEventListener('click', function (event) {
    var out = $('#shortcut-out');
    if (legacyCopy($('#hook-url').textContent)) {
      out.textContent = 'Address copied. Paste it when Shortcuts asks.';
      return;
    }
    // Stop once so that the address can be copied by hand; a second tap goes ahead.
    if (copyFailed) return;
    copyFailed = true;
    event.preventDefault();
    out.textContent = 'The address could not be copied. Hold the address at the top to copy it, then tap this button again.';
  });

  $('#url-switch').addEventListener('click', function () {
    show(showing === 'named' ? 'numeric' : 'named');
  });

  document.addEventListener('click', function (event) {
    var tab = event.target.closest('[data-tab]');
    if (!tab) return;
    selectTab(tab.getAttribute('data-tab'));
  });

  function selectTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (tab) {
      tab.setAttribute('aria-selected', String(tab.getAttribute('data-tab') === name));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), function (panel) {
      panel.hidden = panel.getAttribute('data-panel') !== name;
    });
  }

  $('#send-test').addEventListener('click', function () {
    var out = $('#test-out');
    var code = String(Math.floor(Math.random() * 1000000));
    while (code.length < 6) code = '0' + code;
    out.textContent = 'Sending...';
    fetch(basePath + '?test=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Your OTP Bridge test code is ' + code })
    }).then(function (res) { return res.json(); }).then(function (res) {
      out.textContent = res && res.codeFound
        ? 'Sent ' + code.slice(0, 3) + ' ' + code.slice(3) + '. It should be on your computer now.'
        : 'The computer answered, but something went wrong.';
    }, function () {
      out.textContent = 'Could not reach the computer. Is it on the same Wi-Fi?';
    });
  });

  if (/android/i.test(navigator.userAgent)) selectTab('android');
  show(showing);

  fetch(basePath + '/info').then(function (res) { return res.json(); }).then(function (info) {
    if (!info || !info.ok) return;
    if (info.computerName) $('#computer-name').textContent = info.computerName;

    // When this page was opened by name, or on the computer itself, the
    // address bar does not have the number, so the computer says what it is.
    if (info.address && (byName || onThisComputer)) {
      numericUrl = 'http://' + info.address + ':' + info.port + basePath;
      show(showing);
    }
    if (byName) return;

    // Does the computer answer by name from here? If this is the phone, that
    // is the address to use: it survives a change of Wi-Fi.
    var name = info.localHostname;
    if (!name) return;
    var candidate = 'http://' + name + ':' + info.port;
    withTimeout(fetch(candidate + '/ping', { mode: 'cors' }), 3000)
      .then(function (res) { return res.json(); })
      .then(function (pong) {
        if (pong && pong.app === 'otp-bridge') {
          namedUrl = candidate + basePath;
          nameProven = !onThisComputer;
          show(nameProven ? 'named' : 'numeric');
        }
      })
      .catch(function () { /* name not reachable here; the number address stays */ });
  }).catch(function () { /* the page still works without the extra details */ });
}());

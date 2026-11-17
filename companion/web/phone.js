(function () {
  'use strict';

  function $(selector) { return document.querySelector(selector); }

  var basePath = window.location.pathname.replace(/\/+$/, '');
  var numericUrl = window.location.origin + basePath;
  var namedUrl = null;
  var showing = 'numeric';

  function show(which) {
    showing = which;
    $('#hook-url').textContent = which === 'named' ? namedUrl : numericUrl;
    var note = $('#url-note');
    var toggle = $('#url-switch');
    if (namedUrl) {
      note.textContent = which === 'named'
        ? 'This address uses your computer\'s name, so it keeps working when the router gives the computer a new number.'
        : 'This address uses your computer\'s current number on the network. If it stops working one day, scan the code again.';
      toggle.hidden = false;
      toggle.textContent = which === 'named' ? 'Use the numeric address instead' : 'Use the name address instead';
    } else {
      note.textContent = 'If codes stop arriving one day, the computer probably got a new address from the router. '
        + 'Scan the code on the computer again and paste the new address.';
      toggle.hidden = true;
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
  show('numeric');

  fetch(basePath + '/info').then(function (res) { return res.json(); }).then(function (info) {
    if (!info || !info.ok) return;
    if (info.computerName) $('#computer-name').textContent = info.computerName;

    // If the computer also answers by name on this network, prefer that:
    // names survive the router handing out a new IP address.
    var name = info.localHostname;
    var alreadyByName = !/^\d{1,3}(\.\d{1,3}){3}$/.test(window.location.hostname);
    if (!name || alreadyByName) return;
    var candidate = 'http://' + name + ':' + info.port;
    withTimeout(fetch(candidate + '/ping', { mode: 'cors' }), 3000)
      .then(function (res) { return res.json(); })
      .then(function (pong) {
        if (pong && pong.app === 'otp-bridge') {
          namedUrl = candidate + basePath;
          show('named');
        }
      })
      .catch(function () { /* name not reachable here; the numeric address stays */ });
  }).catch(function () { /* the page still works without the extra details */ });
}());

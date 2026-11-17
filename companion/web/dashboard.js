(function () {
  'use strict';

  var POLL_MS = 1500;
  var FRESH_MS = 3 * 60 * 1000;
  var pageOpenedAt = Date.now();

  var state = null;
  var clockOffset = 0;          // server time minus this page's time
  var extensionAnswered = false;
  var extensionMismatch = false;
  var stepsInitialised = false;
  var lastQrUrl = null;

  function $(selector) { return document.querySelector(selector); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function remember(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) { /* private window: just do without */ }
    return null;
  }

  function api(path, options) {
    options = options || {};
    var headers = { 'X-OTP-Bridge': '1' };
    if (options.body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin'
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        window.location.reload();     // shows the "use your private link" page
        throw new Error('signed-out');
      }
      return res.json();
    });
  }

  function serverNow() { return Date.now() + clockOffset; }

  function ago(timestamp) {
    var seconds = Math.max(0, Math.round((serverNow() - timestamp) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return seconds + ' seconds ago';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes === 1 ? '1 minute ago' : minutes + ' minutes ago';
    var hours = Math.round(minutes / 60);
    if (hours < 48) return hours === 1 ? '1 hour ago' : hours + ' hours ago';
    var days = Math.round(hours / 24);
    return days + ' days ago';
  }

  function formatCode(code) {
    if (/^\d{6}$/.test(code)) return code.slice(0, 3) + ' ' + code.slice(3);
    if (/^\d{8}$/.test(code)) return code.slice(0, 4) + ' ' + code.slice(4);
    return code;
  }

  function copyText(text, button) {
    var done = function () {
      if (!button) return;
      var original = button.dataset.label || button.textContent;
      button.dataset.label = original;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = original; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
    } else {
      legacyCopy(text);
      done();
    }
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing else to try */ }
    area.remove();
  }

  // --- codes ----------------------------------------------------------------

  function renderCodes() {
    var list = $('#codes');
    var codes = state.codes || [];
    list.textContent = '';
    $('#codes-empty').hidden = codes.length > 0;
    $('#clear-codes').hidden = codes.length === 0;

    codes.forEach(function (entry) {
      var fresh = !entry.usedAt && serverNow() - entry.receivedAt < FRESH_MS;
      var row = el('div', 'code-row' + (fresh ? ' fresh' : '') + (entry.usedAt ? ' used' : ''));
      row.appendChild(el('div', 'code-value', formatCode(entry.code)));

      var meta = el('div', 'code-meta');
      if (entry.sender) meta.appendChild(el('div', 'from', entry.sender));
      if (entry.preview) meta.appendChild(el('div', 'preview', entry.preview));
      meta.appendChild(el('div', 'when', ago(entry.receivedAt) + (entry.usedAt ? ' · filled in' : '')));
      row.appendChild(meta);

      var copy = el('button', 'small', 'Copy');
      copy.addEventListener('click', function () { copyText(entry.code, copy); });
      row.appendChild(copy);
      list.appendChild(row);
    });
  }

  // --- browser extension ----------------------------------------------------

  function extensionConnected() {
    if (extensionAnswered) return true;
    var seen = state && state.extension && state.extension.lastSeenAt;
    return !!seen && seen > pageOpenedAt + clockOffset - 5 * 60 * 1000;
  }

  function renderBrowser() {
    var ok = extensionConnected();
    var pill = $('#pill-browser');
    pill.textContent = ok ? 'Browser: connected' : 'Browser: not connected';
    pill.className = 'pill' + (ok ? ' ok' : '');
    $('#state-browser').textContent = ok ? 'Connected' : 'Not connected';
    $('#state-browser').className = 'state' + (ok ? ' ok' : '');
    $('#num-browser').className = 'num' + (ok ? ' done' : '');
    $('#num-browser').textContent = ok ? '✓' : '1';
    if (state.extensionPath) $('#extension-path').textContent = state.extensionPath;

    var other = $('#browser-other');
    if (extensionMismatch && !ok) {
      other.hidden = false;
      other.textContent = 'The extension in this browser is linked to a different OTP Bridge address. '
        + 'Click the OTP Bridge icon in the toolbar, choose "Disconnect", then reload this page.';
    } else {
      other.hidden = true;
    }
  }

  function offerPairing() {
    if (!state || extensionAnswered) return;
    window.postMessage({ type: 'otp-bridge:pair-offer', token: state.pairing.token }, window.location.origin);
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'otp-bridge:extension-ready') offerPairing();
    if (data.type === 'otp-bridge:pair-result') {
      extensionAnswered = data.ok === true;
      extensionMismatch = data.ok !== true && data.reason === 'paired-elsewhere';
      if (state) renderBrowser();
    }
  });

  // --- phone ------------------------------------------------------------------

  function phoneChoices() {
    var net = state.network || { addresses: [] };
    var choices = [];
    net.addresses.forEach(function (a) {
      if (a.virtual && net.addresses.some(function (b) { return !b.virtual; })) return;
      var label = a.address;
      if (a.kind === 'vpn') label += ' (VPN)';
      else if (a.kind === 'link-local') label += ' (no router)';
      choices.push({ id: a.address, label: label, url: a.url });
    });
    if (net.localUrl) choices.push({ id: net.localHostname, label: net.localHostname + ' (name)', url: net.localUrl });
    return choices;
  }

  function renderPhone() {
    var phone = state.phone || {};
    var setUp = !!phone.setupAt;
    var pill = $('#pill-phone');
    var label;
    if (!setUp) label = 'Phone: not set up';
    else if (phone.lastCodeAt) label = 'Phone: last code ' + ago(phone.lastCodeAt);
    else label = 'Phone: set up';
    pill.textContent = label;
    pill.className = 'pill' + (phone.hostStale ? ' warn' : setUp ? ' ok' : '');

    // Which address the phone sends to decides whether it survives a change of Wi-Fi.
    var phoneHost = String(phone.host || '').replace(/:\d+$/, '');
    var usesNumber = /^\d{1,3}(\.\d{1,3}){3}$/.test(phoneHost) && !/^127\./.test(phoneHost);
    var usesName = /\.local$/.test(phoneHost);

    var stateText = setUp ? 'Set up' : 'Not set up';
    if (setUp && usesNumber && !phone.hostStale) stateText += ' · this Wi-Fi only';
    if (setUp && phone.lastMessageAt) stateText += ' · last message ' + ago(phone.lastMessageAt);
    // The phone has opened its setup page but has not sent a real message yet.
    if (!setUp && phone.lastSeenAt) stateText = 'Phone reached this computer · finish the steps on the phone';

    // The usual reason a phone cannot open the address is the computer's firewall.
    var firewall = $('#firewall-hint');
    var hint = '';
    if (!setUp && !phone.lastSeenAt) {
      if (state.platform === 'win32') {
        hint = 'If the phone cannot open the address: Windows asks once whether Node.js may accept connections. '
          + 'Choose Allow with "Private networks" ticked. To change it later, search for '
          + '"Allow an app through Windows Firewall".';
      } else if (state.platform === 'darwin') {
        hint = 'If the phone cannot open the address and the Mac\'s firewall is on, allow incoming connections '
          + 'for "node" in System Settings, Network, Firewall, Options.';
      }
    }
    firewall.hidden = !hint;
    firewall.textContent = hint;
    $('#state-phone').textContent = stateText;
    $('#state-phone').className = 'state' + (phone.hostStale ? ' warn' : setUp ? ' ok' : '');
    $('#num-phone').className = 'num' + (setUp ? ' done' : '');
    $('#num-phone').textContent = setUp ? '✓' : '2';

    var stale = $('#phone-stale');
    if (phone.hostStale) {
      stale.hidden = false;
      stale.textContent = 'Your phone is set up to send codes to ' + phone.host + ', but this computer has a '
        + 'different address on this network now. Scan the code again with the phone and follow '
        + '"Change the address" on the page that opens. If that page shows an address ending in ".local", '
        + 'this will not happen again.';
    } else {
      stale.hidden = true;
    }

    var advice = $('#phone-advice');
    var adviceText = '';
    if (setUp && !phone.hostStale && usesNumber) {
      adviceText = 'Your phone sends codes to ' + phoneHost + ', this computer\'s number on the network it is on now. '
        + 'The number changes when the computer joins a different Wi-Fi, and the phone then needs the new one.';
      if ((state.network || {}).localUrl) {
        adviceText += ' To set it up once: scan the code with the phone again. If the page shows an address '
          + 'ending in ".local", follow "Change the address" there. That address stays the same on every Wi-Fi.';
      }
    } else if (setUp && usesName) {
      adviceText = 'Your phone sends codes to ' + phoneHost + ', this computer\'s name. It stays the same on '
        + 'every Wi-Fi, so the phone does not need setting up again.';
    }
    advice.hidden = !adviceText;
    advice.textContent = adviceText;

    var choices = phoneChoices();
    var select = $('#address-select');
    var wanted = remember('otpb-address');
    var signature = choices.map(function (c) { return c.id; }).join('|');
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.textContent = '';
      choices.forEach(function (choice) {
        var option = el('option', null, choice.label);
        option.value = choice.id;
        select.appendChild(option);
      });
      if (wanted && choices.some(function (c) { return c.id === wanted; })) select.value = wanted;
    }
    $('#no-network').hidden = choices.length > 0;

    var current = choices.filter(function (c) { return c.id === select.value; })[0] || choices[0];
    var url = current ? current.url : '';
    $('#phone-url').textContent = url || 'No address available';
    if (url !== lastQrUrl) {
      lastQrUrl = url;
      var box = $('#qr');
      if (url) {
        // Markup comes from our own generator and contains no outside text.
        box.innerHTML = window.OtpBridgeQR.toSvg(window.OtpBridgeQR.encode(url), { border: 4 });
      } else {
        box.textContent = '';
      }
    }
  }

  // --- settings and the rest --------------------------------------------------

  function renderSettings() {
    var auto = state.autostart || {};
    $('#setting-autostart').hidden = auto.supported === false;
    if (document.activeElement !== $('#opt-autostart')) $('#opt-autostart').checked = auto.enabled === true;
    if (auto.error) $('#autostart-desc').textContent = auto.error;

    var settings = state.settings || {};
    $('#setting-clipboard').hidden = settings.clipboardSupported === false;
    if (document.activeElement !== $('#opt-clipboard')) $('#opt-clipboard').checked = settings.clipboard === true;
  }

  function renderActivity() {
    var list = $('#activity');
    var items = state.activity || [];
    list.textContent = '';
    $('#activity-empty').hidden = items.length > 0;
    items.forEach(function (item) {
      var li = el('li');
      var time = el('time', null, new Date(item.at - clockOffset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      li.appendChild(time);
      li.appendChild(el('span', null, item.text));
      list.appendChild(li);
    });
  }

  function initSteps() {
    if (stepsInitialised) return;
    stepsInitialised = true;
    var phoneReady = !!(state.phone && state.phone.setupAt);
    $('#step-browser').open = !extensionConnected();
    $('#step-phone').open = !phoneReady || !!state.phone.hostStale;
    $('#step-try').open = true;
  }

  function render() {
    $('#computer-name').textContent = state.computerName || 'this computer';
    $('#version').textContent = 'OTP Bridge ' + state.version + '.';
    renderCodes();
    renderBrowser();
    renderPhone();
    renderSettings();
    renderActivity();
    initSteps();
  }

  function refresh() {
    return api('/api/state').then(function (next) {
      if (!next || !next.ok) return;
      state = next;
      clockOffset = next.now - Date.now();
      $('#offline').hidden = true;
      render();
    }).catch(function (err) {
      if (err && err.message === 'signed-out') return;
      $('#offline').hidden = false;
    });
  }

  // --- wiring -------------------------------------------------------------------

  document.addEventListener('click', function (event) {
    var copyButton = event.target.closest('[data-copy]');
    if (copyButton) {
      var source = $(copyButton.getAttribute('data-copy'));
      if (source) copyText(source.textContent, copyButton);
      return;
    }
    var tab = event.target.closest('[data-tab]');
    if (tab) {
      var group = tab.parentElement;
      Array.prototype.forEach.call(group.querySelectorAll('[data-tab]'), function (other) {
        other.setAttribute('aria-selected', String(other === tab));
      });
      var container = group.parentElement;
      Array.prototype.forEach.call(container.querySelectorAll('[data-panel]'), function (panel) {
        panel.hidden = panel.getAttribute('data-panel') !== tab.getAttribute('data-tab');
      });
    }
  });

  $('#copy-link').addEventListener('click', function () {
    if (!state) return;
    copyText(state.pairing.baseUrl + '/?k=' + encodeURIComponent(state.pairing.token), $('#copy-link'));
  });

  $('#address-select').addEventListener('change', function (event) {
    remember('otpb-address', event.target.value);
    if (state) renderPhone();
  });

  $('#clear-codes').addEventListener('click', function () {
    api('/api/codes', { method: 'DELETE' }).then(refresh);
  });

  $('#send-test').addEventListener('click', function () {
    var out = $('#test-result');
    api('/api/test', { method: 'POST', body: {} }).then(function (res) {
      out.textContent = res && res.code ? 'Sent test code ' + formatCode(res.code) + '.' : 'Could not create a test code.';
      refresh();
    });
  });

  $('#opt-clipboard').addEventListener('change', function (event) {
    api('/api/settings', { method: 'POST', body: { clipboard: event.target.checked } }).then(refresh);
  });

  $('#opt-autostart').addEventListener('change', function (event) {
    var box = event.target;
    var desc = $('#autostart-desc');
    box.disabled = true;
    api('/api/autostart', { method: 'POST', body: { enabled: box.checked } }).then(function (res) {
      box.disabled = false;
      if (res && res.ok) {
        desc.textContent = box.checked
          ? 'On. OTP Bridge starts by itself the next time you log in.'
          : 'Off. Start OTP Bridge yourself when you need it.';
      } else {
        box.checked = !box.checked;
        desc.textContent = 'That did not work: ' + ((res && res.error) || 'unknown error');
      }
      box.blur();
      refresh();
    }, function () { box.disabled = false; });
  });

  $('#reset-phone').addEventListener('click', function () {
    if (!window.confirm('Make a new phone address? The address your phone uses now will stop working.')) return;
    api('/api/reset-phone-link', { method: 'POST', body: {} }).then(function () {
      lastQrUrl = null;
      $('#step-phone').open = true;
      refresh();
    });
  });

  $('#check-run').addEventListener('click', function () {
    var out = $('#check-out');
    var text = $('#check-text').value;
    if (!text.trim()) { out.textContent = 'Paste a message first.'; return; }
    api('/api/check', { method: 'POST', body: { message: text } }).then(function (res) {
      out.textContent = res && res.code ? 'Code found: ' + formatCode(res.code) : 'No code found in this message.';
    });
  });

  refresh().then(function () {
    offerPairing();
    setInterval(function () {
      if (document.visibilityState === 'visible') refresh().then(offerPairing);
    }, POLL_MS);
  });
  // A browser does not run a newly added extension in tabs that were already
  // open. So when someone comes back to this tab after adding the extension,
  // load the page again and let the two find each other.
  function onReturn() {
    if (document.visibilityState !== 'visible') return;
    if (state && !extensionConnected() && Date.now() - pageOpenedAt > 4000 && !$('#check-text').value) {
      window.location.reload();
      return;
    }
    refresh();
  }
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);
}());

'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const DEFAULT_ADDRESS = 'http://127.0.0.1:4812/';
const FRESH_MS = 3 * 60 * 1000;

const $ = (selector) => document.querySelector(selector);
let status = null;

function showView(name) {
  for (const view of document.querySelectorAll('main')) view.hidden = view.id !== `view-${name}`;
}

function formatCode(code) {
  if (/^\d{6}$/.test(code)) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (/^\d{8}$/.test(code)) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

function ago(timestamp, now) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1300);
}

/** Asks the page in the current tab to put the code into a field. */
async function fillInPage(entry, button) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    flash(button, 'No page');
    return;
  }
  // First the field that has the cursor, then the most likely code field.
  for (const mode of ['focused', 'best']) {
    let answer = null;
    try {
      answer = await api.tabs.sendMessage(tab.id, { type: 'fill', mode, code: entry.code, id: entry.id });
    } catch { /* no page script here (browser pages, the web store) or nobody answered */ }
    if (answer && answer.ok) {
      window.close();
      return;
    }
  }
  flash(button, 'No field');
}

function renderCodes() {
  const list = $('#codes');
  list.textContent = '';
  const codes = status.codes || [];
  $('#empty').hidden = codes.length > 0;
  for (const entry of codes) {
    const fresh = !entry.usedAt && status.now - entry.receivedAt < FRESH_MS;
    const row = document.createElement('div');
    row.className = `code${fresh ? ' fresh' : ''}${entry.usedAt ? ' used' : ''}`;

    const info = document.createElement('div');
    info.className = 'info';
    const value = document.createElement('div');
    value.className = 'value';
    value.textContent = formatCode(entry.code);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${entry.sender ? `${entry.sender} · ` : ''}${ago(entry.receivedAt, status.now)}${entry.usedAt ? ' · filled in' : ''}`;
    if (entry.preview) meta.title = entry.preview;
    info.append(value, meta);

    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const fill = document.createElement('button');
    fill.textContent = 'Fill';
    fill.addEventListener('click', () => fillInPage(entry, fill));
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(entry.code);
        flash(copy, 'Copied');
      } catch {
        flash(copy, 'Failed');
      }
    });
    buttons.append(fill, copy);
    row.append(info, buttons);
    list.appendChild(row);
  }
}

async function refresh() {
  status = await api.runtime.sendMessage({ type: 'status' }).catch(() => null);
  const dot = $('#dot');
  if (!status || !status.ok) {
    showView('offline');
    dot.className = 'dot bad';
    return;
  }
  if (!status.paired) {
    showView('unpaired');
    dot.className = 'dot';
    dot.title = 'Not connected';
    return;
  }
  if (!status.online) {
    showView('offline');
    dot.className = 'dot bad';
    dot.title = 'OTP Bridge is not running';
    return;
  }
  showView('online');
  dot.className = 'dot ok';
  dot.title = `Connected to OTP Bridge ${status.version}`;
  $('#stale').hidden = !status.phone.hostStale;
  const phone = status.phone;
  $('#phone-line').textContent = !phone.setupAt ? 'Phone: not set up yet. Open the dashboard to connect it.'
    : phone.lastCodeAt ? `Phone: last code ${ago(phone.lastCodeAt, status.now)}.`
      : 'Phone: set up. Waiting for the next code.';
  renderCodes();
}

function openTab(url) {
  api.tabs.create({ url });
  window.close();
}

$('#open-default').addEventListener('click', () => openTab(DEFAULT_ADDRESS));
$('#dashboard').addEventListener('click', () => openTab(status && status.dashboardUrl ? status.dashboardUrl : DEFAULT_ADDRESS));
$('#retry').addEventListener('click', refresh);

$('#connect').addEventListener('click', async () => {
  const error = $('#link-error');
  error.hidden = true;
  const answer = await api.runtime.sendMessage({ type: 'pair-link', link: $('#link').value }).catch(() => null);
  if (answer && answer.ok) {
    refresh();
    return;
  }
  error.hidden = false;
  error.textContent = answer && answer.reason === 'bad-link'
    ? 'That does not look like the OTP Bridge link. It starts with http://127.0.0.1 and contains "?k=".'
    : 'OTP Bridge did not answer at that address. Is it running?';
});

async function disconnect() {
  await api.runtime.sendMessage({ type: 'unpair' }).catch(() => null);
  refresh();
}
$('#disconnect').addEventListener('click', disconnect);
$('#disconnect-offline').addEventListener('click', disconnect);

refresh();

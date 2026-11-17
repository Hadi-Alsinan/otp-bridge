'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { defaultConfigDir, loadConfig, saveConfig, isValidPort, newToken } = require('./config');
const { createCompanion, APP_ID } = require('./server');
const { createClipboard } = require('./clipboard');
const { createAutostart } = require('./autostart');
const netinfo = require('./netinfo');
const QR = require('../web/qr');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const PORT_SEARCH_SPAN = 20;

const HELP = `OTP Bridge: fill in verification codes from your phone on this computer.

Usage:  node companion/cli.js [command] [options]

Commands
  start                 Run OTP Bridge (this is the default)
  open                  Open the dashboard in your browser
  status                Show whether it is running and what is connected
  qr                    Show the phone pairing code here in the terminal
  test [message]        Send a test message, as if it came from the phone
  stop                  Stop the copy that is running in the background
  autostart on|off      Start OTP Bridge by itself when you log in
  autostart status
  reset-phone           Make a new phone address (the old one stops working)
  help, version

Options
  --port <number>       Port to listen on (default 4812; remembered)
  --no-open             Do not open the dashboard when starting
  --local-only          Listen on this computer only (the phone cannot connect)
  --visible             With "autostart on" on Windows: run in a minimised window
  --config-dir <path>   Where settings are kept
`;

class UserError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.userMessage = message;
    this.exitCode = exitCode;
  }
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseArgs(argv) {
  const opts = { words: [] };
  const valueOf = (i, name) => {
    const value = argv[i];
    if (value === undefined) throw new UserError(`${name} needs a value.`, 2);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') opts.port = Number(valueOf(i += 1, '--port'));
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length));
    else if (arg === '--config-dir') opts.configDir = valueOf(i += 1, '--config-dir');
    else if (arg.startsWith('--config-dir=')) opts.configDir = arg.slice('--config-dir='.length);
    else if (arg === '--no-open') opts.open = false;
    else if (arg === '--open') opts.open = true;
    else if (arg === '--local-only') opts.localOnly = true;
    else if (arg === '--visible') opts.visible = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--version' || arg === '-v') opts.version = true;
    else if (arg.startsWith('-') && arg !== '-') throw new UserError(`Unknown option: ${arg}\nRun with "help" to see what is available.`, 2);
    else opts.words.push(arg);
  }
  if (opts.port !== undefined && !isValidPort(opts.port)) {
    throw new UserError('--port must be a number between 1024 and 65535.', 2);
  }
  return opts;
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function openInBrowser(url, platform = process.platform) {
  const [command, args] = platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser to open (for example on a server); the link is printed anyway
  }
}

/** A request to the copy of OTP Bridge running on this computer. */
function localRequest(port, { method = 'GET', pathname, token = null, body = null, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not ours */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, json: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * What is on the port? 'running' (our copy with our settings), 'foreign'
 * (an OTP Bridge with different settings), 'other' (some other program),
 * or 'free'.
 */
async function probe(port, token) {
  const ping = await localRequest(port, { pathname: '/ping', timeoutMs: 2500 });
  if (ping.status === 0) return { what: 'free' };
  if (!ping.json || ping.json.app !== APP_ID) return { what: 'other' };
  const status = await localRequest(port, { pathname: '/api/status', token, timeoutMs: 2500 });
  if (status.status === 200 && status.json && status.json.ok) return { what: 'running', version: status.json.version };
  return { what: 'foreign' };
}

function dashboardUrl(config) {
  return `http://127.0.0.1:${config.port}/?k=${config.localToken}`;
}

function context(opts) {
  const dir = opts.configDir ? path.resolve(opts.configDir) : defaultConfigDir();
  const loaded = loadConfig(dir);
  return { dir, config: loaded.config, created: loaded.created };
}

async function phoneAddresses(config) {
  const primary = await netinfo.detectPrimaryAddress();
  const all = netinfo.listLanAddresses(primary);
  const usable = all.some((a) => !a.virtual) ? all.filter((a) => !a.virtual) : all;
  return usable.map((a) => `http://${a.address}:${config.port}/p/${config.phoneToken}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandStart(opts, out) {
  const { dir, config, created } = context(opts);
  const version = readVersion();
  if (opts.port !== undefined && opts.port !== config.port) {
    config.port = opts.port;
    config.portConfirmed = false;
  }

  const log = (line) => out(`[${timestamp()}] ${line}`);
  let app = null;
  let stopping = false;
  const shutdown = (message) => {
    if (stopping) return;
    stopping = true;
    if (message) out(message);
    const done = () => process.exit(0);
    if (app) app.close().then(done, done);
    else done();
    setTimeout(done, 1500).unref();
  };

  const extensionDir = path.join(APP_ROOT, 'extension');
  app = createCompanion({
    config,
    persist: (c) => saveConfig(dir, c),
    version,
    clipboard: createClipboard(),
    autostart: createAutostart({ configDir: dir, appRoot: APP_ROOT }),
    extensionPath: fs.existsSync(path.join(extensionDir, 'manifest.json')) ? extensionDir : null,
    log,
    onShutdown: () => shutdown('Stopped on request.'),
  });

  const host = opts.localOnly ? '127.0.0.1' : '0.0.0.0';
  // Until a port has worked once, a busy port just means "try the next one".
  // After that the port is part of the phone's address and must not move.
  const mayMove = opts.port === undefined && (created || !config.portConfirmed);
  let port = config.port;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await app.listen(port, host);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') {
        await app.close();
        throw new UserError(`Could not start on port ${port}: ${err.message}`);
      }
      const found = await probe(port, config.localToken);
      if (found.what === 'running') {
        await app.close();
        out('OTP Bridge is already running on this computer.');
        out(`  Dashboard:  ${dashboardUrl({ ...config, port })}`);
        if (found.version && found.version !== version) {
          out(`  The running copy is version ${found.version}; this folder has version ${version}.`);
          out('  To switch, run "node companion/cli.js stop" and start again.');
        }
        if (opts.open !== false) openInBrowser(dashboardUrl({ ...config, port }));
        return 0;
      }
      if (!mayMove || attempt >= PORT_SEARCH_SPAN) {
        await app.close();
        const who = found.what === 'foreign' ? 'another copy of OTP Bridge with different settings' : 'another program';
        throw new UserError(`Port ${port} is being used by ${who}.\n`
          + 'Close that program, or pick another port with --port <number> '
          + '(the phone address changes with the port).');
      }
      port += 1;
    }
  }

  if (config.port !== port || !config.portConfirmed) {
    config.port = port;
    config.portConfirmed = true;
    saveConfig(dir, config);
  }

  const phone = opts.localOnly ? [] : await phoneAddresses(config);
  out('');
  out(`OTP Bridge ${version} is running.`);
  out('');
  out(`  Dashboard (this computer):  ${dashboardUrl(config)}`);
  if (phone.length) out(`  Address for your phone:     ${phone[0]}`);
  else if (opts.localOnly) out('  Started with --local-only: the phone cannot connect.');
  else out('  No network connection found: the phone cannot connect yet.');
  out('');
  out('  Keep this window open, or switch on "Start OTP Bridge when I log in" on the dashboard.');
  out('  Press Ctrl+C to stop.');
  out('');

  if (opts.open !== false) openInBrowser(dashboardUrl(config));

  // A helper that runs unseen in the background should survive a surprise
  // rather than vanish without a trace.
  const survive = (err) => log(`Unexpected error (still running): ${err && err.stack ? err.stack : err}`);
  process.on('uncaughtException', survive);
  process.on('unhandledRejection', survive);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, () => shutdown(''));
    } catch {
      // signal not available on this platform
    }
  }
  return undefined;   // keep running
}

async function requireRunning(config) {
  const found = await probe(config.port, config.localToken);
  if (found.what === 'running') return found;
  if (found.what === 'foreign') {
    throw new UserError(`Port ${config.port} belongs to a copy of OTP Bridge with different settings.`);
  }
  throw new UserError('OTP Bridge is not running. Start it with:  node companion/cli.js');
}

async function commandOpen(opts, out) {
  const { config } = context(opts);
  await requireRunning(config);
  out(dashboardUrl(config));
  if (opts.open !== false) openInBrowser(dashboardUrl(config));
  return 0;
}

function since(timestampMs, nowMs) {
  if (!timestampMs) return 'never';
  const seconds = Math.max(0, Math.round((nowMs - timestampMs) / 1000));
  if (seconds < 90) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  return `${Math.round(minutes / 60)} hours ago`;
}

async function commandStatus(opts, out) {
  const { dir, config } = context(opts);
  const autostart = createAutostart({ configDir: dir, appRoot: APP_ROOT }).status();
  const found = await probe(config.port, config.localToken);
  if (found.what !== 'running') {
    out(found.what === 'foreign'
      ? `Port ${config.port} belongs to a copy of OTP Bridge with different settings.`
      : 'OTP Bridge is not running.');
    out(`Start at login:  ${autostart.supported ? (autostart.enabled ? 'on' : 'off') : 'not available on this system'}`);
    out(`Settings folder: ${dir}`);
    return 1;
  }
  const { json: state } = await localRequest(config.port, { pathname: '/api/state', token: config.localToken });
  out(`OTP Bridge ${found.version} is running on port ${config.port}.`);
  if (state && state.ok) {
    const phone = state.phone;
    out(`Phone:           ${phone.setupAt ? `set up, last message ${since(phone.lastMessageAt, state.now)}` : 'not set up yet'}`);
    if (phone.hostStale) out(`                 The phone still sends to ${phone.host}, which is no longer this computer's address.`);
    out(`Browser:         ${state.extension.lastSeenAt ? `extension seen ${since(state.extension.lastSeenAt, state.now)}` : 'extension not seen since start'}`);
    out(`Codes in memory: ${state.codes.length}`);
    for (const address of state.network.addresses.filter((a) => !a.virtual)) out(`Phone address:   ${address.url}`);
  }
  out(`Start at login:  ${autostart.supported ? (autostart.enabled ? 'on' : 'off') : 'not available on this system'}`);
  out(`Settings folder: ${dir}`);
  return 0;
}

async function commandQr(opts, out) {
  const { config } = context(opts);
  const urls = await phoneAddresses(config);
  if (urls.length === 0) throw new UserError('This computer has no network address right now. Connect to Wi-Fi first.');
  out(QR.toTerminal(QR.encode(urls[0])));
  out('');
  out(`Scan with your phone's camera, or open:  ${urls[0]}`);
  const found = await probe(config.port, config.localToken);
  if (found.what !== 'running') out('Note: OTP Bridge is not running, so the address will not answer yet.');
  return 0;
}

async function commandTest(opts, out) {
  const { config } = context(opts);
  await requireRunning(config);
  const message = opts.words.slice(1).join(' ');
  const { json } = await localRequest(config.port, {
    method: 'POST', pathname: '/api/test', token: config.localToken, body: message ? { message } : {},
  });
  if (json && json.codeFound) out(`Test code ${json.code} is now waiting in your browser.`);
  else if (json && json.ok) out('The message was received, but no code was found in it.');
  else throw new UserError('The test could not be sent.');
  return 0;
}

async function commandStop(opts, out) {
  const { config } = context(opts);
  const found = await probe(config.port, config.localToken);
  if (found.what !== 'running') {
    out('OTP Bridge is not running.');
    return 0;
  }
  await localRequest(config.port, { method: 'POST', pathname: '/api/shutdown', token: config.localToken, body: {} });
  out('OTP Bridge was stopped.');
  return 0;
}

async function commandAutostart(opts, out) {
  const { dir } = context(opts);
  const autostart = createAutostart({ configDir: dir, appRoot: APP_ROOT });
  const action = (opts.words[1] || 'status').toLowerCase();
  if (!autostart.supported) throw new UserError('Starting at login is not available on this system.');

  if (action === 'on' || action === 'enable') {
    const result = autostart.enable({ visible: opts.visible === true });
    out('OTP Bridge will now start by itself when you log in.');
    out(`  Registered here: ${result.location}`);
    out(`  App copy:        ${autostart.paths.installDir}`);
    return 0;
  }
  if (action === 'off' || action === 'disable') {
    autostart.disable();
    out('OTP Bridge will no longer start by itself.');
    return 0;
  }
  if (action === 'status') {
    const status = autostart.status();
    out(status.enabled ? `Start at login is on (${status.location}).` : 'Start at login is off.');
    return 0;
  }
  throw new UserError('Use: autostart on | off | status', 2);
}

async function commandResetPhone(opts, out) {
  const { dir, config } = context(opts);
  const found = await probe(config.port, config.localToken);
  if (found.what === 'running') {
    await localRequest(config.port, { method: 'POST', pathname: '/api/reset-phone-link', token: config.localToken, body: {} });
  } else {
    config.phoneToken = newToken();
    delete config.phone;
    saveConfig(dir, config);
  }
  out('The phone address was reset. Scan the code on the dashboard again and update the address on your phone.');
  return 0;
}

const COMMANDS = {
  start: commandStart,
  open: commandOpen,
  status: commandStatus,
  qr: commandQr,
  test: commandTest,
  stop: commandStop,
  autostart: commandAutostart,
  'reset-phone': commandResetPhone,
};

/**
 * @param {string[]} argv  Arguments after "node cli.js".
 * @param {(line: string) => void} [out]
 * @returns {Promise<number|undefined>} exit code, or undefined while the server keeps running
 */
async function run(argv, out = (line) => console.log(line)) {
  let opts;
  try {
    opts = parseArgs(argv);
    const command = opts.words[0] || 'start';
    if (opts.help || command === 'help') {
      out(HELP);
      return 0;
    }
    if (opts.version || command === 'version') {
      out(readVersion());
      return 0;
    }
    const handler = Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : null;
    if (!handler) throw new UserError(`Unknown command: ${command}\nRun with "help" to see what is available.`, 2);
    return await handler(opts, out);
  } catch (err) {
    if (err instanceof UserError) {
      console.error(err.userMessage);
      return err.exitCode;
    }
    throw err;
  }
}

module.exports = { run, parseArgs, probe, HELP, UserError };

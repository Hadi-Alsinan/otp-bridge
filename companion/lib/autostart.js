'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * "Start OTP Bridge when I log in."
 *
 * Turning it on does two things:
 *   1. copies the app into the settings folder, so it keeps working if the
 *      downloaded folder is moved or deleted (and, on a Mac, so a background
 *      job is not blocked from reading Desktop / Documents / Downloads);
 *   2. registers that copy with the operating system:
 *        macOS    a LaunchAgent in ~/Library/LaunchAgents
 *        Windows  a small launcher in the Startup folder
 *        Linux    an entry in ~/.config/autostart
 */

const LABEL = 'com.otpbridge.companion';
const INSTALL_ITEMS = ['companion', 'extension', 'package.json'];

function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function launchAgentPlist({ nodePath, cliPath, logPath }) {
  const args = [nodePath, cliPath, 'start', '--no-open'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

// Windows paths cannot contain a double quote, so wrapping them is enough.
function windowsCommandLine(nodePath, cliPath) {
  return `"${nodePath}" "${cliPath}" start --no-open`;
}

/**
 * A Windows Script File that starts the companion with no window at all.
 * Every character that is not plainly safe is written as a \\uXXXX escape, so
 * the file is pure ASCII and survives any user name or folder name.
 */
function windowsHiddenLauncher({ nodePath, cliPath }) {
  const command = windowsCommandLine(nodePath, cliPath);
  let literal = '';
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    literal += /[A-Za-z0-9 ._-]/.test(ch) ? ch : `\\u${command.charCodeAt(i).toString(16).padStart(4, '0')}`;
  }
  return [
    '<job id="OTPBridge">',
    '<script language="JScript">',
    '// Starts OTP Bridge in the background when you log in.',
    '// Created by OTP Bridge; delete this file to stop that.',
    'var shell = new ActiveXObject("WScript.Shell");',
    `shell.Run("${literal}", 0, false);`,
    '</script>',
    '</job>',
    '',
  ].join('\r\n');
}

/** The plain alternative: a minimised window that stays in the taskbar. */
function windowsVisibleLauncher({ nodePath, cliPath }) {
  const escape = (p) => String(p).replace(/%/g, '%%');
  return [
    '@echo off',
    'rem Starts OTP Bridge when you log in. Created by OTP Bridge; delete this file to stop that.',
    'chcp 65001 >nul',
    `start "OTP Bridge" /min "${escape(nodePath)}" "${escape(cliPath)}" start --no-open`,
    '',
  ].join('\r\n');
}

function desktopEntryQuote(arg) {
  return `"${String(arg).replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`;
}

function linuxDesktopEntry({ nodePath, cliPath }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=OTP Bridge',
    'Comment=Fill in verification codes from your phone',
    `Exec=${desktopEntryQuote(nodePath)} ${desktopEntryQuote(cliPath)} start --no-open`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/**
 * @param {object} options
 * @param {string} options.configDir  Settings folder; the app copy goes into "<configDir>/app".
 * @param {string} options.appRoot    Folder that holds "companion" and "extension" right now.
 */
function createAutostart(options) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const configDir = options.configDir;
  const appRoot = path.resolve(options.appRoot);
  const nodePath = options.nodePath || process.execPath;
  const exec = options.exec || ((command, args) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }));
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);

  const installDir = path.join(configDir, 'app');
  const cliPath = path.join(installDir, 'companion', 'cli.js');
  const logPath = path.join(configDir, 'companion.log');

  const supported = platform === 'darwin' || platform === 'win32' || platform === 'linux';
  const plistPath = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const startupDir = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const hiddenLauncher = path.join(startupDir, 'OTP Bridge.wsf');
  const visibleLauncher = path.join(startupDir, 'OTP Bridge.cmd');
  const desktopFile = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'otp-bridge.desktop');

  // When launchd itself started this process, unloading the job would stop us mid-request.
  const startedByLaunchd = platform === 'darwin' && env.XPC_SERVICE_NAME === LABEL;

  function registrations() {
    if (platform === 'darwin') return [plistPath];
    if (platform === 'win32') return [hiddenLauncher, visibleLauncher];
    return [desktopFile];
  }

  function status() {
    if (!supported) return { supported: false };
    const location = registrations().find((file) => fs.existsSync(file)) || null;
    return { supported: true, enabled: location !== null, location };
  }

  function installCopy() {
    if (path.resolve(installDir) === appRoot) return;
    for (const item of INSTALL_ITEMS) {
      if (!fs.existsSync(path.join(appRoot, item))) {
        throw new Error(`Cannot find "${item}" in ${appRoot}`);
      }
    }
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.mkdirSync(installDir, { recursive: true });
    for (const item of INSTALL_ITEMS) {
      fs.cpSync(path.join(appRoot, item), path.join(installDir, item), { recursive: true });
    }
  }

  function launchctl(args) {
    try {
      exec('launchctl', args);
      return null;
    } catch (err) {
      return String((err.stderr && err.stderr.toString()) || err.message || err).trim();
    }
  }

  function pause(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  /** Loading right after unloading can fail for a moment, so try a few times. */
  function loadLaunchAgent() {
    let failure = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      failure = launchctl(['bootstrap', `gui/${uid}`, plistPath]);
      if (!failure) return null;
      pause(options.retryDelayMs ?? 400);
    }
    return launchctl(['load', '-w', plistPath]) ? failure : null;
  }

  function enable({ visible = false } = {}) {
    if (!supported) throw new Error('Starting at login is not supported on this system.');
    installCopy();

    if (platform === 'darwin') {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, launchAgentPlist({ nodePath, cliPath, logPath }));
      if (!startedByLaunchd && uid !== null) {
        launchctl(['bootout', `gui/${uid}/${LABEL}`]);          // fine if it was not loaded
        const failure = loadLaunchAgent();
        if (failure) {
          throw new Error(`macOS did not accept the login item (${failure}). `
            + 'It is saved and should start at your next login; if not, see the README.');
        }
      }
    } else if (platform === 'win32') {
      fs.mkdirSync(startupDir, { recursive: true });
      fs.rmSync(hiddenLauncher, { force: true });
      fs.rmSync(visibleLauncher, { force: true });
      if (visible) fs.writeFileSync(visibleLauncher, windowsVisibleLauncher({ nodePath, cliPath }), 'utf8');
      else fs.writeFileSync(hiddenLauncher, windowsHiddenLauncher({ nodePath, cliPath }), 'ascii');
    } else {
      fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
      fs.writeFileSync(desktopFile, linuxDesktopEntry({ nodePath, cliPath }));
    }
    return status();
  }

  function disable() {
    if (!supported) return { supported: false };
    if (platform === 'darwin' && !startedByLaunchd && uid !== null && fs.existsSync(plistPath)) {
      launchctl(['bootout', `gui/${uid}/${LABEL}`]);
    }
    for (const file of registrations()) fs.rmSync(file, { force: true });
    // The copy in the settings folder stays: it may be the code that is running right now.
    return status();
  }

  return {
    supported,
    status,
    enable,
    disable,
    paths: { installDir, cliPath, logPath, plistPath, hiddenLauncher, visibleLauncher, desktopFile },
  };
}

module.exports = {
  LABEL,
  createAutostart,
  launchAgentPlist,
  windowsHiddenLauncher,
  windowsVisibleLauncher,
  windowsCommandLine,
  linuxDesktopEntry,
};

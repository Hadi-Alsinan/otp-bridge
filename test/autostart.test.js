'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  LABEL, createAutostart, launchAgentPlist, windowsHiddenLauncher, windowsVisibleLauncher, linuxDesktopEntry,
} = require('../companion/lib/autostart');

const APP_ROOT = path.resolve(__dirname, '..');
const hasPython = spawnSync('python3', ['--version']).status === 0;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-bridge-autostart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Awkward on purpose: spaces, an ampersand, an apostrophe, a percent sign, Arabic.
const WIN_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const WIN_CLI = 'C:\\Users\\هادي & O\'Brien 100%\\AppData\\Roaming\\otp-bridge\\app\\companion\\cli.js';

test('macOS: the LaunchAgent is a valid property list with the right command', { skip: !hasPython }, (t) => {
  const dir = tempDir(t);
  const nodePath = '/opt/homebrew/bin/node';
  const cliPath = '/Users/hadi & <co>/Library/Application Support/otp-bridge/app/companion/cli.js';
  const logPath = '/Users/hadi & <co>/Library/Application Support/otp-bridge/companion.log';
  const file = path.join(dir, 'agent.plist');
  fs.writeFileSync(file, launchAgentPlist({ nodePath, cliPath, logPath }));
  const parsed = JSON.parse(execFileSync('python3', ['-c',
    'import plistlib, json, sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', file]).toString());
  assert.equal(parsed.Label, LABEL);
  assert.deepEqual(parsed.ProgramArguments, [nodePath, cliPath, 'start', '--no-open']);
  assert.equal(parsed.RunAtLoad, true);
  assert.deepEqual(parsed.KeepAlive, { SuccessfulExit: false });
  assert.equal(parsed.StandardOutPath, logPath);
  assert.equal(parsed.StandardErrorPath, logPath);
});

test('Windows: the hidden launcher is plain ASCII and runs exactly the intended command', () => {
  const launcher = windowsHiddenLauncher({ nodePath: WIN_NODE, cliPath: WIN_CLI });
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(launcher), 'ASCII only, whatever the user name');
  assert.ok(launcher.includes('\r\n'));
  assert.match(launcher, /^<job id="OTPBridge">\r\n<script language="JScript">/);
  assert.match(launcher, /<\/script>\r\n<\/job>\r\n$/);

  const script = /<script language="JScript">([\s\S]*)<\/script>/.exec(launcher)[1];
  assert.ok(!/[<>&]/.test(script), 'nothing an XML parser could trip over');

  // Run the script with a stand-in for Windows Script Host and see what it would start.
  const runs = [];
  const created = [];
  function ActiveXObject(name) {
    created.push(name);
    this.Run = (...args) => runs.push(args);
  }
  vm.runInNewContext(script, { ActiveXObject });
  assert.deepEqual(created, ['WScript.Shell']);
  assert.equal(runs.length, 1);
  const [command, windowStyle, wait] = runs[0];
  assert.equal(command, `"${WIN_NODE}" "${WIN_CLI}" start --no-open`);
  assert.equal(windowStyle, 0, 'hidden window');
  assert.equal(wait, false, 'does not wait for it to finish');
});

test('Windows: the visible launcher starts a minimised window', () => {
  const launcher = windowsVisibleLauncher({ nodePath: WIN_NODE, cliPath: WIN_CLI });
  const lines = launcher.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.ok(lines.includes('chcp 65001 >nul'));
  const start = lines.find((line) => line.startsWith('start '));
  assert.equal(start, `start "OTP Bridge" /min "${WIN_NODE}" "${WIN_CLI.replace('%', '%%')}" start --no-open`);
});

test('Linux: the autostart entry quotes its command', () => {
  const entry = linuxDesktopEntry({ nodePath: '/usr/bin/node', cliPath: '/home/h a/$x/"q"/100%/cli.js' });
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\nName=OTP Bridge\n/);
  assert.ok(entry.includes('Exec="/usr/bin/node" "/home/h a/\\$x/\\"q\\"/100%%/cli.js" start --no-open\n'));
});

test('turning it on installs a working copy and registers it (Linux)', (t) => {
  const home = tempDir(t);
  const configDir = path.join(home, '.config', 'otp-bridge');
  const autostart = createAutostart({ platform: 'linux', env: {}, home, configDir, appRoot: APP_ROOT });
  assert.deepEqual(autostart.status(), { supported: true, enabled: false, location: null });

  const status = autostart.enable();
  const desktopFile = path.join(home, '.config', 'autostart', 'otp-bridge.desktop');
  assert.deepEqual(status, { supported: true, enabled: true, location: desktopFile });
  const installedCli = path.join(configDir, 'app', 'companion', 'cli.js');
  assert.ok(fs.existsSync(installedCli));
  assert.ok(fs.existsSync(path.join(configDir, 'app', 'extension', 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(configDir, 'app', 'node_modules')));
  assert.equal(fs.readFileSync(desktopFile, 'utf8'), linuxDesktopEntry({ nodePath: process.execPath, cliPath: installedCli }));

  // The copy runs on its own.
  const version = execFileSync(process.execPath, [installedCli, 'version']).toString().trim();
  assert.equal(version, require('../package.json').version);

  // Turning it on again replaces the copy cleanly.
  fs.writeFileSync(path.join(configDir, 'app', 'stale.txt'), 'old');
  autostart.enable();
  assert.ok(!fs.existsSync(path.join(configDir, 'app', 'stale.txt')));

  assert.deepEqual(autostart.disable(), { supported: true, enabled: false, location: null });
  assert.ok(!fs.existsSync(desktopFile));
});

test('running from the installed copy does not copy onto itself', (t) => {
  const home = tempDir(t);
  const configDir = path.join(home, 'cfg');
  createAutostart({ platform: 'linux', env: {}, home, configDir, appRoot: APP_ROOT }).enable();
  const marker = path.join(configDir, 'app', 'companion', 'marker.txt');
  fs.writeFileSync(marker, 'still here');
  const fromCopy = createAutostart({ platform: 'linux', env: {}, home, configDir, appRoot: path.join(configDir, 'app') });
  fromCopy.enable();
  assert.equal(fs.readFileSync(marker, 'utf8'), 'still here');
});

test('Windows: files land in the Startup folder, hidden by default', (t) => {
  const home = tempDir(t);
  const appData = path.join(home, 'AppData', 'Roaming');
  const configDir = path.join(appData, 'otp-bridge');
  const autostart = createAutostart({ platform: 'win32', env: { APPDATA: appData }, home, configDir, appRoot: APP_ROOT, nodePath: WIN_NODE });
  const startup = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

  const hidden = autostart.enable();
  assert.equal(hidden.location, path.join(startup, 'OTP Bridge.wsf'));
  assert.deepEqual(fs.readdirSync(startup), ['OTP Bridge.wsf']);

  const visible = autostart.enable({ visible: true });
  assert.equal(visible.location, path.join(startup, 'OTP Bridge.cmd'));
  assert.deepEqual(fs.readdirSync(startup), ['OTP Bridge.cmd'], 'only one launcher at a time');
  assert.ok(fs.readFileSync(visible.location, 'utf8').includes(`"${WIN_NODE}"`));

  autostart.disable();
  assert.deepEqual(fs.readdirSync(startup), []);
  assert.equal(autostart.status().enabled, false);
});

test('macOS: the agent is written and loaded through launchctl', (t) => {
  const home = tempDir(t);
  const configDir = path.join(home, 'Library', 'Application Support', 'otp-bridge');
  const calls = [];
  const autostart = createAutostart({
    platform: 'darwin', env: {}, home, configDir, appRoot: APP_ROOT, uid: 501, nodePath: '/usr/local/bin/node',
    exec: (command, args) => { calls.push([command, ...args]); },
  });
  const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const status = autostart.enable();
  assert.deepEqual(status, { supported: true, enabled: true, location: plist });
  assert.deepEqual(calls, [
    ['launchctl', 'bootout', `gui/501/${LABEL}`],
    ['launchctl', 'bootstrap', 'gui/501', plist],
  ]);
  const text = fs.readFileSync(plist, 'utf8');
  assert.ok(text.includes('<string>/usr/local/bin/node</string>'));
  assert.ok(text.includes(path.join(configDir, 'app', 'companion', 'cli.js')));

  calls.length = 0;
  autostart.disable();
  assert.deepEqual(calls, [['launchctl', 'bootout', `gui/501/${LABEL}`]]);
  assert.ok(!fs.existsSync(plist));
});

test('macOS: loading is retried, then the older command is tried, then the error is reported', (t) => {
  const home = tempDir(t);
  const configDir = path.join(home, 'cfg');
  const fail = (text) => { throw Object.assign(new Error('failed'), { stderr: Buffer.from(text) }); };

  let attempts = 0;
  const flaky = createAutostart({
    platform: 'darwin', env: {}, home, configDir, appRoot: APP_ROOT, uid: 501, retryDelayMs: 1,
    exec: (command, args) => {
      if (args[0] === 'bootstrap') {
        attempts += 1;
        if (attempts < 3) fail('Bootstrap failed: 5: Input/output error');
      }
    },
  });
  assert.equal(flaky.enable().enabled, true);
  assert.equal(attempts, 3);

  const legacyCalls = [];
  const legacy = createAutostart({
    platform: 'darwin', env: {}, home, configDir, appRoot: APP_ROOT, uid: 501, retryDelayMs: 1,
    exec: (command, args) => {
      legacyCalls.push(args[0]);
      if (args[0] === 'bootstrap') fail('Bootstrap failed: 5: Input/output error');
    },
  });
  assert.equal(legacy.enable().enabled, true);
  assert.deepEqual(legacyCalls, ['bootout', 'bootstrap', 'bootstrap', 'bootstrap', 'load']);

  const broken = createAutostart({
    platform: 'darwin', env: {}, home, configDir, appRoot: APP_ROOT, uid: 501, retryDelayMs: 1,
    exec: (command, args) => { if (args[0] !== 'bootout') fail('Operation not permitted'); },
  });
  assert.throws(() => broken.enable(), /macOS did not accept the login item \(Operation not permitted\)/);
  assert.equal(broken.status().enabled, true, 'the agent file is still in place for the next login');
});

test('macOS: when launchd itself started us, the running job is left alone', (t) => {
  const home = tempDir(t);
  const configDir = path.join(home, 'cfg');
  const calls = [];
  const autostart = createAutostart({
    platform: 'darwin', env: { XPC_SERVICE_NAME: LABEL }, home, configDir, appRoot: APP_ROOT, uid: 501,
    exec: (command, args) => { calls.push(args[0]); },
  });
  autostart.enable();
  autostart.disable();
  assert.deepEqual(calls, []);
  assert.equal(autostart.status().enabled, false);
});

test('other systems are reported as unsupported', (t) => {
  const autostart = createAutostart({ platform: 'freebsd', env: {}, home: tempDir(t), configDir: tempDir(t), appRoot: APP_ROOT });
  assert.equal(autostart.supported, false);
  assert.deepEqual(autostart.status(), { supported: false });
  assert.throws(() => autostart.enable(), /not supported/);
});

test('a broken download is reported instead of half-installed', (t) => {
  const home = tempDir(t);
  const emptyRoot = tempDir(t);
  const autostart = createAutostart({ platform: 'linux', env: {}, home, configDir: path.join(home, 'cfg'), appRoot: emptyRoot });
  assert.throws(() => autostart.enable(), /Cannot find "companion"/);
  assert.equal(autostart.status().enabled, false);
});

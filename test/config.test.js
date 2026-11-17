'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultConfigDir, loadConfig, saveConfig, newToken, isValidToken, isValidPort, DEFAULT_PORT } = require('../companion/lib/config');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-bridge-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('settings folder follows each system\'s convention', () => {
  assert.equal(defaultConfigDir({}, 'darwin', '/Users/hadi'), path.join('/Users/hadi', 'Library', 'Application Support', 'otp-bridge'));
  assert.equal(defaultConfigDir({ APPDATA: 'C:\\Users\\hadi\\AppData\\Roaming' }, 'win32', 'C:\\Users\\hadi'), path.join('C:\\Users\\hadi\\AppData\\Roaming', 'otp-bridge'));
  assert.equal(defaultConfigDir({}, 'win32', '/home/h'), path.join('/home/h', 'AppData', 'Roaming', 'otp-bridge'));
  assert.equal(defaultConfigDir({}, 'linux', '/home/hadi'), path.join('/home/hadi', '.config', 'otp-bridge'));
  assert.equal(defaultConfigDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/hadi'), path.join('/cfg', 'otp-bridge'));
  assert.equal(defaultConfigDir({ OTP_BRIDGE_HOME: '/custom/place' }, 'darwin', '/Users/hadi'), path.resolve('/custom/place'));
});

test('tokens are long, random and URL-safe', () => {
  const tokens = new Set(Array.from({ length: 200 }, newToken));
  assert.equal(tokens.size, 200);
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(isValidToken(token), true);
    assert.equal(encodeURIComponent(token), token);
  }
  assert.equal(isValidToken('short'), false);
  assert.equal(isValidToken('has space in it has space in it'), false);
  assert.equal(isValidToken(null), false);
});

test('ports', () => {
  assert.equal(isValidPort(4812), true);
  assert.equal(isValidPort(80), false);
  assert.equal(isValidPort(70000), false);
  assert.equal(isValidPort(4812.5), false);
  assert.equal(isValidPort('4812'), false);
});

test('first run creates a private config file; later runs read it back', (t) => {
  const dir = path.join(tempDir(t), 'nested', 'otp-bridge');
  const first = loadConfig(dir);
  assert.equal(first.created, true);
  assert.equal(first.config.port, DEFAULT_PORT);
  assert.equal(first.config.clipboard, false);
  assert.notEqual(first.config.localToken, first.config.phoneToken);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }

  const second = loadConfig(dir);
  assert.equal(second.created, false);
  assert.equal(second.config.localToken, first.config.localToken);
  assert.equal(second.config.phoneToken, first.config.phoneToken);
});

test('saved changes survive, unknown fields are kept, bad values are repaired', (t) => {
  const dir = tempDir(t);
  const { config } = loadConfig(dir);
  config.clipboard = true;
  config.port = 5123;
  config.phone = { setupAt: '2026-01-01T00:00:00.000Z', host: '192.168.1.20:5123' };
  saveConfig(dir, config);
  const again = loadConfig(dir).config;
  assert.equal(again.clipboard, true);
  assert.equal(again.port, 5123);
  assert.deepEqual(again.phone, config.phone);
  assert.deepEqual(fs.readdirSync(dir), ['config.json'], 'no temporary files left behind');

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...config, port: 'nope', clipboard: 'yes' }));
  const repaired = loadConfig(dir).config;
  assert.equal(repaired.port, DEFAULT_PORT);
  assert.equal(repaired.clipboard, false);
  assert.equal(repaired.localToken, config.localToken);
});

test('a damaged config file is set aside and replaced', (t) => {
  const dir = tempDir(t);
  loadConfig(dir);
  for (const junk of ['{not json', '[]', 'null', JSON.stringify({ localToken: 'x', phoneToken: 'y' })]) {
    fs.writeFileSync(path.join(dir, 'config.json'), junk);
    const fresh = loadConfig(dir);
    assert.equal(fresh.created, true);
    assert.equal(isValidToken(fresh.config.localToken), true);
  }
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('config.json.damaged-')));
});

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 4812;
const CONFIG_FILE = 'config.json';

/** Where settings live: the usual per-user application data folder. */
function defaultConfigDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.OTP_BRIDGE_HOME) return path.resolve(env.OTP_BRIDGE_HOME);
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'otp-bridge');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'otp-bridge');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'otp-bridge');
}

/** 144 random bits, URL-safe. */
function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function isValidToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(value);
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function freshConfig() {
  return {
    version: 1,
    port: DEFAULT_PORT,
    // Lets this computer's browser (dashboard and extension) talk to the companion.
    localToken: newToken(),
    // Part of the address the phone sends messages to.
    phoneToken: newToken(),
    // Copy every new code to the clipboard as well.
    clipboard: false,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Reads the config, creating it on first run. A damaged file is replaced
 * (after being set aside) rather than crashing the app.
 * @returns {{config: object, created: boolean, file: string}}
 */
function loadConfig(dir) {
  const file = path.join(dir, CONFIG_FILE);
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && isValidToken(parsed.localToken) && isValidToken(parsed.phoneToken)) {
        const config = { ...freshConfig(), ...parsed };
        if (!isValidPort(config.port)) config.port = DEFAULT_PORT;
        config.clipboard = config.clipboard === true;
        return { config, created: false, file };
      }
    } catch {
      // fall through to "damaged"
    }
    try {
      fs.renameSync(file, `${file}.damaged-${Date.now()}`);
    } catch {
      // nothing more we can do; it gets overwritten below
    }
  }

  const config = freshConfig();
  saveConfig(dir, config);
  return { config, created: true, file };
}

/** Atomic write, readable by the current user only. */
function saveConfig(dir, config) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, CONFIG_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // not supported on every file system (e.g. Windows); the folder is per-user anyway
  }
  return file;
}

module.exports = {
  DEFAULT_PORT,
  defaultConfigDir,
  newToken,
  isValidToken,
  isValidPort,
  loadConfig,
  saveConfig,
};

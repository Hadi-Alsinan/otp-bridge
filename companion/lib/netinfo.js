'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const { execFile } = require('node:child_process');

// Adapters that never lead to a phone on the same Wi-Fi.
const VIRTUAL_ADAPTER = /^(?:lo\d*|docker\d*|br-|veth|virbr|vmnet|vboxnet|utun\d*|awdl\d*|llw\d*|anpi\d*|ap\d+|gif\d*|stf\d*|bridge\d*|tun\d*|tap\d*|zt|wg\d*)|vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Bluetooth|Teredo|isatap/i;

function isLoopbackAddress(address) {
  if (!address) return false;
  const a = address.replace(/^::ffff:/i, '');
  return a === '::1' || a.startsWith('127.');
}

function classifyIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 192 && b === 168) return 'home';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'vpn';   // CGNAT range, used by Tailscale
  return 'public';
}

const RANK = { home: 0, private: 1, vpn: 2, public: 3, 'link-local': 4, loopback: 5 };

/**
 * IPv4 addresses a phone could use to reach this computer, best guess first.
 * @param {string|null} primary  The address used for the default route, if known.
 */
function listLanAddresses(primary = null, interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      const family = typeof addr.family === 'string' ? addr.family : `IPv${addr.family}`;
      if (family !== 'IPv4' || addr.internal) continue;
      const kind = classifyIPv4(addr.address);
      if (kind === 'loopback') continue;
      found.push({
        address: addr.address,
        interface: name,
        kind,
        virtual: VIRTUAL_ADAPTER.test(name),
        primary: addr.address === primary,
      });
    }
  }
  found.sort((x, y) => (
    (Number(y.primary) - Number(x.primary))
    || (Number(x.virtual) - Number(y.virtual))
    || (RANK[x.kind] - RANK[y.kind])
    || x.interface.localeCompare(y.interface)
  ));
  return found;
}

/**
 * The local address the operating system would use to reach the internet.
 * Connecting a UDP socket sends nothing; it only makes the OS pick a route.
 */
function detectPrimaryAddress(timeoutMs = 800) {
  return new Promise((resolve) => {
    let done = false;
    let socket;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { socket?.close(); } catch { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    try {
      socket = dgram.createSocket('udp4');
      socket.on('error', () => { clearTimeout(timer); finish(null); });
      socket.connect(53, '1.1.1.1', () => {
        clearTimeout(timer);
        try {
          const { address } = socket.address();
          finish(address && address !== '0.0.0.0' ? address : null);
        } catch {
          finish(null);
        }
      });
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

function sanitizeHostLabel(name) {
  const label = String(name || '').trim().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return label || null;
}

/**
 * The name other devices on the network can use instead of an IP address
 * ("study-pc.local"). Unlike the IP it survives the router handing out
 * a new address. Not every network resolves it, so callers must test it.
 */
function detectLocalHostname(platform = process.platform, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const fallback = () => {
      const label = sanitizeHostLabel(os.hostname());
      resolve(label ? `${label}.local` : null);
    };
    if (platform !== 'darwin') {
      fallback();
      return;
    }
    // macOS: the Bonjour name can differ from the DNS host name.
    execFile('scutil', ['--get', 'LocalHostName'], { timeout: timeoutMs }, (err, stdout) => {
      const label = err ? null : sanitizeHostLabel(stdout);
      if (label) resolve(`${label}.local`);
      else fallback();
    });
  });
}

function computerName() {
  return String(os.hostname() || 'this computer').replace(/\.local$/i, '');
}

module.exports = {
  isLoopbackAddress,
  classifyIPv4,
  listLanAddresses,
  detectPrimaryAddress,
  detectLocalHostname,
  sanitizeHostLabel,
  computerName,
};

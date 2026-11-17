'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const netinfo = require('../companion/lib/netinfo');

test('loopback detection', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(netinfo.isLoopbackAddress(a), true, a);
  for (const a of ['192.168.1.5', '::ffff:192.168.1.5', '10.0.0.1', 'fe80::1', '', undefined, null]) assert.equal(netinfo.isLoopbackAddress(a), false, String(a));
});

test('address kinds', () => {
  assert.equal(netinfo.classifyIPv4('192.168.1.20'), 'home');
  assert.equal(netinfo.classifyIPv4('10.1.2.3'), 'private');
  assert.equal(netinfo.classifyIPv4('172.16.0.9'), 'private');
  assert.equal(netinfo.classifyIPv4('172.32.0.9'), 'public');
  assert.equal(netinfo.classifyIPv4('100.101.102.103'), 'vpn');
  assert.equal(netinfo.classifyIPv4('169.254.10.10'), 'link-local');
  assert.equal(netinfo.classifyIPv4('127.0.0.1'), 'loopback');
  assert.equal(netinfo.classifyIPv4('8.8.8.8'), 'public');
});

test('the Wi-Fi address comes first, virtual adapters last', () => {
  const interfaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'vEthernet (WSL)': [{ address: '172.28.0.1', family: 'IPv4', internal: false }],
    utun3: [{ address: '100.64.1.2', family: 'IPv4', internal: false }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.23', family: 'IPv4', internal: false },
    ],
    en5: [{ address: '10.0.0.7', family: 4, internal: false }],
    bridge100: [{ address: '192.168.64.1', family: 'IPv4', internal: false }],
  };
  const withPrimary = netinfo.listLanAddresses('10.0.0.7', interfaces);
  assert.deepEqual(withPrimary.map((a) => a.address), ['10.0.0.7', '192.168.1.23', '192.168.64.1', '172.28.0.1', '100.64.1.2']);
  assert.equal(withPrimary[0].primary, true);
  assert.deepEqual(withPrimary.filter((a) => a.virtual).map((a) => a.interface), ['bridge100', 'vEthernet (WSL)', 'utun3']);

  const withoutPrimary = netinfo.listLanAddresses(null, interfaces);
  assert.equal(withoutPrimary[0].address, '192.168.1.23');
  assert.deepEqual(netinfo.listLanAddresses(null, {}), []);
});

test('host names become safe .local names', async () => {
  assert.equal(netinfo.sanitizeHostLabel('Hadis-MacBook-Pro.local'), 'hadis-macbook-pro');
  assert.equal(netinfo.sanitizeHostLabel('DESKTOP-AB12CD'), 'desktop-ab12cd');
  assert.equal(netinfo.sanitizeHostLabel('  Hadi\'s PC  '), 'hadi-s-pc');
  assert.equal(netinfo.sanitizeHostLabel(''), null);
  assert.equal(netinfo.sanitizeHostLabel('...'), null);
  const name = await netinfo.detectLocalHostname('linux');
  assert.ok(name === null || /^[a-z0-9-]+\.local$/.test(name), String(name));
});

test('the primary address is one of this machine\'s addresses, or unknown', async () => {
  const primary = await netinfo.detectPrimaryAddress(500);
  if (primary !== null) {
    assert.match(primary, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(netinfo.listLanAddresses(primary).some((a) => a.address === primary && a.primary));
  }
});

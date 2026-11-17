'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const { parseArgs, UserError } = require('../companion/lib/main');

const CLI = path.resolve(__dirname, '..', 'companion', 'cli.js');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otp-bridge-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function cli(home, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, OTP_BRIDGE_HOME: home }, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

/** Starts the companion and resolves once it reports that it is running. */
function startCompanion(t, home, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'start', '--no-open', '--local-only', ...args], {
      env: { ...process.env, OTP_BRIDGE_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const exited = new Promise((done) => child.on('exit', (code) => done(code)));
    t.after(() => { child.kill(); });
    const timer = setTimeout(() => reject(new Error(`did not start:\n${output}`)), 15000);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes('is running.') && output.includes('Press Ctrl+C')) {
        clearTimeout(timer);
        resolve({ child, exited, output: () => output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`exited with ${code}:\n${output}`), { output, code }));
    });
  });
}

test('arguments', () => {
  assert.deepEqual(parseArgs([]), { words: [] });
  assert.deepEqual(parseArgs(['start', '--port', '5000', '--no-open']), { words: ['start'], port: 5000, open: false });
  assert.deepEqual(parseArgs(['--port=5001', '--local-only']), { words: [], port: 5001, localOnly: true });
  assert.deepEqual(parseArgs(['autostart', 'on', '--visible']), { words: ['autostart', 'on'], visible: true });
  assert.deepEqual(parseArgs(['test', 'Your', 'code', 'is', '1234']).words, ['test', 'Your', 'code', 'is', '1234']);
  assert.equal(parseArgs(['--config-dir', '/tmp/x']).configDir, '/tmp/x');
  assert.equal(parseArgs(['--config-dir=/tmp/y']).configDir, '/tmp/y');
  assert.throws(() => parseArgs(['--port']), UserError);
  assert.throws(() => parseArgs(['--port', 'abc']), UserError);
  assert.throws(() => parseArgs(['--port', '80']), UserError);
  assert.throws(() => parseArgs(['--frobnicate']), UserError);
});

test('help, version and mistakes', async (t) => {
  const home = tempHome(t);
  const help = await cli(home, ['help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /autostart on\|off/);
  assert.equal((await cli(home, ['--help'])).stdout, help.stdout);
  assert.equal((await cli(home, ['version'])).stdout.trim(), require('../package.json').version);

  const unknown = await cli(home, ['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command: frobnicate/);
  const badOption = await cli(home, ['--nope']);
  assert.equal(badOption.code, 2);
  assert.ok(!fs.existsSync(path.join(home, 'config.json')), 'mistakes do not create settings');
});

test('commands that need a running companion say so', async (t) => {
  const home = tempHome(t);
  await cli(home, ['autostart', 'status']);          // creates the settings
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...config, port: await freePort() }));
  for (const command of [['open', '--no-open'], ['test']]) {
    const result = await cli(home, command);
    assert.equal(result.code, 1, command.join(' '));
    assert.match(result.stderr, /OTP Bridge is not running/);
  }
});

test('start, status, test, a second start, stop', async (t) => {
  const home = tempHome(t);
  const port = await freePort();
  const running = await startCompanion(t, home, ['--port', String(port)]);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(config.port, port);
  assert.equal(config.portConfirmed, true);
  assert.ok(running.output().includes(`http://127.0.0.1:${port}/?k=${config.localToken}`));
  assert.ok(running.output().includes('--local-only'));

  const status = await cli(home, ['status']);
  assert.equal(status.code, 0);
  assert.match(status.stdout, new RegExp(`is running on port ${port}`));
  assert.match(status.stdout, /Phone:\s+not set up yet/);

  const sent = await cli(home, ['test']);
  assert.match(sent.stdout, /Test code \d{6} is now waiting/);
  const custom = await cli(home, ['test', 'رمز', 'التحقق:', '4829']);
  assert.match(custom.stdout, /Test code 4829/);
  const none = await cli(home, ['test', 'hello', 'world']);
  assert.match(none.stdout, /no code was found/);

  const again = await cli(home, ['start', '--no-open']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already running/);

  const open = await cli(home, ['open', '--no-open']);
  assert.equal(open.stdout.trim(), `http://127.0.0.1:${port}/?k=${config.localToken}`);

  const reset = await cli(home, ['reset-phone']);
  assert.equal(reset.code, 0);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).phoneToken, config.phoneToken);

  const stop = await cli(home, ['stop']);
  assert.match(stop.stdout, /was stopped/);
  assert.equal(await running.exited, 0);
  assert.match(running.output(), /Stopped on request/);

  const after = await cli(home, ['status']);
  assert.equal(after.code, 1);
  assert.match(after.stdout, /not running/);
  assert.match((await cli(home, ['stop'])).stdout, /not running/);
  const openAfter = await cli(home, ['open', '--no-open']);
  assert.equal(openAfter.code, 1);
  assert.match(openAfter.stderr, /not running/);
});

test('reset-phone works while stopped too', async (t) => {
  const home = tempHome(t);
  await cli(home, ['autostart', 'status']);          // creates the settings
  const before = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  const port = await freePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...before, port }));
  const reset = await cli(home, ['reset-phone']);
  assert.equal(reset.code, 0);
  const after = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.notEqual(after.phoneToken, before.phoneToken);
  assert.equal(after.localToken, before.localToken);
});

test('a busy port: the first run moves on, a settled port does not', async (t) => {
  const home = tempHome(t);
  const port = await freePort();
  const squatter = http.createServer((req, res) => res.end('someone else'));
  await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));
  t.after(() => squatter.close());

  // First run: the port is not part of any phone address yet, so the next free one is taken.
  fs.mkdirSync(home, { recursive: true });
  await cli(home, ['autostart', 'status']);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...config, port }));
  const running = await startCompanion(t, home);
  const moved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.ok(moved.port > port && moved.port <= port + 20, `moved to ${moved.port}`);
  assert.equal(moved.portConfirmed, true);
  await cli(home, ['stop']);
  await running.exited;

  // Later: the port is settled. If it is taken, say so instead of silently moving.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...moved, port }));
  const refused = await startCompanion(t, home).then(() => null, (err) => err);
  assert.ok(refused, 'must not start');
  assert.equal(refused.code, 1);
  assert.match(refused.output, new RegExp(`Port ${port} is being used by another program`));
});

test('an outdated Node.js gets a clear message', async () => {
  const source = fs.readFileSync(CLI, 'utf8');
  assert.ok(!/=>|\?\?|\?\.|`|\bconst\b|\blet\b/.test(source), 'cli.js itself must parse on very old Node.js');
  assert.match(source, /needs Node\.js 18 or newer/);
});

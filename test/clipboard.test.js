'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createClipboard, clipboardCommands } = require('../companion/lib/clipboard');

/** A stand-in for child_process.spawn. `behaviour` decides how each command ends. */
function fakeSpawn(behaviour, calls) {
  return (command, args, options) => {
    const child = new EventEmitter();
    const written = [];
    child.stdin = new EventEmitter();
    child.stdin.end = (text) => {
      written.push(text);
      const outcome = behaviour(command);
      if (outcome === 'hang') return;
      setImmediate(() => {
        if (outcome === 'missing') child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
        else child.emit('close', outcome === 'ok' ? 0 : 1);
      });
    };
    child.kill = () => { child.killed = true; };
    calls.push({ command, args, options, written, child });
    return child;
  };
}

test('each system has its own clipboard tool', () => {
  assert.deepEqual(clipboardCommands('darwin', {}), [['pbcopy', []]]);
  assert.deepEqual(clipboardCommands('win32', {}), [['clip', []]]);
  assert.deepEqual(clipboardCommands('linux', {}), []);
  assert.deepEqual(clipboardCommands('linux', { DISPLAY: ':0' }).map((c) => c[0]), ['xclip', 'xsel']);
  assert.deepEqual(clipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }).map((c) => c[0]), ['wl-copy', 'xclip', 'xsel']);
});

test('copy sends the code to the tool', async () => {
  const calls = [];
  const clipboard = createClipboard({ platform: 'darwin', env: {}, spawn: fakeSpawn(() => 'ok', calls) });
  assert.equal(clipboard.supported, true);
  assert.equal(await clipboard.copy('482913'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pbcopy');
  assert.deepEqual(calls[0].written, ['482913']);
  assert.equal(calls[0].options.windowsHide, true);
});

test('a missing tool falls through to the next one', async () => {
  const calls = [];
  const clipboard = createClipboard({
    platform: 'linux',
    env: { DISPLAY: ':0' },
    spawn: fakeSpawn((command) => (command === 'xclip' ? 'missing' : 'ok'), calls),
  });
  assert.equal(await clipboard.copy('1234'), true);
  assert.deepEqual(calls.map((c) => c.command), ['xclip', 'xsel']);
});

test('failure and hanging tools are reported, not thrown', async () => {
  const failing = createClipboard({ platform: 'win32', env: {}, spawn: fakeSpawn(() => 'fail', []) });
  assert.equal(await failing.copy('1234'), false);

  const calls = [];
  const hanging = createClipboard({ platform: 'win32', env: {}, spawn: fakeSpawn(() => 'hang', calls), timeoutMs: 30 });
  assert.equal(await hanging.copy('1234'), false);
  assert.equal(calls[0].child.killed, true);

  const throwing = createClipboard({ platform: 'darwin', env: {}, spawn: () => { throw new Error('no'); } });
  assert.equal(await throwing.copy('1234'), false);
});

test('no tool means not supported', async () => {
  const clipboard = createClipboard({ platform: 'linux', env: {} });
  assert.equal(clipboard.supported, false);
  assert.equal(await clipboard.copy('1234'), false);
});

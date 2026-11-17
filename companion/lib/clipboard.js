'use strict';

const { spawn } = require('node:child_process');

/** The system tools that put text on the clipboard, in the order to try them. */
function clipboardCommands(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return [['pbcopy', []]];
  if (platform === 'win32') return [['clip', []]];
  const commands = [];
  if (env.WAYLAND_DISPLAY) commands.push(['wl-copy', []]);
  if (env.DISPLAY) {
    commands.push(['xclip', ['-selection', 'clipboard']]);
    commands.push(['xsel', ['--clipboard', '--input']]);
  }
  return commands;
}

function run(spawnFn, command, args, text, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child;
    const timer = setTimeout(() => {
      try { child?.kill(); } catch { /* already gone */ }
      finish(false);
    }, timeoutMs);
    try {
      child = spawnFn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      finish(false);
      return;
    }
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    child.stdin.on('error', () => finish(false));
    child.stdin.end(text);
  });
}

/**
 * @returns {{supported: boolean, copy(text: string): Promise<boolean>}}
 */
function createClipboard(options = {}) {
  const commands = clipboardCommands(options.platform, options.env);
  const spawnFn = options.spawn || spawn;
  const timeoutMs = options.timeoutMs ?? 3000;
  return {
    supported: commands.length > 0,
    async copy(text) {
      for (const [command, args] of commands) {
        if (await run(spawnFn, command, args, String(text), timeoutMs)) return true;
      }
      return false;
    },
  };
}

module.exports = { createClipboard, clipboardCommands };

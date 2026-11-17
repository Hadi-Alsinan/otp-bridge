#!/usr/bin/env node
/* Kept in old-fashioned syntax on purpose: this file must still load on an
   outdated Node.js so it can say what is wrong instead of crashing. */
'use strict';

var major = Number(String(process.versions.node).split('.')[0]);
if (!(major >= 18)) {
  console.error('OTP Bridge needs Node.js 18 or newer. This computer has ' + process.versions.node + '.');
  console.error('Install the current LTS version from https://nodejs.org and try again.');
  process.exit(1);
}

require('./lib/main').run(process.argv.slice(2)).then(function (code) {
  if (typeof code === 'number') process.exitCode = code;
}, function (err) {
  console.error(err && err.userMessage ? err.userMessage : err);
  process.exitCode = 1;
});

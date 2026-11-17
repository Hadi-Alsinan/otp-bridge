# Contributing to OTP Bridge

Thank you for wanting to help. This page says what is most useful, how to get the project running,
and what a change needs before it can be merged.

## The most useful things you can do

1. **Report a code that was not recognised.** If a text with a verification code arrived on the
   dashboard but no code was found, open an issue with the "A code was not recognised" form. Change
   the digits and remove names, amounts and account numbers first. Every such message becomes a
   test, so the same wording works for everyone afterwards.
2. **Try a pairing nobody has tried.** The table under "What has been tested" in the
   [README](README.md#what-has-been-tested) lists what has only been checked by automated tests.
   Firefox, real Windows PCs and Android phones are the biggest gaps. A short report of what worked
   and what did not is a real contribution.
3. **Fix a bug or build something.** For anything larger than a small fix, open an issue first and
   say what you plan to do. It saves you from building something that cannot be merged.

## Getting it running

You need [Node.js](https://nodejs.org) 18 or newer. Nothing has to be installed for the companion,
the extension or the unit tests.

```sh
git clone https://github.com/Hadi-Alsinan/otp-bridge.git
cd otp-bridge
node companion/cli.js      # starts the companion and opens the dashboard
```

The README walks through adding the extension and connecting a phone. To try things without a
phone, `node companion/cli.js test` sends a made-up code to the running companion, and the
dashboard has a practice page.

## Tests

```sh
npm test                            # unit tests, no install needed
npm install                         # only for the browser tests
npx playwright install chromium
npm run test:e2e                    # browser tests with the real extension
```

Every push and pull request runs the unit tests on Windows, macOS and Linux with Node.js 18, 20
and 22, and the browser tests on all three systems. A pull request has to pass them.

## Where things are

```
companion/cli.js          entry point
companion/lib/            server, code parser, in-memory store, settings, start at login
companion/web/            dashboard, phone setup page, practice page
extension/                the browser extension (Manifest V3, no build step)
scripts/                  builds the icons and the iPhone shortcut
test/                     unit tests
e2e/                      browser tests with Playwright
```

## What a change has to keep

These are the promises the project makes to the people who use it. A change that breaks one of
them needs a discussion in an issue first.

- **No runtime dependencies.** The companion and the extension run with Node.js and a browser,
  nothing else, and there is no build step. Packages are fine in tests and scripts.
- **Codes stay on the user's own devices.** Nothing is sent to the internet. Codes are kept in
  memory for ten minutes and never written to disk. Messages without a code are dropped on arrival.
- **A website sees nothing until the user clicks.** See "Privacy and security" in the README for
  the rules the extension follows.
- **Plain words.** The dashboard and the phone page are read by people who are not technical. Say
  what to tap and what will happen, and avoid jargon.

## What a pull request needs

- **Tests for the change.** A fix comes with a test that fails without it.
- **A note on how you tested it,** including what you could not test. "Unit tests only, not tried
  on a phone" is a fine answer; it is what lets the README stay honest about what has been checked.
- **The README updated** if the change alters what a user does or sees.
- **One thing per pull request.** Small pull requests get reviewed quickly.

## Teaching the parser a new message

The parser is `companion/lib/otp-parser.js`, and its samples are the `CASES` list at the top of
`test/otp-parser.test.js`. Each entry is a message and the code that must be found in it, or `null`
for a message that must be ignored.

1. Add the message to `CASES`, with changed digits and no personal details.
2. Run `node --test test/otp-parser.test.js` and watch it fail.
3. Change the parser until it passes, without breaking the messages that must be ignored. Those
   matter as much: a delivery notice or a bank balance must never be offered as a code.

One of the tests there also checks that the iPhone shortcut would pass the message on, because the
shortcut looks at each text on the phone before sending it.

## The iPhone shortcut

`scripts/make-shortcut.js` builds the shortcut that the phone page offers. iPhones only accept
shortcut files signed by Apple, and the signing tool exists only on a Mac that is signed in to
iCloud:

```sh
npm run shortcut
```

If you change the script on Windows or Linux, say so in the pull request and a maintainer will
sign the file. The signature expires after about a year; the note at the top of the script has the
details.

## Security problems

Please do not open a public issue for a security problem. [SECURITY.md](SECURITY.md) says how to
report one privately.

## Licence

OTP Bridge is released under the [MIT licence](LICENSE). By contributing you agree that your
contribution is released under the same licence.

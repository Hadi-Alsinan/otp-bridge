# Security

OTP Bridge handles verification codes. If you find a way to read, guess or redirect a code that
the design is meant to prevent, please report it.

## Reporting a problem

Please do not open a public issue. Report it privately through GitHub:

1. Open the [Security tab](https://github.com/Hadi-Alsinan/otp-bridge/security) of this repository.
2. Click **Report a vulnerability**.

Say what you found, how to reproduce it, which version or commit you used, and which operating
system, browser and phone were involved. Never include a real code, your private dashboard link or
your phone address.

Fixes are made on the latest version only.

## What counts

The design makes these promises. Breaking any of them is a security problem:

- A website cannot read or guess a code. It learns the code only when the user clicks the
  suggestion, the toolbar button or the right-click menu.
- A code that names its website (`@example.com #123456`) is only offered on that website.
- Only the user's own computer can read codes. Other devices on the network can reach the phone
  address, and only to drop a message in.
- The dashboard and the extension's connection cannot be used without the private token, and not
  from another device.
- Codes are kept in memory only, for ten minutes, and are not written to disk or sent anywhere
  except to the user's own browser.

## Known limits

These are part of the design and are described under "Privacy and security" in the
[README](README.md#privacy-and-security). They are not new findings:

- The phone talks to the computer in plain HTTP, so someone who can listen in on the local network
  can see a text as it passes.
- Anyone on the network who knows the phone address can send fake messages to the computer. They
  cannot read anything.
- Like every autofill that draws inside a web page, the suggestion could in theory be covered by a
  malicious page to trick the user into clicking it.

If you have found a practical way to turn one of these into something worse, that is worth
reporting.

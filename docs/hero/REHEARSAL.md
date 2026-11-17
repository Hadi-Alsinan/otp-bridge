# Rehearsal: OTP Bridge hero

Gold: `device-pair`.

- Kept: the 640 by 400 stage on the well, the 32px gutter, the browser window pinned top-left at
  496 by 460 and running off the bottom, the 236px phone straddling the window's right edge from
  84px down, the hero and satellite shadows, the lock screen with one notification.
- Changed: the dashboard became a website's sign-in step; the scene gained a script, a cursor and
  OTP Bridge's card; the narrow layout was recomposed (the gold's narrow window shows taller than
  wide, which the framing rules forbid).

Beats, loop 8.7s:

1. The text arrives on the phone (0.5s).
2. Its code is on offer under the code box (2.5s).
3. The hand goes up to the card's icon and clicks (about 4.2s).
4. Payoff: the code is in the box and the card turns into its "Filled in" note (about 4.6s). The
   hand leaves as the note lands. The note holds for about 2s, then leaves by itself, as it does in
   the product.
5. The code and the text message leave together; the page stays. The next text arrives within a
   second.

Poster: the text has arrived and the code is on offer. No cursor.

## Captured

- Widths: the wide design (640 stage) and a 390px viewport (the 358 by 548 narrow design).
- Looks: light and dark.
- States: `--states` at both widths.
- Reduced motion: the poster, wide light, wide dark and narrow.
- Close sampling: the click and the card's change at 70ms; the cursor's approach slowed four times.
- The exported files: the README's `<picture>` on a page laid out like GitHub's, in a white and a
  `#0d1117` version, photographed at five moments of one loop in each.

## Film

`film.mjs --gate` ended `rehearsal passed` on the wide loop, the dark loop, the narrow loop,
`--states` at both widths, and the wide, dark and narrow posters. Typecheck and the class-clash
check were clean.

| Line | Frame | Outcome |
| --- | --- | --- |
| `jump: ss-field__chars "4" width +10.4px in one frame` | the 4.5s frame of the wide loop | Stands. The code is filled quickly behind the caret, the way an autofill fills. Both reviewers looked at the click frames and judged it right |
| `small text: "now" renders at 8.1px` (390 only) | the narrow poster | Stands. It is the banner's own proportion on a 290px phone; the gold prints the same line at 6.6px. A wider phone fails framing: at the column's width its edge sits on the window's, and wider still it leaves a sliver |
| coverage `inconclusive` on some runs | sampling gaps of 27 to 67ms on this Mac | The wide loop was repeated until one capture was complete. The other runs were not |

Lines fixed along the way: a divider along the card's bottom edge, the close mark's inset, a tick on
a half pixel, text landing on a transform, a window taller than wide at 390, a card row with an
uneven inset, a phone leaving a 16px sliver at 390.

## Review

Two fresh-eye reviews. The second saw the reworked scene and the product's own source.

First review:

1. Narrow: the phone floated centered with bare corners. Fixed: a larger phone.
2. Nothing in the notification says "text message". Open. See Unresolved.
3. The website's Verify button was the heaviest mark, in the product's indigo. Fixed: the website
   is neutral ink and the button is gone, so the only color in the window is the card's.
4. The seam blanked the whole page. Fixed: the page stays; only the code and the text leave.
5. Verify pressed itself. Fixed: the button and that beat are gone. The payoff is the product's own
   "Filled in" note.
6. The hand covered "now", crossed the close mark and rested on a rule. Fixed: it clicks the card's
   icon and rests on empty page.
7. The gate's jump on the digits. Stands, see Film.
8. The card's edges lined up with nothing. Fixed: the code box is exactly as wide as the card.
9. "The card's icon is an invented mark." Declined: it is OTP Bridge's real glyph and tile, as
   `extension/content.js` draws them. That reviewer could not see the project; the second one
   could, and confirmed the card matches.
10. Title and subtitle in the card are 8px of ink apart. Declined: those are the extension's real
    sizes and line height.
11. The code was set three ways. Fixed: the box shows `482913` as the text message does.
12. "now" at 6.6px at 390. Improved by the larger phone.
13. The address `northwind.example` reads as a placeholder. Kept the reserved domain on purpose and
    gave it a path.

Second review:

1. A tinted plate behind the devices on a README page. Kept on purpose. GitHub has several dark
   themes with different page colors, and a GIF cannot carry a soft shadow over a page color it
   does not know, so the scene brings its own ground.
2. Narrow: the phone's edge sat on the window's edge. Fixed: the phone is 18px inside it.
3. The notification's sender is a gray disc. Open. See Unresolved.
4. Two dashboard-style rows under the form. Fixed: the page ends with a rule and a line of footer
   links.
5. The caret hung in the box for a moment at the reset. Fixed: it leaves with the code.
6. The cursor became an I-beam and vanished for a frame on its way to the card. Fixed: it rests
   below the card's icon, so its way crosses neither the code box nor the close mark.
7. The arrow sat on the note's bottom edge. Fixed: the hand leaves as the note lands.
8. "now" at 9.1px at 390. Stands, see Film.

## Assumptions

- The scene is for the README, so the exported GIF and still are what people see. The live stage is
  not used anywhere yet, and the narrow design is only seen if it is.
- The card says "From your phone", which is what an iPhone's messages produce.
- The card is fixed at 252px, its natural width with these words.

## Unresolved

- The notification shows a gray monogram, which is what iOS shows for a sender with no photo. It
  has no Messages badge, and both reviewers missed one. The kit has no Messages mark, and Apple's
  icon is Apple's artwork, so it was not added.

## Not checked

- The scene was not reviewed a third time, after the fixes to the second review.
- The README on github.com itself, in its light and dark themes and at its real width.
- Playback in a visible browser at real speed. Everything was filmed in headless Chrome.
- Safari and Firefox.
- The dark theme at 390, hover play, a resize between widths, and widths between 390 and 640.
- Every frame of the GIFs. Four of the ten browser photographs were looked at closely.

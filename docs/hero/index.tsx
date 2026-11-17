import { Avatar, Bar, Field, LockScreen, Notification, Phone, Stage, Text, Window, WALLPAPER, type Act } from '../../kit'
import './otp-bridge.css'

// OTP Bridge: a verification code is texted to the phone, and a moment later it
// is waiting under the code box on the computer, where one click fills it in.
//
// A device pair. The website's sign-in step is pinned top-left and runs off the
// bottom; the phone straddles its right edge over empty page, so the code box
// and the card under it stay clear. Narrow, the window keeps a window's shape
// and a larger phone stands centered under the card, well inside the window's
// edge, its text message whole.
//
// The website is drawn in neutral ink, so the one color in the window is the
// product's. The card is OTP Bridge's own: its colors, sizes, glyph and its
// "Filled in" note are the ones the extension draws (extension/content.js).
// The code box is as wide as the card, so the card hangs from it like the
// box's own menu. Real words: the page's heading and its one line, the card,
// and the text message.

type S = {
  /** The text message, on the phone's lock screen */
  note: boolean
  /** OTP Bridge's card, under the code box */
  card: boolean
  /** The card saying the code was filled in, as it does after a click */
  filled: boolean
  code: string
  /** The code fading from the box as the loop resets */
  clearing: boolean
}

const CODE = '482913'

const initial: S = { note: false, card: false, filled: false, code: '', clearing: false }

// The frame most people see: the text has arrived, and its code is on offer
// under the box.
const POSTER: S = { ...initial, note: true, card: true }

// On empty page, on the side the card's icon is on, so the way to the icon
// crosses neither the code box nor the card's close mark and the cursor
// changes once, from arrow to hand, as it reaches the card
const REST = { wide: { x: 84, y: 366 }, compact: { x: 26, y: 270 } }

async function script(a: Act<S>) {
  await a.wait(500)

  // The text arrives on the phone
  await a.set({ note: true })
  a.mark('text')
  await a.wait(2000)

  // A moment later its code is waiting under the box
  await a.set({ card: true })
  a.mark('offer')
  await a.wait(1200)

  // One click fills it in. The row hugs its words, so the hand lands on the
  // card's icon and covers none of them.
  await a.move({ at: 'offer', x: 0.1, y: 0.56 })
  await a.wait(350)
  await a.click()
  await a.type('code', CODE, { interval: 30 })
  await a.set({ filled: true })
  a.mark('filled')
  // The hand leaves as the note lands, so nothing sits on the note
  await a.move('rest')
  await a.wait(2100)

  // The note leaves by itself, as it does in the product
  await a.set({ card: false })
  a.mark('done')
  await a.wait(900)

  // What the story added leaves in one short stagger; the page stays
  await a.set({ note: false })
  await a.wait(70)
  await a.set({ clearing: true })
  await a.wait(280)
  await a.snap({ code: '', clearing: false, filled: false })
  await a.wait(300)
}

export default function OtpBridge() {
  return (
    <Stage
      width={640}
      height={400}
      compact={{ below: 600, width: 358, height: 548 }}
      initial={initial}
      poster={POSTER}
      script={script}
      cursor={{ at: REST }}
      className="ob"
    >
      {(s, rect, layout) => {
        const field = rect('code')
        return (
          <>
            <Window url="northwind.example/sign-in" className="ob-window">
              <div className="ob-page">
                <div className="ob-site">
                  {/* A plain wordmark: a fictional company gets no invented mark */}
                  <span className="ob-wordmark">Northwind</span>
                  <Bar w={44} h={5} tone={2} />
                  <Bar w={36} h={5} tone={2} />
                  <Bar w={50} h={5} tone={2} />
                </div>

                <div className="ob-main">
                  <div className="ob-title">Check your phone</div>
                  <Text className="ob-sub">Enter the 6-digit code we texted you.</Text>

                  <Field
                    className="ob-code"
                    value={s.code}
                    focused
                    data-clearing={s.clearing || undefined}
                    box={{ 'data-target': 'code', 'data-cursor': 'ibeam' }}
                  />

                  <div className="ob-help">
                    <Bar w={172} h={5} tone={2} />
                    <Bar w={116} h={5} tone={2} />
                  </div>

                  {/* The page ends the way a sign-in page does: a rule and a line of footer links */}
                  <div className="ob-foot">
                    <Bar w={46} h={5} tone={2} />
                    <Bar w={58} h={5} tone={2} />
                    <Bar w={38} h={5} tone={2} />
                  </div>
                </div>
              </div>
            </Window>

            {/* The card sits where the extension puts it: 6px under the code
                box, at its left edge, over whatever is below. One card, two
                states: the code on offer, then the note that it was filled in,
                at the smaller size the real note has. */}
            <div className="ob-card" data-show={s.card || undefined} data-filled={s.filled || undefined} style={{ left: field.x, top: field.y + field.height + 6 }}>
              <span className="ob-offer">
                      <span className="ob-offer-rows">
                        {/* A hand only while it is there to click */}
                        <span className="ob-offer-row" data-target="offer" data-cursor={s.card && !s.filled ? 'hand' : undefined}>
                          <span className="ob-offer-icon">
                            <BridgeGlyph />
                          </span>
                          <span className="ob-offer-text">
                            <span className="ob-offer-title">
                              Fill code
                              <span className="ob-offer-code">
                                <span>{CODE.slice(0, 3)}</span>
                                <span>{CODE.slice(3)}</span>
                              </span>
                            </span>
                            <span className="ob-offer-sub">From your phone · just now</span>
                          </span>
                        </span>
                      </span>
                      <span className="ob-offer-close">
                        <span>×</span>
                      </span>
              </span>
              <span className="ob-filled">
                <span>✓ Filled in</span>
              </span>
            </div>

            <Phone width={layout === 'compact' ? 290 : 236} frame="pro" dark wallpaper={WALLPAPER} className="ob-phone">
              <LockScreen size="satellite" stack="top">
                {/* A text from a sender with no photo shows its monogram, as Messages does */}
                <Notification
                  className="ob-note"
                  data-show={s.note || undefined}
                  icon={<Avatar name="Northwind" tone="ios" size={38} />}
                  title="Northwind"
                  body={`Your verification code is ${CODE}.`}
                />
              </LockScreen>
            </Phone>

            <span data-target="rest" style={{ position: 'absolute', left: REST[layout].x, top: REST[layout].y }} />
          </>
        )
      }}
    </Stage>
  )
}

// OTP Bridge's own glyph, as the extension draws it on its card: a speech
// bubble with three dots.
function BridgeGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#fff"
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-3.6 3.1c-.32.28-.82.05-.82-.38V16H6.5A2.5 2.5 0 0 1 4 13.5z"
      />
      {[8.2, 12, 15.8].map((x) => (
        <circle key={x} cx={x} cy="10" r="1.35" fill="#4a4fe0" />
      ))}
    </svg>
  )
}

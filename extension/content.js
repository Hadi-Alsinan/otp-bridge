/*
 * OTP Bridge content script. Runs in every frame of every page.
 *
 *   1. Finds fields that ask for a verification code.
 *   2. While such a field is on screen, asks the background script whether a
 *      code has arrived from the phone.
 *   3. Shows a small suggestion under the field and fills the code in when it
 *      is clicked.
 *
 * The page never gets to see a code before the user picks it: the suggestion
 * lives in a closed shadow root that page scripts cannot look into.
 */
(() => {
  'use strict';

  if (globalThis.__otpBridgeLoaded) return;
  globalThis.__otpBridgeLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.id) return;

  const CANDIDATE_SCORE = 50;   // good enough to offer a code when the field is focused
  const STRONG_SCORE = 70;      // sure enough to offer a code before it is focused
  const RESCAN_MS = 1500;
  const MAX_INPUTS = 300;
  const LONG_POLL_SECONDS = 20;

  // ---------------------------------------------------------------------------
  // Talking to the background script
  // ---------------------------------------------------------------------------

  let orphaned = false;   // the extension was reloaded or removed under us

  async function send(message) {
    if (orphaned) return null;
    try {
      return await api.runtime.sendMessage(message);
    } catch (err) {
      // After the extension is reloaded or removed, this copy of the script is
      // cut off from it for good.
      if (!api.runtime || !api.runtime.id || /context invalidated/i.test(String(err && err.message))) shutDown();
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Pairing: the companion's dashboard hands its token to the extension
  // ---------------------------------------------------------------------------

  const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
  if (window.top === window && location.protocol === 'http:' && LOOPBACK.includes(location.hostname)) {
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.type !== 'otp-bridge:pair-offer' || typeof data.token !== 'string') return;
      send({ type: 'pair-offer', token: data.token }).then((result) => {
        if (!result) return;
        window.postMessage({
          type: 'otp-bridge:pair-result', ok: result.ok === true, reason: result.reason || null, version: result.version || null,
        }, location.origin);
      });
    });
    window.postMessage({ type: 'otp-bridge:extension-ready' }, location.origin);
  }

  // ---------------------------------------------------------------------------
  // Recognising verification-code fields
  // ---------------------------------------------------------------------------

  const TEXT_TYPES = new Set(['text', 'tel', 'number', 'password']);

  const WORD_START = '(?:^|[^a-z0-9])';
  const WORD_END = '(?:$|[^a-z0-9])';
  const words = (list) => new RegExp(`${WORD_START}(?:${list})${WORD_END}`, 'i');

  // Says "this is a verification code" on its own.
  const STRONG_WORDS = new RegExp(`${words(
    'otp|otps|otc|totp|2fa|mfa|tfa|passcode|pass code|one time|onetime|single use|two factor|twofactor|'
    + 'two step|2 step|verification|verify|verif|verifier|verificationcode|security code|securitycode|'
    + 'auth code|authcode|authentication code|authenticator|access code|login code|sign in code|signin code|'
    + 'sms code|smscode|confirmation code|confirm code|activation code|secret code|mtan|tan|'
    + 'challenge data entry|challengedataentry|codigo de verificacion|código de verificación|'
    + 'code de vérification|code de verification|bestätigungscode|doğrulama kodu|код подтверждения',
  ).source}|رمز التحقق|رمز التأكيد|كود التحقق|رمز الأمان|رمز الدخول|كلمة المرور المؤقتة|التحقق|验证码|驗證碼|校验码|认证码|認証コード|確認コード|認証番号|인증번호|인증 번호|인증코드`, 'i');

  // Could be a verification code, could be something else.
  const WEAK_WORDS = new RegExp(`${words('code|codes|pin|token|challenge|código|codigo|codice|kod|kode|код').source}|رمز|كود|コード|코드`, 'i');

  // Never a verification code, whatever else the field says.
  const NEVER_WORDS = new RegExp(
    'zip|postal|postcode|post code|promo|coupon|discount|voucher|gift|referral|invite|captcha|'
    + 'cvv|cvc|cvn|ccv|card ?number|cardnumber|expir|search|quantity|amount|price|tracking|barcode|csrf|'
    + `${WORD_START}(?:csc|qty|sku|(?:country|area|dial|calling|sort|colou?r|hex|qr|bar|product|item|order|`
    + `employee|branch|store|class|course) ?code|(?:api|access|auth|bearer|refresh) ?token|otp bridge ignore)${WORD_END}`, 'i');

  // A field named like this, with no code word next to it, is something else.
  const IDENTITY_WORDS = words(
    'phone|mobile|msisdn|tel|telephone|email|e mail|mail|user|username|userid|user id|login|first|last|'
    + 'full name|fullname|surname|name|address|city|state|province|street|shipping|billing|delivery|locality|'
    + 'landmark|country|year|month|day|date|dob|birth|age|ssn|account|acct|card|company|website|url|message|'
    + 'comment|note|subject|title|swift|iban|routing|tax|vat',
  );
  const PASSWORD_WORDS = words('password|passwd|pwd|pass|passphrase');
  const REPEATED_WORDS = words('email|e mail|mail|password|passwd|pwd|username|user name');
  // In India a "PIN code" is the postal code. In one plain field that is the
  // likelier meaning; in a row of single-digit boxes it is a code to type.
  const POSTAL_PIN_WORDS = /pincode|pin code/i;
  const CODE_WORDS = /otp|one time|onetime|code|pin|رمز|كود/i;

  // Text around a field that says the page is asking for a code.
  const CONTEXT_WORDS = new RegExp(`${words(
    'verification code|security code|one time|otp|passcode|we (?:just |have |ve )?sent|sent (?:you |to )|'
    + 'enter (?:the |your )?(?:\\d |\\d digit )?code|\\d digit code|code (?:sent|we sent|from)|two factor|'
    + '2 step|two step|authentication code|authenticator|text message|sms|'
    + 'código de verificación|codigo de verificacion|code de vérification|bestätigungscode|код подтверждения',
  ).source}|رمز التحقق|أدخل الرمز|ادخل الرمز|الرمز المرسل|كلمة المرور لمرة واحدة|كلمة المرور المؤقتة|رمز التفعيل|验证码|驗證碼|認証コード|確認コード|인증번호`, 'i');

  const AUTOCOMPLETE_OTHER = /^(?:cc-.*|postal-code|tel.*|email|username|current-password|new-password|name|given-name|family-name|additional-name|nickname|honorific-.*|organization.*|street-address|address-.*|country.*|bday.*|sex|url|photo|language|transaction-.*|impp)$/;

  /** "smsOtpCode", "sms_otp-code" -> "sms otp code" */
  function normalizeWords(text, limit = 700) {
    return String(text)
      .slice(0, limit * 2)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./:|[\]()]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .slice(0, limit);
  }

  function isTextInput(el) {
    // `el.type` (not the attribute): browsers treat unknown types as text.
    return el instanceof HTMLInputElement && TEXT_TYPES.has(el.type);
  }

  function isUsable(el) {
    if (!el.isConnected || el.disabled || el.readOnly) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function inViewport(rect) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  /**
   * What the field says about itself. `names` are the short things that name
   * it (attributes and short labels); `all` adds longer label text, which is
   * prose and may mention anything ("the code we sent to your phone").
   */
  function describe(el) {
    const names = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.title,
      el.getAttribute('data-testid'), el.getAttribute('data-test'), el.getAttribute('data-cy'),
      el.getAttribute('data-qa'), typeof el.className === 'string' ? el.className : ''];
    const prose = [];
    const addText = (node) => {
      const text = ((node && node.textContent) || '').trim();
      if (!text) return;
      if (text.length <= 40) names.push(text);
      else prose.push(text.slice(0, 200));
    };
    try {
      for (const label of el.labels || []) addText(label);
    } catch { /* labels can throw on detached nodes */ }
    const root = el.getRootNode();
    for (const attr of ['aria-labelledby', 'aria-describedby']) {
      const ids = el.getAttribute(attr);
      if (!ids || typeof root.getElementById !== 'function') continue;
      for (const id of ids.split(/\s+/).slice(0, 4)) addText(root.getElementById(id));
    }
    const own = normalizeWords(names.filter(Boolean).join(' '));
    return { names: own, all: `${own} ${normalizeWords(prose.join(' '))}` };
  }

  /** The text nearest to the field: its row, group or form. */
  function surroundingText(el) {
    let block = el.parentElement;
    for (let depth = 0; block && block.parentElement && depth < 6; depth += 1) {
      if ((block.textContent || '').trim().length >= 80) break;
      block = block.parentElement;
    }
    return block ? normalizeWords(block.textContent || '', 1500) : '';
  }

  /** No other field to type in, in the same form (or, without a form, on the page). */
  function isOnlyTextField(el) {
    const scope = el.form || el.getRootNode();
    if (!scope || typeof scope.querySelectorAll !== 'function') return false;
    for (const other of scope.querySelectorAll('input, textarea')) {
      if (other === el) continue;
      const typable = other instanceof HTMLTextAreaElement || isTextInput(other)
        || ['email', 'search', 'url'].includes(other.type);
      if (typable && isUsable(other)) return false;
    }
    return true;
  }

  function isNumericField(el) {
    const mode = (el.getAttribute('inputmode') || '').toLowerCase();
    const pattern = el.getAttribute('pattern') || '';
    return el.type === 'tel' || el.type === 'number' || mode === 'numeric' || /\\d|\[0-9\]/.test(pattern);
  }

  /** A box that takes one character of a code that is split over several boxes. */
  function isCodeBox(el) {
    if (!isTextInput(el) || !isUsable(el)) return false;
    if (el.maxLength === 1) return true;
    if (el.maxLength > 2) return false;
    const rect = el.getBoundingClientRect();
    return rect.width <= 72;
  }

  /**
   * The row of single-character boxes that `el` belongs to (4 to 8 of them,
   * side by side), or null.
   */
  function findCodeBoxes(el) {
    if (!isCodeBox(el)) return null;
    let container = el.parentElement;
    for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
      const inputs = Array.from(container.querySelectorAll('input')).filter(isTextInput);
      if (inputs.length > 8) return null;
      if (inputs.length < 4) continue;
      const boxes = inputs.filter(isCodeBox);
      if (boxes.length !== inputs.length || !boxes.includes(el)) return null;
      const rects = boxes.map((box) => box.getBoundingClientRect());
      const tops = rects.map((r) => r.top);
      const sameRow = Math.max(...tops) - Math.min(...tops) < rects[0].height * 0.6;
      const sameSize = rects.every((r) => Math.abs(r.width - rects[0].width) < 6 && Math.abs(r.height - rects[0].height) < 6);
      if (!sameRow || !sameSize) return null;
      return boxes;   // document order is typing order, also in right-to-left layouts
    }
    return null;
  }

  /**
   * Is this a field for a verification code, and how sure are we?
   * @returns {{el: HTMLInputElement, score: number, boxes: HTMLInputElement[]|null}|null}
   */
  function classify(el) {
    if (!isTextInput(el) || el.disabled || el.readOnly) return null;

    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const saysOtp = tokens.includes('one-time-code');
    if (!saysOtp && tokens.some((token) => AUTOCOMPLETE_OTHER.test(token))) return null;

    const text = describe(el);
    if (!saysOtp && NEVER_WORDS.test(text.names)) return null;

    let strong = saysOtp || STRONG_WORDS.test(text.all);
    let weak = !strong && WEAK_WORDS.test(text.all);
    if (strong && !saysOtp && !CODE_WORDS.test(text.all)) {
      // "verifyPassword" and "verify_email" are things to type twice, not codes.
      const repeatedPassword = el.type === 'password' && PASSWORD_WORDS.test(text.names);
      const onlySaysVerify = !STRONG_WORDS.test(text.all.replace(/verif[a-z]*/g, ' '));
      if (repeatedPassword || (onlySaysVerify && REPEATED_WORDS.test(text.names))) strong = false;
    }
    const identity = !strong && !weak && IDENTITY_WORDS.test(text.names);

    // Everything above is cheap. Looking at the layout is not, so do it last.
    if (!isUsable(el)) return null;

    // A row of single-character boxes.
    const boxes = findCodeBoxes(el);
    if (boxes) {
      const group = boxes.map((box) => (box === el ? text : describe(box)));
      if (!saysOtp && group.some((d) => NEVER_WORDS.test(d.names))) return null;
      const everything = group.map((d) => d.all).join(' ');
      let score = boxes.every((box) => box.maxLength === 1) ? 62 : 30;
      if (saysOtp || STRONG_WORDS.test(everything)) score += 30;
      else if (WEAK_WORDS.test(everything)) score += 15;
      if (boxes.some(isNumericField)) score += 8;
      if (score < CANDIDATE_SCORE && CONTEXT_WORDS.test(surroundingText(el))) score += 25;
      return score >= CANDIDATE_SCORE ? { el: boxes[0], score, boxes } : null;
    }

    // Two or three characters is a CVV, a day or a month, never a code.
    if (el.maxLength > 0 && el.maxLength < 4) return null;
    if (!strong && POSTAL_PIN_WORDS.test(text.names)) return null;

    let score = 0;
    if (saysOtp) score += 100;
    else if (strong) score += 60;
    else if (weak) score += 30;
    if (identity) score -= 40;
    if (isNumericField(el)) score += 15;
    if (el.maxLength >= 4 && el.maxLength <= 8) score += 20;
    if (el.type === 'password' && !strong) score -= 15;

    if (score < CANDIDATE_SCORE && !identity) {
      // Halfway there: the words around the field can settle it. Otherwise it
      // has to be the only field to type in on a page that talks about a code.
      const halfway = score >= 25;
      if ((halfway || isOnlyTextField(el)) && CONTEXT_WORDS.test(surroundingText(el))) {
        score = halfway ? score + 25 : CANDIDATE_SCORE + 5;
      }
    }
    return score >= CANDIDATE_SCORE ? { el, score, boxes: null } : null;
  }

  function deepActiveElement() {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let candidates = [];            // result of the last scan
  let codes = [];                 // fresh codes from the phone, newest first
  let rev = 0;
  let clockOffset = 0;            // companion clock minus this page's clock
  let freshMs = 3 * 60 * 1000;
  let polling = false;
  let target = null;              // the code field in play right now (focused, or the obvious one)
  let anchor = null;              // the field the suggestion is attached to
  let activeRow = -1;             // row highlighted with the keyboard
  let escapedField = null;        // field on which Escape hid the suggestion
  let contextTarget = null;       // what was right-clicked last
  let noticeTimer = null;
  let expiryTimer = null;
  let scanTimer = null;
  let scanQueued = false;
  let lastScanAt = 0;
  let newestCodeId = null;
  let frameRequest = 0;
  const hiddenCodes = new Set();  // dismissed or already filled here
  const reportedUsed = new Set();

  function serverNow() {
    return Date.now() + clockOffset;
  }

  function offeredCodes(field) {
    const now = serverNow();
    return codes.filter((entry) => {
      if (hiddenCodes.has(entry.id) || now - entry.receivedAt >= freshMs) return false;
      return !isForAnotherSite(entry) && fits(field, entry.code);
    });
  }

  /**
   * Some messages name the website their code is for ("@example.com #482913").
   * Such a code is offered on that site and its subdomains only, so a
   * look-alike page cannot get it with one careless click.
   */
  function isForAnotherSite(entry) {
    if (!entry.domain) return false;
    const host = location.hostname.toLowerCase();
    const matches = (domain) => !!domain && (host === domain || host.endsWith(`.${domain}`));
    return !matches(entry.domain) && !matches(entry.frameDomain);
  }

  /** Can this code go into this field at all? */
  function fits(field, code) {
    if (field.boxes) return field.boxes.length === code.length;
    const el = field.el;
    if (el.maxLength > 0 && el.maxLength < code.length) return false;
    if (/\D/.test(code) && (el.type === 'number' || (el.getAttribute('inputmode') || '') === 'numeric')) return false;
    return true;
  }

  function currentValue(field) {
    if (field.boxes) return field.boxes.map((box) => box.value).join('');
    return field.el.value.replace(/[\s-]/g, '');
  }

  // ---------------------------------------------------------------------------
  // Scanning the page
  // ---------------------------------------------------------------------------

  function scan() {
    scanQueued = false;
    if (orphaned) return;
    lastScanAt = Date.now();
    const found = [];
    const seen = new Set();
    const inputs = document.querySelectorAll('input');
    const limit = Math.min(inputs.length, MAX_INPUTS);
    for (let i = 0; i < limit; i += 1) {
      const el = inputs[i];
      if (seen.has(el)) continue;
      let info = null;
      try {
        info = classify(el);
      } catch { /* a hostile or half-built DOM must not stop the scan */ }
      if (!info) continue;
      if (info.boxes) info.boxes.forEach((box) => seen.add(box));
      if (!found.some((other) => other.el === info.el)) found.push(info);
    }
    candidates = found;
    update();
  }

  /** Scans soon, but at most about once a second however busy the page is. */
  function queueScan(delay = 250) {
    if (scanQueued || orphaned) return;
    scanQueued = true;
    const earliest = lastScanAt + 900 - Date.now();
    setTimeout(scan, Math.max(delay, earliest, 0));
  }

  /** The field a code should be offered on right now, if any. */
  function pickTarget() {
    const active = deepActiveElement();
    if (active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable)) {
      // The user is typing somewhere: offer only if that is a code field.
      if (!(active instanceof HTMLInputElement)) return null;
      try {
        return classify(active);
      } catch {
        return null;
      }
    }
    let best = null;
    for (const info of candidates) {
      if (info.score < STRONG_SCORE || !isUsable(info.el)) continue;
      if (!inViewport(info.el.getBoundingClientRect())) continue;
      if (!best || info.score > best.score) best = info;
    }
    return best;
  }

  function wantsCodes() {
    return document.visibilityState === 'visible' && (candidates.length > 0 || target !== null);
  }

  // ---------------------------------------------------------------------------
  // Polling for codes
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function pollLoop() {
    if (polling || orphaned) return;
    polling = true;
    let hiccups = 0;
    try {
      while (!orphaned && wantsCodes()) {
        const answer = await send({ type: 'poll', rev, wait: LONG_POLL_SECONDS });
        if (orphaned) break;
        if (answer && answer.ok) {
          hiccups = 0;
          rev = answer.rev;
          clockOffset = answer.now - Date.now();
          freshMs = answer.freshMs || freshMs;
          codes = Array.isArray(answer.codes) ? answer.codes : [];
          const newest = codes.length ? codes[0].id : null;
          if (newest && newest !== newestCodeId) escapedField = null;   // a new code may be shown again
          newestCodeId = newest;
          update();
          continue;
        }
        // No answer at all means the browser restarted the background script
        // while it was waiting, which it is free to do. Ask again before
        // concluding that anything is wrong.
        hiccups += 1;
        if (answer === null && hiccups <= 2) {
          await sleep(300);
          continue;
        }
        if (codes.length) {
          codes = [];
          update();
        }
        rev = 0;
        await sleep(answer && answer.error === 'unpaired' ? 15000 : 5000);
      }
    } finally {
      polling = false;
    }
  }

  function reportUsed(id) {
    hiddenCodes.add(id);
    if (reportedUsed.has(id)) return;
    reportedUsed.add(id);
    send({ type: 'used', id });
  }

  // ---------------------------------------------------------------------------
  // The suggestion
  // ---------------------------------------------------------------------------

  // Two rules keep the page from learning a code before it is chosen:
  //
  //  * Nothing is written as text. Every word and digit is drawn by CSS from
  //    an attribute (see `say`). Page scripts can search the visible text of a
  //    page, closed shadow root or not, and would find a code that was text.
  //  * Only generic font families. A page can define a font of its own under
  //    any real font name and learn which characters were drawn with it.
  const CSS = `
    :host { all: initial; }
    .card {
      font: 13px/1.35 system-ui, sans-serif;
      color: #171b26; background: #ffffff;
      border: 1px solid rgba(20, 24, 40, 0.14); border-radius: 12px;
      box-shadow: 0 10px 30px rgba(20, 24, 40, 0.18), 0 1px 3px rgba(20, 24, 40, 0.08);
      display: flex; align-items: stretch; width: max-content; min-width: 228px; max-width: min(340px, calc(100vw - 16px));
      overflow: hidden; direction: ltr; text-align: left; cursor: default;
      -webkit-user-select: none; user-select: none;
      animation: otp-bridge-in 0.12s ease-out;
    }
    @keyframes otp-bridge-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
    .say::before { content: attr(data-say); }
    .rows { flex: 1; min-width: 0; padding: 4px; }
    .row { display: flex; align-items: center; gap: 10px; padding: 7px 10px 7px 8px; border-radius: 9px; cursor: pointer; }
    .row:hover, .row.active { background: #ecedff; }
    .icon {
      width: 30px; height: 30px; flex: none; border-radius: 9px;
      background: linear-gradient(135deg, #6d6ff5, #2f5fe8);
      display: flex; align-items: center; justify-content: center;
    }
    .text { min-width: 0; display: flex; flex-direction: column; }
    .title { font-weight: 600; white-space: nowrap; }
    .code { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 0.05em; margin-left: 6px; }
    .code .say + .say { margin-left: 0.3em; }
    .sub { color: #5a6475; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .close {
      flex: none; width: 30px; display: flex; align-items: center; justify-content: center;
      color: #7a8394; cursor: pointer; border-left: 1px solid rgba(20, 24, 40, 0.08); font-size: 17px; line-height: 1;
    }
    .close:hover { background: #f0f1f6; color: #171b26; }
    .note { padding: 10px 14px; white-space: normal; max-width: 300px; font-weight: 500; }
    .note.good { color: #0c7a45; font-weight: 600; white-space: nowrap; }
    @media (prefers-color-scheme: dark) {
      .card { color: #eef0f6; background: #1c1f2a; border-color: rgba(255, 255, 255, 0.14);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); }
      .row:hover, .row.active { background: #2a2e52; }
      .sub { color: #a0a8b8; }
      .close { color: #9aa3b4; border-left-color: rgba(255, 255, 255, 0.1); }
      .close:hover { background: #262a37; color: #ffffff; }
      .note.good { color: #52d492; }
    }
    @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  `;

  const HOST_STYLE = [
    ['all', 'initial'], ['position', 'fixed'], ['z-index', '2147483647'], ['left', '0px'], ['top', '0px'],
    ['display', 'block'], ['margin', '0'], ['padding', '0'], ['border', '0'], ['background', 'transparent'],
    ['pointer-events', 'auto'], ['opacity', '1'], ['visibility', 'visible'], ['transform', 'none'],
    ['filter', 'none'], ['clip-path', 'none'], ['width', 'auto'], ['height', 'auto'], ['max-width', 'none'],
    ['max-height', 'none'],
  ];
  const CLICK_DELAY_MS = 400;

  let host = null;
  let shadow = null;
  let card = null;
  let shownSignature = '';
  let styleStamp = '';            // the host's style attribute as this script last wrote it
  let lastPlace = null;           // where the suggestion was put last
  let armedAt = 0;                // clicks before this moment are ignored

  function setHostStyle(name, value) {
    host.style.setProperty(name, value, 'important');
  }

  /**
   * The host's inline style without custom properties. Other extensions (dark
   * mode tools, for one) add "--something" properties to elements they come
   * across; those cannot change how the host looks, so they are not tampering.
   */
  function hostStyleText() {
    return (host.getAttribute('style') || '').replace(/(^|;)\s*--[\w-]+\s*:[^;]*/g, '$1').replace(/;\s*;/g, ';').trim();
  }

  function stampHost() {
    styleStamp = hostStyleText();
  }

  function buildHost() {
    host = document.createElement('div');
    host.setAttribute('data-otp-bridge', '');
    for (const [name, value] of HOST_STYLE) setHostStyle(name, value);
    stampHost();

    shadow = host.attachShadow({ mode: 'closed' });
    // A constructed style sheet is not subject to the page's Content Security Policy.
    let styled = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
      styled = true;
    } catch { /* not available to content scripts in every browser */ }
    if (!styled) {
      const element = document.createElement('style');
      element.textContent = CSS;
      shadow.appendChild(element);
    }
    card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    shadow.appendChild(card);
  }

  /** A piece of visible wording that is not text as far as the page can tell. */
  function say(text, className) {
    const span = document.createElement('span');
    span.className = className ? `say ${className}` : 'say';
    span.setAttribute('data-say', text);
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  /**
   * Has the page hidden, faded or restyled the suggestion behind our back?
   * A click on something the user cannot see must not fill anything in.
   */
  function isHostIntact() {
    if (!host.isConnected || hostStyleText() !== styleStamp) return false;
    const own = getComputedStyle(host);
    if (own.opacity !== '1' || own.visibility !== 'visible' || own.display === 'none' || own.pointerEvents === 'none') return false;
    let opacity = 1;
    for (let node = host.parentElement; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity > 0.6;
  }

  function restoreHost() {
    const left = host.style.getPropertyValue('left');
    const top = host.style.getPropertyValue('top');
    host.removeAttribute('style');
    for (const [name, value] of HOST_STYLE) setHostStyle(name, value);
    if (left) setHostStyle('left', left);
    if (top) setHostStyle('top', top);
    stampHost();
    armedAt = performance.now() + CLICK_DELAY_MS;
  }

  function icon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    const bubble = document.createElementNS(NS, 'path');
    bubble.setAttribute('fill', '#ffffff');
    bubble.setAttribute('d', 'M4 6.500A2.500 2.500 0 0 1 6.500 4h11A2.500 2.500 0 0 1 20 6.500v7a2.500 2.500 0 0 1-2.500 2.500H11l-3.600 3.100c-.320.280-.820.050-.820-.380V16H6.500A2.500 2.500 0 0 1 4 13.500z');
    svg.appendChild(bubble);
    for (const x of [8.2, 12, 15.8]) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', '10');
      dot.setAttribute('r', '1.350');
      dot.setAttribute('fill', '#4a4fe0');
      svg.appendChild(dot);
    }
    const wrap = document.createElement('div');
    wrap.className = 'icon';
    wrap.appendChild(svg);
    return wrap;
  }

  /** "482913" -> ["482", "913"], shown with a small gap between the groups. */
  function codeGroups(code) {
    if (/^\d{6}$/.test(code)) return [code.slice(0, 3), code.slice(3)];
    if (/^\d{8}$/.test(code)) return [code.slice(0, 4), code.slice(4)];
    return [code];
  }

  function ago(receivedAt) {
    const seconds = Math.max(0, Math.round((serverNow() - receivedAt) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds} sec ago`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} min ago`;
  }

  /** Where the suggestion has to live so it is visible and clickable. */
  function mountPoint(el) {
    for (const selector of ['dialog:modal', ':popover-open', ':fullscreen']) {
      try {
        const layer = el.closest(selector);
        if (layer) return layer;
      } catch { /* selector not supported by this browser */ }
    }
    return document.documentElement;
  }

  function anchorRect(field) {
    if (!field.boxes) return field.el.getBoundingClientRect();
    const rects = field.boxes.map((box) => box.getBoundingClientRect());
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  /** Puts the host at a viewport position, whatever its ancestors do to "position: fixed". */
  function moveHostTo(left, top) {
    setHostStyle('left', '0px');
    setHostStyle('top', '0px');
    const origin = host.getBoundingClientRect();
    setHostStyle('left', `${Math.round(left - origin.left)}px`);
    setHostStyle('top', `${Math.round(top - origin.top)}px`);
    // A suggestion that jumps under the pointer must not catch the click meant
    // for whatever was there a moment ago.
    if (!lastPlace || Math.abs(lastPlace.left - left) > 3 || Math.abs(lastPlace.top - top) > 3) {
      armedAt = performance.now() + CLICK_DELAY_MS;
    }
    lastPlace = { left, top };
    stampHost();
  }

  function place() {
    if (!host || !host.isConnected || !anchor) return;
    if (!anchor.el.isConnected) {
      hide();
      queueScan(50);
      return;
    }
    const rect = anchorRect(anchor);
    if (!inViewport(rect) || rect.width === 0) {
      setHostStyle('visibility', 'hidden');
      stampHost();
      return;
    }
    setHostStyle('visibility', 'visible');
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const gap = 6;
    const edge = 8;
    const rtl = getComputedStyle(anchor.el).direction === 'rtl';
    let left = rtl ? rect.right - width : rect.left;
    left = Math.max(edge, Math.min(left, window.innerWidth - width - edge));
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - edge && rect.top - gap - height >= edge) top = rect.top - gap - height;
    moveHostTo(left, top);
  }

  function schedulePlace() {
    if (frameRequest || !host) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      place();
    });
  }

  function attachHost(parent) {
    if (host.parentNode === parent) return;
    parent.appendChild(host);
    lastPlace = null;
    armedAt = performance.now() + CLICK_DELAY_MS;
  }

  function show(field, entries) {
    if (!host) buildHost();
    attachHost(mountPoint(field.el));

    const signature = entries.map((entry) => entry.id).join(',');
    if (signature !== shownSignature || card.dataset.kind !== 'codes') {
      shownSignature = signature;
      card.textContent = '';
      card.dataset.kind = 'codes';
      const rows = document.createElement('div');
      rows.className = 'rows';
      entries.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.dataset.index = String(index);
        row.appendChild(icon());
        const text = document.createElement('div');
        text.className = 'text';
        const title = document.createElement('div');
        title.className = 'title';
        title.appendChild(say('Fill code'));
        const code = document.createElement('span');
        code.className = 'code';
        for (const group of codeGroups(entry.code)) code.appendChild(say(group));
        title.appendChild(code);
        text.append(title, say('', 'sub'));
        row.appendChild(text);
        rows.appendChild(row);
      });
      const close = say('×', 'close');
      close.dataset.action = 'close';
      card.append(rows, close);
      // For screen readers; attributes cannot be searched the way text can.
      card.setAttribute('aria-label', `Verification code ${entries[0].code} from your phone. `
        + 'Press the down arrow, then Enter, to fill it in.');
      activeRow = Math.min(activeRow, entries.length - 1);
      armedAt = performance.now() + CLICK_DELAY_MS;
    }
    card.querySelectorAll('.row').forEach((row, index) => {
      const entry = entries[index];
      row.querySelector('.sub').setAttribute('data-say',
        `${entry.sender ? `From ${entry.sender}` : 'From your phone'} · ${ago(entry.receivedAt)}`);
      row.classList.toggle('active', index === activeRow);
    });
    host.dataset.state = 'codes';
    host.dataset.count = String(entries.length);
    place();
  }

  function showNote(text, good, near) {
    if (!host) buildHost();
    attachHost(near && near.isConnected ? mountPoint(near) : document.documentElement);
    shownSignature = '';
    card.textContent = '';
    card.dataset.kind = 'note';
    card.setAttribute('aria-label', text);
    card.appendChild(say(text, good ? 'note good' : 'note'));
    host.dataset.state = 'note';
    delete host.dataset.count;
    setHostStyle('visibility', 'visible');

    const rect = near && near.isConnected ? near.getBoundingClientRect() : null;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    let left = window.innerWidth - width - 16;
    let top = 16;
    if (rect && inViewport(rect)) {
      left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8 && rect.top - 6 - height >= 8) top = rect.top - 6 - height;
    }
    moveHostTo(left, top);

    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      if (card && card.dataset.kind === 'note') hide();
      update();
    }, good ? 1100 : 3500);
  }

  function hide() {
    anchor = null;
    activeRow = -1;
    shownSignature = '';
    lastPlace = null;
    if (host && host.isConnected) host.remove();
    if (host) delete host.dataset.state;
  }

  function isShowingCodes() {
    return !!(host && host.isConnected && card.dataset.kind === 'codes' && anchor);
  }

  /** Decides whether a suggestion should be on screen, and where. */
  function update() {
    if (orphaned) return;
    target = document.visibilityState === 'visible' ? pickTarget() : null;
    if (wantsCodes()) pollLoop();
    if (noticeTimer) return;                       // a note is on screen; codes come back after it

    if (!target || target.el === escapedField) {
      hide();
      return;
    }

    // Typed by hand, or filled by us a moment ago: nothing left to offer.
    const value = currentValue(target);
    for (const entry of codes) {
      if (value && value === entry.code && !hiddenCodes.has(entry.id)) reportUsed(entry.id);
    }

    const entries = offeredCodes(target).slice(0, 3);
    if (entries.length === 0) {
      hide();
      return;
    }
    if (!anchor || anchor.el !== target.el) activeRow = -1;
    anchor = target;
    show(target, entries);

    // Come back to refresh "12 sec ago" and to drop a code that went stale.
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(update, 10000);
  }

  // ---------------------------------------------------------------------------
  // Filling
  // ---------------------------------------------------------------------------

  function setValue(el, value) {
    const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    // The prototype's setter, so frameworks that track `value` notice the change.
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
  }

  function inputEvent(data) {
    return new InputEvent('input', { bubbles: true, composed: true, data, inputType: 'insertText' });
  }

  function fillOne(el, code) {
    try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
    setValue(el, code);
    el.dispatchEvent(inputEvent(code));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return el.value.replace(/[\s-]/g, '') === code;
  }

  function keyEvent(type, ch) {
    const digit = /\d/.test(ch);
    return new KeyboardEvent(type, {
      key: ch,
      code: digit ? `Digit${ch}` : `Key${ch.toUpperCase()}`,
      keyCode: ch.toUpperCase().charCodeAt(0),
      which: ch.toUpperCase().charCodeAt(0),
      bubbles: true,
      composed: true,
      cancelable: true,
    });
  }

  function fillBoxes(startBoxes, code) {
    let boxes = startBoxes;
    for (let i = 0; i < code.length; i += 1) {
      // Frameworks may re-create the boxes while we type; find them again.
      if (!boxes[i] || !boxes[i].isConnected) {
        const alive = boxes.find((box) => box && box.isConnected) || deepActiveElement();
        const again = alive instanceof HTMLInputElement ? findCodeBoxes(alive) : null;
        if (!again || again.length !== code.length) break;
        boxes = again;
      }
      const box = boxes[i];
      const ch = code[i];
      try { box.focus({ preventScroll: true }); } catch { /* keep going */ }
      // Typed like a key press: a page that handles the key itself (and
      // cancels it) gets no second, duplicate input.
      const notHandled = box.dispatchEvent(keyEvent('keydown', ch));
      if (notHandled && box.value !== ch) {
        setValue(box, ch);
        box.dispatchEvent(inputEvent(ch));
      }
      box.dispatchEvent(keyEvent('keyup', ch));
      box.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
    const read = () => boxes.map((box) => box.value).join('');
    if (read() === code) return true;

    // Last resort: paste the whole code into the first box.
    try {
      const first = boxes.find((box) => box.isConnected) || boxes[0];
      const transfer = new DataTransfer();
      transfer.setData('text/plain', code);
      first.focus({ preventScroll: true });
      first.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true, composed: true }));
      const again = findCodeBoxes(first);
      if (again) boxes = again;
    } catch { /* paste events cannot be made here */ }
    return read() === code;
  }

  function fillField(field, code) {
    if (field.boxes && field.boxes.length === code.length) return fillBoxes(field.boxes, code);
    return fillOne(field.el, code);
  }

  function choose(index) {
    if (!anchor) return;
    const field = anchor;
    const entry = offeredCodes(field)[index];
    if (!entry) return;
    let filled = false;
    try {
      filled = fillField(field, entry.code);
    } catch { /* reported below */ }
    if (filled) {
      reportUsed(entry.id);
      showNote('✓ Filled in', true, field.el);
    } else {
      hiddenCodes.add(entry.id);
      showNote('Could not fill this field. Click the OTP Bridge button in the toolbar to copy the code.', false, field.el);
    }
    anchor = null;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  const listeners = [];
  function listen(node, type, handler, options) {
    node.addEventListener(type, handler, options);
    listeners.push(() => node.removeEventListener(type, handler, options));
  }

  function isOurs(event) {
    return !!host && (event.target === host || (typeof event.composedPath === 'function' && event.composedPath().includes(host)));
  }

  // Clicks on the suggestion are handled here, at the very start of their
  // journey, and go no further. Pages that close a dialog on "click outside"
  // would otherwise close the dialog the code field is in.
  function onPointer(event) {
    if (!isOurs(event)) return;
    // Only clicks made by the person at the computer count. A page could
    // otherwise "click" the suggestion itself and read the code it fills in.
    if (!event.isTrusted) return;
    event.stopImmediatePropagation();
    if (event.type === 'mousedown') event.preventDefault();   // keep the field focused
    if (event.type !== 'click' || event.button !== 0) return;
    event.preventDefault();
    if (performance.now() < armedAt) return;                  // it appeared or moved under the pointer just now
    if (!isHostIntact()) {
      restoreHost();
      return;
    }
    const hit = shadow.elementFromPoint(event.clientX, event.clientY);
    if (!hit || !card.contains(hit)) return;
    if (hit.closest('[data-action="close"]')) {
      if (anchor) offeredCodes(anchor).forEach((entry) => hiddenCodes.add(entry.id));
      hide();
      return;
    }
    const row = hit.closest('.row');
    if (row) choose(Number(row.dataset.index));
  }

  function onKeyDown(event) {
    if (!event.isTrusted || !isShowingCodes() || event.isComposing) return;
    // Only while the code field itself has the keyboard; otherwise the arrow
    // keys belong to the page.
    const active = deepActiveElement();
    if (active !== anchor.el && !(anchor.boxes && anchor.boxes.includes(active))) return;
    const count = Number(host.dataset.count) || 0;
    if (event.key === 'Escape') {
      escapedField = anchor.el;
      hide();
      return;
    }
    if (event.key === 'ArrowDown' || (event.key === 'ArrowUp' && activeRow >= 0)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      activeRow = event.key === 'ArrowDown' ? (activeRow + 1) % count : activeRow - 1;
      update();
      return;
    }
    if (event.key === 'Enter' && activeRow >= 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      choose(activeRow);
      return;
    }
    if (activeRow >= 0 && event.key.length === 1) {
      activeRow = -1;
      update();
    }
  }

  function onFocusChange() {
    escapedField = null;
    // Let the page finish moving focus before deciding.
    setTimeout(update, 0);
  }

  function onInput(event) {
    const el = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
    if (el instanceof HTMLInputElement && codes.length) setTimeout(update, 0);
  }

  function onMessage(message, sender, sendResponse) {
    if (!message || sender.id !== api.runtime.id) return undefined;

    if (message.type === 'notice' && typeof message.text === 'string') {
      const near = contextTarget && contextTarget.isConnected ? contextTarget : deepActiveElement();
      showNote(message.text.slice(0, 200), false, near instanceof Element ? near : null);
      return undefined;
    }

    if (message.type === 'fill' && typeof message.code === 'string' && /^[A-Za-z0-9]{4,12}$/.test(message.code)) {
      let el = null;
      const active = deepActiveElement();
      const typable = (node) => node instanceof HTMLTextAreaElement || (node instanceof HTMLInputElement && isTextInput(node));
      if (message.mode === 'context') el = contextTarget && contextTarget.isConnected ? contextTarget : active;
      else if (message.mode === 'focused') el = typable(active) ? active : null;
      else if (message.mode === 'best') {
        const best = candidates.filter((info) => isUsable(info.el)).sort((a, b) => b.score - a.score)[0];
        el = best ? best.el : null;
      }
      if (!el || !typable(el) || el.disabled || el.readOnly) {
        // Stay silent so another frame of this tab can answer instead.
        if (message.mode === 'context') sendResponse({ ok: false });
        return undefined;
      }
      let info = null;
      try { info = el instanceof HTMLInputElement ? classify(el) : null; } catch { /* plain field */ }
      const field = info && info.boxes && info.boxes.length === message.code.length ? info : { el, boxes: null };
      let filled = false;
      try { filled = fillField(field, message.code); } catch { /* reported below */ }
      if (filled && typeof message.id === 'string') reportUsed(message.id);
      if (filled) showNote('✓ Filled in', true, el);
      sendResponse({ ok: filled });
      return undefined;
    }
    return undefined;
  }

  let observer = null;

  function shutDown() {
    if (orphaned) return;
    orphaned = true;
    clearTimeout(noticeTimer);
    clearTimeout(expiryTimer);
    clearInterval(scanTimer);
    if (observer) observer.disconnect();
    listeners.forEach((remove) => remove());
    try { api.runtime.onMessage.removeListener(onMessage); } catch { /* already gone */ }
    if (host && host.isConnected) host.remove();
  }

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchend']) {
    listen(window, type, onPointer, true);
  }
  listen(window, 'contextmenu', (event) => {
    const el = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
    contextTarget = el instanceof Element ? el : null;
  }, true);
  listen(window, 'keydown', onKeyDown, true);
  listen(window, 'focusin', onFocusChange, true);
  listen(window, 'focusout', onFocusChange, true);
  listen(window, 'input', onInput, true);
  listen(window, 'scroll', schedulePlace, { capture: true, passive: true });
  listen(window, 'resize', schedulePlace, { passive: true });
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') queueScan(0);
    else update();
  });
  listen(window, 'pageshow', () => queueScan(0));

  api.runtime.onMessage.addListener(onMessage);

  // New fields appear when pages change without reloading.
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.target === host || (host && host.contains(mutation.target))) continue;
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1 && node !== host) {
          queueScan();
          return;
        }
      }
      for (const node of mutation.removedNodes) {
        if (node.nodeType === 1 && anchor && (node === anchor.el || node.contains(anchor.el))) {
          queueScan(0);
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Fields are also revealed by style changes, which the observer does not
  // watch; a light periodic look catches those. It also keeps the suggestion
  // glued to a field that moves.
  scanTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (candidates.length > 0 || document.getElementsByTagName('input').length > 0) queueScan(0);
    if (isShowingCodes()) schedulePlace();
  }, RESCAN_MS);

  scan();
})();

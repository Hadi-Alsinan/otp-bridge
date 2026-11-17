'use strict';

/**
 * Finds the one-time verification code inside the text of an SMS.
 *
 * The parser is deliberately conservative: a phone forwards *every* message
 * that matches its filter, so the text may just as well be a purchase receipt
 * ("SAR 150.00 on card *1234") as a real code. A number is only accepted when
 * something in the message says it is a code, and numbers that are clearly
 * something else (amounts, card endings, dates, phone numbers, order numbers,
 * anything inside a link) are thrown out first.
 *
 * Usage:
 *   const { extractOtp } = require('./otp-parser');
 *   extractOtp('G-482913 is your Google verification code.');
 *   // -> { code: '482913', score: 71, kind: 'numeric' }
 *   extractOtp('Your parcel will arrive tomorrow');   // -> null
 */

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

// First code point of each block of ten Unicode decimal digits we convert to
// ASCII: Arabic-Indic, Persian/Urdu, N'Ko, Devanagari, Bengali, Gurmukhi,
// Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala, Thai, Lao,
// Tibetan, Myanmar, Khmer, Mongolian and fullwidth digits.
const DIGIT_BLOCK_STARTS = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6,
  0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x17e0,
  0x1810, 0xff10,
];

// Sentence punctuation gets a space after it so that "4829，5分钟" stays two
// numbers; the Arabic decimal and thousands marks stay glued on purpose.
const PUNCTUATION_MAP = {
  '：': ':', '，': ', ', '。': '. ', '（': '(', '）': ')', '＃': '#', '！': '! ',
  '？': '? ', '；': '; ', '＊': '*', '＋': '+', '／': '/', '＝': '=', '、': ', ',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '−': '-', '－': '-',
  '،': ', ', '؛': '; ', '٫': '.', '٬': ',', '٪': '%', '٭': '*',
};

function normalizeText(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(/\r\n?/g, '\n');
  // Invisible characters: zero-width, bidi controls, soft hyphen, BOM.
  s = s.replace(/[­؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '');
  // Every kind of horizontal space becomes a plain space.
  s = s.replace(/[\t   -   　]/g, ' ');
  s = s.replace(/[^\x00-\x7f]/gu, (ch) => {
    if (Object.prototype.hasOwnProperty.call(PUNCTUATION_MAP, ch)) return PUNCTUATION_MAP[ch];
    const cp = ch.codePointAt(0);
    for (const start of DIGIT_BLOCK_STARTS) {
      if (cp >= start && cp <= start + 9) return String(cp - start);
    }
    // Mathematical bold / double-struck / sans / monospace digits.
    if (cp >= 0x1d7ce && cp <= 0x1d7ff) return String((cp - 0x1d7ce) % 10);
    return ch;
  });
  return s;
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

// Words that all but guarantee the message carries a verification code.
// "Bounded" entries are for scripts that put spaces between words; they must
// not be glued to another letter or digit ("otp" must not match in "laptop").
const STRONG_BOUNDED = [
  // English
  'one[- ]?time (?:pass(?:word|code)|pin|code|pass)', 'otp', 'otps', 'otac', 'passcode', 'pass code',
  'verification code', 'verification pin', 'verify code', 'security code', 'secure code',
  'authentication code', 'authentication pin', 'authenticat(?:ion|or) code', 'auth code',
  'authori[sz]ation code', 'login code', 'log-?in code', 'sign-?in code', 'sign-?up code',
  'access code', 'confirmation code', 'activation code', 'validation code', 'registration code',
  'secret code', 'reset code', 'recovery code', '2fa code', 'mfa code', '2fa', 'two[- ]factor',
  'two[- ]step', 'pin code', 'temporary (?:code|password|pin)', 'identification code', 'identity code',
  'transaction code', 'approval code', 'm?tan', 'smstan', 'tac',
  // Spanish
  'c[oó]digo de (?:verificaci[oó]n|seguridad|confirmaci[oó]n|acceso|activaci[oó]n|autenticaci[oó]n|validaci[oó]n)',
  'clave (?:din[aá]mica|temporal|de verificaci[oó]n|de seguridad)', 'c[oó]digo [uú]nico',
  // Portuguese
  'c[oó]digo de (?:verifica[cç][aã]o|seguran[cç]a|confirma[cç][aã]o|acesso|ativa[cç][aã]o|autentica[cç][aã]o|valida[cç][aã]o)',
  // French
  'code de (?:v[eé]rification|s[eé]curit[eé]|confirmation|validation|connexion|activation|authentification)',
  'code (?:secret|unique|temporaire)', 'mot de passe (?:unique|temporaire|[aà] usage unique)',
  // Italian
  'codice di (?:verifica|sicurezza|conferma|accesso|attivazione|autenticazione)', 'codice (?:temporaneo|otp)',
  // German
  'best[aä]tigungscode', 'verifizierungscode', 'sicherheitscode', 'pr[uü]fcode', 'einmalcode',
  'einmalpasswort', 'einmalkennwort', 'zugangscode', 'anmeldecode', 'aktivierungscode', 'freischaltcode',
  // Dutch
  'verificatiecode', 'bevestigingscode', 'beveiligingscode', 'inlogcode', 'toegangscode',
  // Nordic
  'verifieringskod', 'eng[aå]ngskod', 'bekr[aä]ftelsekod', 's[aä]kerhetskod', 'verifiseringskode',
  'engangskode', 'bekreftelseskode', 'bekr[aæ]ftelseskode', 'bekræftelseskode', 'sikkerhedskode',
  'vahvistuskoodi', 'kertak[aä]ytt[oö]koodi',
  // Turkish
  'do[gğ]rulama kodu(?:nuz)?', 'onay kodu(?:nuz)?', 'g[uü]venlik kodu(?:nuz)?', 'aktivasyon kodu(?:nuz)?',
  'tek kullan[iı]ml[iı]k (?:[sş]ifre(?:niz)?|kod(?:unuz)?)', 'giri[sş] kodu(?:nuz)?',
  // Russian / Ukrainian
  'код(?:а|у|ом)? подтверждения', 'проверочный код', 'код проверки', 'код доступа', 'код активации',
  'код авторизации', 'одноразовый (?:код|пароль)', 'код підтвердження', 'код перевірки',
  // Polish / Czech
  'kod weryfikacyjny', 'kod potwierdzaj[aą]cy', 'kod autoryzacyjny', 'kod aktywacyjny', 'has[lł]o jednorazowe',
  'ov[eě][rř]ovac[ií] k[oó]d', 'potvrzovac[ií] k[oó]d',
  // Indonesian / Malay / Filipino
  'kode verifikasi', 'kode otp', 'kode keamanan', 'kode konfirmasi', 'kode rahasia', 'kode akses',
  'kod pengesahan', 'kod keselamatan', 'kod otp',
  // Vietnamese
  'm[aã] x[aá]c (?:nh[aậ]n|minh|th[uự]c)', 'm[aã] otp',
  // Greek
  'κωδικ[οό]ς επαλ[ηή]θευσης', 'κωδικ[οό]ς επιβεβα[ιί]ωσης',
];

const WEAK_BOUNDED = [
  'code', 'codes', 'pin', 'password', 'token', 'verification', 'verify', 'verifying',
  'c[oó]digo', 'clave', 'contrase[nñ]a', 'senha', 'codice', 'kennwort', 'passwort',
  'kodu(?:nuz)?', 'kod', 'kode', 'koodi', '[sş]ifre(?:niz)?', 'код', 'пароль', 'has[lł]o', 'k[oó]d', 'm[aã]',
  'κωδικ[οό]ς',
];

// Scripts without reliable word boundaries (prefixes are attached to words, or
// there are no spaces at all), matched as plain substrings.
const STRONG_UNBOUNDED = [
  // Arabic
  'رمز التحقق', 'رمز التأكيد', 'رمز التاكيد', 'رمز التفعيل', 'رمز الدخول', 'رمز الأمان', 'رمز الامان',
  'رمز الحماية', 'رمز التوثيق', 'رمز المصادقة', 'رمز المرور', 'رمز التسجيل', 'رمز العملية',
  'الرمز السري', 'رمز سري', 'الرمز المؤقت', 'رمز مؤقت', 'رمز لمرة واحدة', 'الرمز لمرة واحدة',
  'كلمة المرور المؤقتة', 'كلمة مرور مؤقتة', 'كلمة السر المؤقتة', 'كلمة المرور لمرة واحدة',
  'كلمة مرور لمرة واحدة', 'الرقم السري المؤقت', 'رقم سري مؤقت', 'كود التحقق', 'كود التفعيل',
  'كود التأكيد', 'كود التاكيد', 'كود الدخول', 'كود الأمان', 'رمز الاستخدام لمرة واحدة',
  // Persian / Urdu
  'کد تایید', 'کد تأیید', 'کد فعال‌سازی', 'کد فعالسازی', 'کد ورود', 'کد امنیتی', 'رمز یکبار مصرف',
  'رمز یک بار مصرف', 'رمز پویا', 'تصدیقی کوڈ', 'او ٹی پی',
  // Hebrew
  'קוד אימות', 'קוד האימות', 'קוד חד פעמי', 'קוד חד-פעמי', 'סיסמה חד פעמית', 'קוד אישור', 'קוד הזיהוי',
  // Chinese
  '验证码', '驗證碼', '校验码', '校驗碼', '动态码', '動態碼', '动态密码', '動態密碼', '确认码', '確認碼',
  '认证码', '認證碼', '安全码', '安全碼', '登录码', '登入碼', '激活码', '授权码',
  // Japanese
  '認証コード', '確認コード', '認証番号', '確認番号', '暗証番号', 'セキュリティコード', 'ワンタイムパスワード',
  'パスコード', '検証コード', '認証用コード',
  // Korean
  '인증번호', '인증 번호', '인증코드', '인증 코드', '확인 코드', '확인코드', '보안 코드', '보안코드',
  '일회용 비밀번호', '승인번호',
  // Thai
  'รหัสยืนยัน', 'รหัส otp', 'รหัสผ่านครั้งเดียว', 'รหัสความปลอดภัย',
  // Hindi and other Indic
  'ओटीपी', 'सत्यापन कोड', 'वेरिफिकेशन कोड', 'ওটিপি', 'যাচাইকরণ কোড',
];

const WEAK_UNBOUNDED = [
  'رمز', 'كود', 'كلمة المرور', 'كلمة السر', 'الرقم السري', 'کد', 'کوڈ', 'קוד', 'סיסמה',
  '密码', '密碼', 'コード', '코드', 'รหัส', 'कोड', 'কোড',
];

// "code" that is not a verification code.
const NOT_A_CODE_BEFORE = new RegExp(
  '(?:promo(?:tion(?:al)?)?|coupon|discount|voucher|referral|invite|invitation|gift|tracking|booking|'
  + 'reservation|zip|postal|post|area|country|qr|bar|product|item|store|branch|offer|bonus|redeem|'
  + 'redemption|dress|source|error|status|reference|ref|order|pick-?up|collection|locker|delivery|'
  + 'parcel|shipment|shipping|coupon|sort|swift|bank|branch|iban|ussd|short|dial)\\s+$', 'i');
const NOT_A_CODE_AFTER_AR = /^\s*(?:البريدي|الخصم|خصم|الترويجي|ترويجي|الشحنة|الشحن|التتبع|المنتج|الدولة|القسيمة|الطلب|الاستلام|المرجع)/;

function buildKeywordRegex(bounded, unbounded) {
  const parts = [];
  if (bounded.length) parts.push(`(?<![\\p{L}\\p{N}_])(?:${bounded.join('|')})(?![\\p{L}\\p{N}_])`);
  if (unbounded.length) parts.push(`(?:${unbounded.join('|')})`);
  return new RegExp(parts.join('|'), 'giu');
}

const STRONG_RE = buildKeywordRegex(STRONG_BOUNDED, STRONG_UNBOUNDED);
const WEAK_RE = buildKeywordRegex(WEAK_BOUNDED, WEAK_UNBOUNDED);

function findKeywords(text) {
  const found = [];
  for (const m of text.matchAll(STRONG_RE)) {
    found.push({ start: m.index, end: m.index + m[0].length, strong: true });
  }
  for (const m of text.matchAll(WEAK_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (found.some((k) => k.strong && start < k.end && end > k.start)) continue;
    // "promo code", "tracking code", "الرمز البريدي" ... are not what we want.
    if (NOT_A_CODE_BEFORE.test(text.slice(Math.max(0, start - 24), start))) continue;
    if (NOT_A_CODE_AFTER_AR.test(text.slice(end, end + 16))) continue;
    found.push({ start, end, strong: false });
  }
  found.sort((a, b) => a.start - b.start);
  return found;
}

// ---------------------------------------------------------------------------
// Context rules
// ---------------------------------------------------------------------------

const CURRENCY = '(?:SAR|SR|USD|US\\$|EUR|GBP|AED|KWD|BHD|QAR|OMR|EGP|JOD|INR|PKR|BDT|LKR|MYR|RM|IDR|Rp|PHP|'
  + 'THB|VND|NGN|KES|ZAR|TRY|TL|RUB|CNY|RMB|JPY|KRW|CAD|AUD|CHF|Rs\\.?|\\$|€|£|¥|₹|₽|₺|₩|₦|﷼|'
  + 'ر\\.?\\s?س\\.?|ريال|ريالات|درهم|دراهم|دينار|جنيه|ليرة|دولار|روبية)';
const AMOUNT_BEFORE = new RegExp(
  `(?:${CURRENCY}|(?<![\\p{L}])(?:amount|amt|total|balance|bal|price|payment|paid|debited|credited|`
  + `withdrawn|deposit|limit|fee|bill|due)|مبلغ|بمبلغ|المبلغ|رصيد|الرصيد|قيمة|بقيمة|金额|金額)`
  + `\\s*(?:of|is|was|:|=|-)?\\s*$`, 'iu');
const AMOUNT_AFTER = new RegExp(
  `^\\s?(?:${CURRENCY}|dollars?|riyals?|rupees?|euros?|pounds?|dirhams?|dinars?|bucks|元|円|원)(?![\\p{L}])`, 'iu');

// "card ending 1234", "a/c XX1234", "المنتهية بـ 1234": never a code.
const CARD_ENDING_BEFORE = new RegExp(
  '(?:ending(?:\\s+(?:in|with))?|ends\\s+(?:in|with)|last\\s+(?:4|four)(?:\\s+digits)?|x{2,}|\\*+|•+|'
  + 'المنتهية|المنتهي|تنتهي|آخر\\s+(?:4|أربعة)\\s+أرقام|尾号|尾號|末尾|下4桁)'
  + '\\s*(?:no\\.?|number|in|with|is|are|ب|بـ|بالرقم|رقم|#|:|-)*\\s*[*•xX#]*\\s*$', 'iu');
// "card 1234", "account: 1234": almost never a code, but "the login code for
// your account: 482913" exists, so this only costs points.
const CARD_WORD_BEFORE = new RegExp(
  '(?:(?<![\\p{L}])(?:cards?|acct\\.?|account|a\\/c|debit|credit|visa|mastercard|mada|amex|iban)|'
  + 'بطاقة|البطاقة|بطاقتك|حساب|الحساب|حسابك|مدى|فيزا|卡号|卡號)'
  + '\\s*(?:no\\.?|number|num|رقم|#|:|-)*\\s*$', 'iu');

const REFERENCE_BEFORE = new RegExp(
  '(?<![\\p{L}])(?:ref(?:erence)?\\.?|order|invoice|ticket|case|tracking|track|booking|reservation|txn|'
  + 'transaction|trans\\.?|trx|receipt|id|no\\.?|nr\\.?|number|num|flight|gate|seat|room|ext\\.?|extension|'
  + 'policy|claim|member|customer|awb|parcel|shipment|package)\\s*(?:no\\.?|number|num|id|#|:|-)*\\s*#?\\s*$'
  + '|(?:رقم\\s+(?:المرجع|الطلب|العملية|الفاتورة|الشحنة|الحجز|التذكرة|العميل|الهوية)|المرجع|مرجع|الطلب|الفاتورة|'
  + 'الشحنة|订单号?|订单|訂單|单号|單號|注文番号|주문번호)\\s*(?:رقم|#|:|-)*\\s*$', 'iu');

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|'
  + 'oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|'
  + 'سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)';
const MONTH_BEFORE = new RegExp(`(?<![\\p{L}])${MONTH}\\.?,?\\s*(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s*)?$`, 'iu');
const MONTH_AFTER = new RegExp(`^\\s*${MONTH}(?![\\p{L}])`, 'iu');

const UNIT_AFTER = new RegExp(
  '^\\s?(?:%|min(?:ute)?s?|sec(?:ond)?s?|hours?|hrs?|days?|weeks?|months?|years?|yrs?|am|pm|gb|mb|kb|kg|km|'
  + 'points?|pts|miles|items?|times|people|users?|st|nd|rd|th|دقيقة|دقائق|دقايق|ثانية|ثواني|ثوان|ساعة|ساعات|'
  + 'يوم|أيام|ايام|نقطة|نقاط|分钟|分鐘|秒|小时|小時|分間|分|時間|日|분|초|시간|минут[аы]?|секунд[аы]?|час(?:а|ов)?)'
  + '(?![\\p{L}])', 'iu');

// Text allowed between a keyword and the code right behind it:
// "code: 1234", "code is 1234", "رمز التحقق هو 1234", "验证码：1234", "OTP <1234>".
const CONNECTOR = '(?:is|are|was|will be|est|es|ist|lautet|[eé]|[eè]|sono|هو|هي|adalah|ialah|to|为|為|是|は|です|이|가|은|는)';
const PREFIX_TAG = '(?:[A-Za-z]{1,3}-)?';  // "G-482913"
const TIGHT_GAP = new RegExp(
  `^[\\s:=\\->#\\[(「【《『"'“‘<*]*(?:${CONNECTOR}(?![\\p{L}]))?[\\s:=\\->#\\[(「【《『"'“‘<*]*${PREFIX_TAG}$`, 'iu');
const CONNECTOR_BEFORE = new RegExp(`(?:(?<![\\p{L}])${CONNECTOR}\\s*[:=-]?|[:=])\\s*["'“‘\\[(「【<]?\\s*${PREFIX_TAG}$`, 'iu');
const VERB_BEFORE = /(?<![\p{L}])(?:use|enter|type|input|submit|provide|استخدم|استعمل|أدخل|ادخل|输入|輸入|入力)\s+(?:the\s+)?(?:code\s+)?["'“‘[(]?\s*$/iu;

// A sentence ends at ". ", "! ", a line break and so on. A full stop inside a
// number ("1,500.00") or an abbreviation glued to one ("Rs.2500") does not count.
const SENTENCE_BREAK = /[.!?。！？؟…;][\s"'”’)\]]|[。！？]|\n/u;

const URL_RE = /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}@])(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/giu;

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * Numbers in the text, with any digit groups that are glued together by
 * punctuation kept as one token: "1,500.00", "2026-11-16", "10:35",
 * "555-123-4567" are each a single (non-code) token, "482-913" is a code.
 */
function findNumberTokens(text) {
  const tokens = [];
  const re = /\d+(?:[-./:,]\d+)*/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const groups = raw.split(/[-./:,]/);
    tokens.push({ raw, start: m.index, end: m.index + raw.length, groups });
  }
  return tokens;
}

function isAsciiLetter(ch) {
  return ch !== undefined && /[A-Za-z_]/.test(ch);
}

function baseScoreForLength(len) {
  if (len === 6) return 20;
  if (len === 4 || len === 5) return 14;
  if (len === 8) return 12;
  return 10; // 7 digits
}

function buildCandidates(text) {
  const urlSpans = [];
  for (const m of text.matchAll(URL_RE)) urlSpans.push([m.index, m.index + m[0].length]);
  const inUrl = (start, end) => urlSpans.some(([a, b]) => start < b && end > a);

  const tokens = findNumberTokens(text);
  const candidates = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (inUrl(tok.start, tok.end)) continue;

    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const gapToPrev = prev ? text.slice(prev.end, tok.start) : null;
    const gapToNext = next ? text.slice(tok.end, next.start) : null;
    const prevIsNeighbour = gapToPrev === ' ' && !inUrl(prev.start, prev.end);
    const nextIsNeighbour = gapToNext === ' ' && !inUrl(next.start, next.end);

    // "482-913"
    if (tok.groups.length === 2 && tok.raw.includes('-')
      && tok.groups[0].length === 3 && tok.groups[1].length === 3
      && !prevIsNeighbour && !nextIsNeighbour) {
      candidates.push({ code: tok.groups.join(''), start: tok.start, end: tok.end, base: 18, split: true });
      continue;
    }
    if (tok.groups.length !== 1) continue; // amount, date, time, phone number, IP address ...

    // "482 913": two groups of three, with no third number next to them.
    if (tok.raw.length === 3 && nextIsNeighbour && next.groups.length === 1 && next.raw.length === 3
      && !prevIsNeighbour) {
      const after = tokens[i + 2];
      const afterIsNeighbour = after && text.slice(next.end, after.start) === ' ';
      if (!afterIsNeighbour) {
        candidates.push({ code: tok.raw + next.raw, start: tok.start, end: next.end, base: 18, split: true });
        i += 1;
        continue;
      }
    }

    const len = tok.raw.length;
    if (len < 4 || len > 8) continue;
    candidates.push({
      code: tok.raw,
      start: tok.start,
      end: tok.end,
      base: baseScoreForLength(len),
      besideNumber: prevIsNeighbour || nextIsNeighbour,
    });
  }
  return candidates;
}

/** Returns false when the surroundings prove the number is not a code. */
function passesContextRules(text, cand) {
  const prevChar = text[cand.start - 1];
  const nextChar = text[cand.end];
  // Part of a longer identifier: "AB1234", "1234th", "x1234", "v2.1234".
  if (isAsciiLetter(prevChar) || isAsciiLetter(nextChar)) return false;
  // "+966...", "*1234", decimals that slipped through ("١٥٠٫٥٠" is normalised earlier).
  if (prevChar === '+' || prevChar === '*' || prevChar === '•' || prevChar === '@' || prevChar === '/') return false;
  if (nextChar === '*' || nextChar === '@' || nextChar === '%') return false;

  const before = text.slice(Math.max(0, cand.start - 48), cand.start);
  const after = text.slice(cand.end, cand.end + 24);
  if (AMOUNT_BEFORE.test(before) || AMOUNT_AFTER.test(after)) return false;
  if (CARD_ENDING_BEFORE.test(before)) return false;
  if (UNIT_AFTER.test(after)) return false;
  if (MONTH_BEFORE.test(before) || MONTH_AFTER.test(after)) return false;
  return true;
}

function scoreCandidate(text, cand, keywords) {
  let score = cand.base;
  const before = text.slice(Math.max(0, cand.start - 48), cand.start);

  let best = 0;
  let sawDistantStrong = false;
  let sawDistantWeak = false;

  for (const kw of keywords) {
    let bonus = 0;
    if (kw.end <= cand.start) {
      const gap = text.slice(kw.end, cand.start);
      if (gap.length <= 20 && TIGHT_GAP.test(gap)) {
        bonus = kw.strong ? 60 : 50;
      } else if (gap.length <= 90 && !SENTENCE_BREAK.test(gap)) {
        bonus = (kw.strong ? 44 : 32) - Math.min(15, gap.length / 4);
        if (/\d{3,}/.test(gap)) bonus /= 2; // another number sits between them
      }
    } else if (kw.start >= cand.end) {
      const gap = text.slice(cand.end, kw.start);
      if (gap.length <= 48 && !SENTENCE_BREAK.test(gap) && !/\d{3,}/.test(gap)) {
        bonus = (kw.strong ? 55 : 42) - Math.min(12, gap.length / 4);
      }
    }
    if (bonus > best) best = bonus;
    if (bonus === 0) {
      if (kw.strong) sawDistantStrong = true; else sawDistantWeak = true;
    }
  }

  if (best > 0) score += best;
  else if (sawDistantStrong) score += 18;
  else if (sawDistantWeak) score += 8;

  if (CONNECTOR_BEFORE.test(before)) score += 12;
  if (VERB_BEFORE.test(before)) score += 15;

  // A code alone on its own line.
  const lineStart = text.lastIndexOf('\n', cand.start - 1) + 1;
  let lineEnd = text.indexOf('\n', cand.end);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd).trim();
  if (text.includes('\n') && /^[\W_]*$/u.test(line.replace(text.slice(cand.start, cand.end), ''))) score += 25;

  if (REFERENCE_BEFORE.test(before)) score -= 40;
  if (CARD_WORD_BEFORE.test(before)) score -= 25;
  if (text[cand.start - 1] === '#') score -= 20;
  if (cand.besideNumber) score -= 30;
  if (!cand.split && cand.code.length === 4 && /^(?:19|20)\d\d$/.test(cand.code)) score -= 10;

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const ACCEPT_SCORE = 40;

/**
 * @param {string} message  Raw SMS text.
 * @returns {{code: string, score: number, kind: 'domain-bound'|'numeric'|'alphanumeric'|'bare',
 *            domain?: string, frameDomain?: string|null} | null}
 *   `domain` is set when the message itself names the website the code is for.
 */
function extractOtp(message) {
  const text = normalizeText(message).trim();
  if (!text || text.length > 4000) return null;

  // 1. The machine-readable last line defined for SMS autofill:
  //    "@example.com #482913", optionally followed by "%frame.example" for a
  //    code that is typed into an embedded frame of another site.
  //    It ends a line (normally the last one) and names a real host name.
  const bound = /(?:^|\s)@([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)[ ]+#([A-Za-z0-9]{4,12})(?:[ ]+%([a-z0-9][a-z0-9.-]*))?[ ]*(?=\n|$)/iu.exec(text);
  if (bound) {
    return {
      code: bound[2],
      score: 100,
      kind: 'domain-bound',
      domain: bound[1].toLowerCase().replace(/\.$/, ''),
      frameDomain: bound[3] ? bound[3].toLowerCase().replace(/\.$/, '') : null,
    };
  }

  // 2. A message that is nothing but a code.
  const bare = /^[\s"'([<]*(?:[A-Za-z]{1,3}-)?(\d{4,8}|\d{3}[- ]\d{3})[\s"')\]>.]*$/.exec(text);
  if (bare) return { code: bare[1].replace(/[- ]/g, ''), score: 50, kind: 'bare' };

  const keywords = findKeywords(text);
  if (keywords.length === 0) return null;

  // 3. Numbers, ranked by how strongly the wording ties them to a keyword.
  let winner = null;
  for (const cand of buildCandidates(text)) {
    if (!passesContextRules(text, cand)) continue;
    const score = Math.round(scoreCandidate(text, cand, keywords));
    if (score >= ACCEPT_SCORE && (!winner || score > winner.score)) {
      winner = { code: cand.code, score, kind: 'numeric' };
    }
  }

  // 4. Codes with letters in them, only when a keyword points straight at them:
  //    "Your verification code is X7K9P2".
  const alnum = findAlphanumeric(text, keywords);
  if (alnum && (!winner || alnum.score > winner.score)) winner = alnum;

  return winner;
}

function findAlphanumeric(text, keywords) {
  const tokenRe = /[A-Za-z0-9]{4,10}/y;
  for (const kw of keywords) {
    const rest = text.slice(kw.end, kw.end + 24);
    const lead = /^[\s:=\->#\[(「【"'“‘<]*(?:(?:is|est|es|ist|lautet|هو|هي|是|は)(?![\p{L}])[\s:=-]*)?["'“‘[(<]?/iu.exec(rest);
    const at = kw.end + (lead ? lead[0].length : 0);
    if (isAsciiLetter(text[at - 1]) || /\d/.test(text[at - 1] || '')) continue;
    tokenRe.lastIndex = at;
    const m = tokenRe.exec(text);
    if (!m) continue;
    const token = m[0];
    const after = text[at + token.length];
    if (after !== undefined && /[A-Za-z0-9_@/-]/.test(after)) continue;
    const digits = (token.match(/\d/g) || []).length;
    const letters = token.length - digits;
    if (digits === 0 || letters === 0) continue; // all digits are handled above; all letters is a word
    const upperOnly = token === token.toUpperCase();
    if (!upperOnly && digits < 2) continue; // "step2", "Covid19" style words
    // "Use code SAVE20": a word with a number stuck on is a voucher, not a
    // one-time code, unless the message plainly calls it a verification code.
    if (!kw.strong && /^[A-Za-z]{3,}\d{1,3}$/.test(token)) continue;
    return { code: token, score: kw.strong ? 72 : 58, kind: 'alphanumeric' };
  }
  return null;
}

module.exports = { extractOtp, normalizeText, ACCEPT_SCORE };

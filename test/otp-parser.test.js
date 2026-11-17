'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractOtp, normalizeText } = require('../companion/lib/otp-parser');

/** [message, expected code or null] */
const CASES = [
  // --- Big services, English ------------------------------------------------
  ['G-482913 is your Google verification code.', '482913'],
  ['G-482913 is your Google verification code. Don\'t share it with anyone.', '482913'],
  ['Your Google verification code is 482913', '482913'],
  ['482913 is your Google Voice verification code', '482913'],
  ['Your WhatsApp code: 482-913\n\nDon\'t share this code with others', '482913'],
  ['<#> Your WhatsApp code: 482-913\nDon\'t share this code with others\n4sgLq1p5sV6', '482913'],
  ['Your WhatsApp Business code: 482-913\n\nYou can also tap on this link to verify your phone: v.whatsapp.com/482913', '482913'],
  ['482 913 is your Instagram code. Don\'t share it.', '482913'],
  ['Use 482 913 to verify your Instagram account.', '482913'],
  ['482 913 is your Instagram code. Don\'t share it. #ig', '482913'],
  ['Telegram code: 48291\n\nYou can also tap on this link to log in:\nhttps://t.me/login/48291\n\noLeq9AcOZkT', '48291'],
  ['Your Uber code is 4829. Never share this code.', '4829'],
  ['Your Uber code: 4829. Reply STOP ALL to unsubscribe.', '4829'],
  ['Your Apple Account code is: 482913. Don\'t share it with anyone.\n@apple.com #482913 %apple.com', '482913'],
  ['Your Apple ID Code is: 482913. Don\'t share it with anyone.', '482913'],
  ['Use verification code 482913 for Microsoft authentication.', '482913'],
  ['Microsoft access code: 4829', '4829'],
  ['Use 4829137 as Microsoft account security code', '4829137'],
  ['482913 is your Amazon OTP. Do not share it with anyone.', '482913'],
  ['Amazon: Use 482913 to reset your password. Do not give this code to anyone.', '482913'],
  ['PayPal: Your security code is 482913. Your code expires in 10 minutes. Please don\'t reply.', '482913'],
  ['PayPal: 482913 is your security code. Don\'t share your code.', '482913'],
  ['Your X confirmation code is 482913.', '482913'],
  ['Your Twitter confirmation code is 482913.', '482913'],
  ['48291357 is your Facebook password reset code', '48291357'],
  ['482913 is your Facebook confirmation code', '482913'],
  ['FB-48291 is your Facebook confirmation code', '48291'],
  ['Your LinkedIn verification code is 482913.', '482913'],
  ['Your Discord security code is: 482913', '482913'],
  ['[TikTok] 482913 is your verification code, valid for 5 minutes. To keep your account safe, never forward this code.', '482913'],
  ['[#][TikTok] 4829 is your verification code fJpzQvK2eu1', '4829'],
  ['Snapchat Login Code: 482913. Snapchat Support will never ask for this code.', '482913'],
  ['Snapchat: 482913 is your one time passcode for phone enrollment', '482913'],
  ['Your Netflix verification code is 482913', '482913'],
  ['Your Stripe verification code is: 482-913. Don\'t share this code with anyone; our employees will never ask for the code.', '482913'],
  ['Your Tinder code is 482913 Don\'t share @tinder.com #482913', '482913'],
  ['Binance: Your verification code is 482913. Do not share it with anyone. If this wasn\'t you, please contact support.', '482913'],
  ['Your Coinbase verification code is: 4829137. Don\'t share this code with anyone; our employees will never ask for the code.', '4829137'],
  ['Your Lyft code is 4829', '4829'],
  ['Your Airbnb verification code is: 4829.', '4829'],
  ['Venmo: Your verification code is 482913. Do not share this code. We will NEVER call you to ask for it.', '482913'],
  ['Your Signal verification code: 482-913\n\ndoDiFGKPO1r', '482913'],
  ['SIGNAL: Your code is: 482-913\nDo not share this code', '482913'],
  ['Your Slack confirmation code is 482913', '482913'],
  ['Your Twilio verification code is: 482913', '482913'],
  ['Your verification code for GitHub is 482913.', '482913'],
  ['482913 is your GitHub authentication code.\n\n@github.com #482913', '482913'],
  ['Dropbox security code: 482913', '482913'],
  ['Your Yahoo verification code is 482913', '482913'],
  ['Zoom: 482913 is your Zoom verification code.', '482913'],
  ['Your OpenAI verification code is: 482913', '482913'],
  ['Your Claude verification code is: 482913', '482913'],
  ['Shopify: Your verification code is 482913', '482913'],
  ['Your DoorDash verification code is 482913. Please do not share it.', '482913'],
  ['Robinhood: Your code is 482913. Never share this code.', '482913'],
  ['Your Cash App sign in code is 482-913. No one representing Cash App will ever ask for this code.', '482913'],
  ['Steam Guard code: 48291', '48291'],
  ['Your Proton verification code is: 482913', '482913'],
  ['Your Viber code: 482913. You can also tap this link to finish your activation: https://unv.viber.com/a/482913', '482913'],
  ['Your imo verification code is 4829. DO NOT share with anyone else.', '4829'],
  ['482913 is your Careem verification code', '482913'],
  ['Your Noon verification code is 4829', '4829'],
  ['Your OTP is 482913', '482913'],
  ['OTP: 482913', '482913'],
  ['482913', '482913'],
  ['  4829  ', '4829'],
  ['482-913', '482913'],
  ['G-482913', '482913'],
  ['Login code for your account: 482913', '482913'],
  ['Your OTP for card 1234 is 482913', '482913'],
  ['Your code is 482913,valid for 10 minutes', '482913'],
  ['OTP 482913 for purchase of 1500 at STORE', '482913'],
  ['Dear customer, 482913 is the OTP for your transaction of SAR 99.00. Card xx4321', '482913'],
  ['Your Apple Pay verification code is 482913. Enter it to add your card ending in 9981.', '482913'],
  ['Use code 482913 to verify. https://example.com/v/999999', '482913'],
  ['Your code is "482913"', '482913'],
  ['verification code\n\n482913', '482913'],
  ['Your PIN is 0042', '0042'],
  ['OTP is 000000', '000000'],
  ['Code de sécurité : 482 913', '482913'],
  ['482913\nDo not share this code with anyone.', '482913'],
  ['Enter 482913 to log in. This code expires in 5 minutes.', '482913'],
  ['Hi! Your one-time password is 48291357. It is valid for 3 minutes.', '48291357'],
  ['Your login code:\n482913\n\nIf you did not request this, ignore this message.', '482913'],
  ['Code 482913', '482913'],
  ['Verification: 482913', '482913'],
  ['Passcode 482913. Expires in 300 seconds.', '482913'],
  ['Your temporary password is 482913', '482913'],

  // --- Banks ------------------------------------------------------------------
  ['Chase: DON\'T share. Use code 48291357. Only use online. Code expires in 10 min. We\'ll NEVER call to ask for this code.', '48291357'],
  ['BofA: DO NOT share this Sign In code. We will NEVER call you or text you for it. Code 482913. Reply HELP if you didn\'t request it.', '482913'],
  ['Wells Fargo will NEVER call or text you for this code. DON\'T share it. Enter in online or mobile banking only: 482913. Reply HELP for help.', '482913'],
  ['Citi Identification Code : 482913', '482913'],
  ['482913 is your OTP for txn of INR 1,500.00 at AMAZON on HDFC Bank card ending 1234. Valid till 10:35. Do not share OTP for security reasons.', '482913'],
  ['Dear Customer, OTP for transaction of Rs.2500.00 on your SBI Card ending 5678 is 482913. Valid for 10 mins. Do not share it with anyone.', '482913'],
  ['OTP for Aadhaar (XX1234) is 482913 (valid for 10 mins). To update Aadhaar, upload documents on myaadhaar.uidai.gov.in', '482913'],
  ['<#> 4829 is your OTP for Swiggy login. kMWSu6Tv2PU', '4829'],
  ['Your OTP for purchase of SAR 1500 at AMAZON on card ending 4821 is 739105. Do not share it.', '739105'],
  ['OTP: 4829 for online purchase from JARIR amount SAR 250.00 Card ending 5678', '4829'],
  ['Your stc pay OTP is 482913. Do not share it with anyone.', '482913'],
  ['Your verification code for Absher is: 482913', '482913'],
  ['Revolut: Your verification code is 482-913', '482913'],
  ['Monzo: 482913 is your code to log in. Never share it.', '482913'],
  ['Ihre mTAN lautet 482913. Auftrag: Überweisung 150,00 EUR an DE89 3704 0044 0532 0130 00', '482913'],
  ['Your TAC is 482913 for FPX purchase RM150.00 at SHOPEE. Never share your TAC.', '482913'],
  ['Emirates NBD: 482913 is your One Time Password for transaction of AED 320.50 at CARREFOUR with card ending 9981. Valid for 5 minutes.', '482913'],

  // --- Arabic -----------------------------------------------------------------
  ['رمز التحقق: 4829', '4829'],
  ['رمز التحقق الخاص بك هو 482913 الرجاء عدم مشاركته مع أي شخص', '482913'],
  ['رمز التحقق لدخول منصة أبشر هو 482913', '482913'],
  ['عزيزي العميل، رمز التحقق لمرة واحدة هو ٤٨٢٩١٣ صالح لمدة ٥ دقائق', '482913'],
  ['رمز التحقق:4829\nمبلغ:150.00 ريال\nلدى:AMAZON.SA\nبطاقة مدى:*4321', '4829'],
  ['رمز التحقق: 4829 لشراء من JARIR بمبلغ SAR 150.00 بطاقة مدى *4321', '4829'],
  ['كلمة المرور المؤقتة 4829 لعملية شراء بمبلغ 99.00 ريال', '4829'],
  ['عزيزي العميل رمز التحقق لعملية الشراء بمبلغ 250.00 ريال من متجر جرير هو 739105', '739105'],
  ['كود التفعيل الخاص بك: 482913', '482913'],
  ['رمزك هو 4829 لا تشاركه مع أحد', '4829'],
  ['استخدم الرمز 482913 لتأكيد رقم جوالك', '482913'],
  ['تطبيق توكلنا: رمز التحقق ٤٨٢٩', '4829'],
  ['الرمز السري المؤقت: 482913 صالح لمدة 3 دقائق. لا تشارك الرمز مع أحد', '482913'],
  ['482913 هو رمز التحقق الخاص بك في نون', '482913'],
  ['رمز الدخول لحسابك: 482913', '482913'],
  ['Your OTP is 482913 رمز التحقق هو', '482913'],
  ['رمز التحقق من هوية المستخدم: ۴۸۲۹۱۳', '482913'],

  // --- Other languages -----------------------------------------------------------
  ['Tu código de verificación es 482913', '482913'],
  ['Su código de seguridad es: 482913. No lo comparta.', '482913'],
  ['482913 es tu código de Instagram', '482913'],
  ['Votre code de vérification est 482913', '482913'],
  ['482913 est votre code de validation', '482913'],
  ['Ihr Bestätigungscode lautet 482913', '482913'],
  ['Dein Code ist 482913', '482913'],
  ['Seu código de verificação é 482913', '482913'],
  ['Il tuo codice di verifica è 482913', '482913'],
  ['Doğrulama kodunuz: 482913', '482913'],
  ['Tek kullanımlık şifreniz 482913', '482913'],
  ['Ваш код подтверждения: 482913. Никому не сообщайте.', '482913'],
  ['Код: 4829. Никому не говорите код!', '4829'],
  ['Kode verifikasi Anda adalah 482913. Jangan berikan kode ini kepada siapa pun.', '482913'],
  ['Mã xác nhận của bạn là 482913', '482913'],
  ['קוד האימות שלך הוא 482913', '482913'],
  ['کد تایید شما: ۴۸۲۹۱۳', '482913'],
  ['आपका ओटीपी 482913 है', '482913'],
  ['【淘宝】验证码482913，您正在登录，若非本人操作，请勿泄露。', '482913'],
  ['您的验证码是：4829，5分钟内有效', '4829'],
  ['【微信】驗證碼 482913，請於10分鐘內輸入', '482913'],
  ['認証コード: 482913\nこのコードは10分間有効です。', '482913'],
  ['[LINE] 認証番号「4829」を入力してください', '4829'],
  ['[카카오톡] 인증번호 [482913] 를 입력해주세요.', '482913'],
  ['รหัสยืนยันของคุณคือ 482913', '482913'],
  ['Twój kod weryfikacyjny to 482913', '482913'],
  ['Din verifieringskod är 482913', '482913'],
  ['Uw verificatiecode is 482913', '482913'],

  // --- Codes with letters ---------------------------------------------------------
  ['Your verification code is X7K9P2', 'X7K9P2'],
  ['Your login code: 9F3K2A. It expires in 10 minutes.', '9F3K2A'],
  ['Your security code is A1B2C3D4', 'A1B2C3D4'],

  // --- Not codes ------------------------------------------------------------------
  ['Your package 1Z999AA10123456784 will arrive tomorrow', null],
  ['Purchase of SAR 150.00 at STORE using card *1234 on 2026-11-16. Balance: SAR 5,230.10', null],
  ['شراء عبر الإنترنت\nبطاقة: 1234*\nمبلغ: 150.00 SAR\nلدى: AMAZON\nفي: 2026-11-16 21:04', null],
  ['Hi, are we still meeting at 1230 tomorrow?', null],
  ['Your appointment is on 12/05/2026 at 10:30. Reply 1 to confirm.', null],
  ['Call me at 555-123-4567', null],
  ['Call 8001234567 if this was not you', null],
  ['Your order #482913 has shipped. Track it: https://track.example.com/482913', null],
  ['Use promo code SAVE20 for 2000 bonus points until 31/12/2026', null],
  ['Your verification code has been sent to your email.', null],
  ['Your account balance is 12345.67 USD', null],
  ['Reminder: your bill of $1234 is due on 2026-12-01', null],
  ['تم شحن رصيدك بمبلغ 2000 ريال بنجاح', null],
  ['Your parcel is at locker 4455. Pickup code 771234 at the Aramex point.', null],
  ['Purchase at STORE 4455 for SAR 150. Never share your OTP with anyone.', null],
  ['Flight SV1234 departs at 0930 from gate 22', null],
  ['Happy new year 2026!', null],
  ['Your verification link: https://example.com/verify/482913', null],
  ['Meeting ID 4829137 Passcode: join us at 5 pm', null],
  ['Dear customer, your password was changed on 16 Nov 2026. If this was not you call 920001234', null],
  ['Your code of conduct training is due in 2026', null],
  ['Use code SAVE20 at checkout for free delivery', null],
  ['Enter code RAMADAN25 before Friday', null],
  ['Your code is WELCOME10. Enjoy!', null],
  ['Never share your OTP. Your balance is SAR 1,204.50 as of 16/11/2026', null],
  ['Dear Customer, your bill 104829 of 250 SAR is due. Pay using code 123', null],
  ['You have a new voicemail from 0551234567. Call 1500 to listen', null],
  ['Your security code for the card ending 9981 is 123. Never share it', null],
  ['رمز الخصم SAVE20 صالح حتى 2026', null],
  ['الرمز البريدي 31311 لمدينة الدمام', null],
  ['تم خصم 4829 ريال من حسابك', null],
  ['عزيزنا العميل، تم إيداع راتب بمبلغ 12500 في حسابك 4821', null],
  ['Tracking number 482913 shipped', null],
  ['Thanks for shopping. Order 482913. Verify your email to track it.', null],
  ['Your refund of 4829 has been processed. Verify at example.com', null],
  ['', null],
  ['   ', null],
  ['12', null],
  ['123456789012', null],
];

for (const [message, expected] of CASES) {
  const label = message.length > 70 ? `${message.slice(0, 67)}...` : message;
  test(`extractOtp: ${JSON.stringify(label)} -> ${expected}`, () => {
    const result = extractOtp(message);
    assert.equal(result ? result.code : null, expected);
  });
}

test('the iPhone shortcut passes on every message a code can be found in', () => {
  // The shortcut checks each text on the phone and sends only those that
  // match its pattern. Anything the parser can read must get through.
  const { SEND_IF_PATTERN } = require('../scripts/make-shortcut');
  // The Shortcuts app's \d is a digit in any script; JavaScript spells that \p{Nd}.
  const passedOn = new RegExp(SEND_IF_PATTERN.replace(/\\d/g, '\\p{Nd}'), 'u');
  const extra = [
    '@example.com #ABCDEF',                       // a code without a digit, named by its website
    'رمز التحقق ٤٨٢٩١٣',                          // Arabic-Indic digits
    'کد تایید شما ۴۸۲۹۱۳ است',                     // Persian digits
    'Your code is ４８２９１３',                     // fullwidth digits
  ];
  let checked = 0;
  for (const message of [...CASES.map(([m]) => m), ...extra]) {
    if (!extractOtp(message)) continue;
    checked += 1;
    assert.ok(passedOn.test(message), `the shortcut would hold back: ${JSON.stringify(message)}`);
  }
  assert.ok(checked > 150, 'the samples were looked at');
  assert.ok(!passedOn.test('See you at the usual place, bring the keys'), 'ordinary chat stays on the phone');
});

test('long, repetitive messages are handled quickly', () => {
  for (const unit of ['otp 1234 ', 'code 123456 ', '1234 otp ', 'رمز 1234 ', 'a.', '1.', 'code is ', 'http://a ', '@a.b #1234 ']) {
    const message = unit.repeat(Math.ceil(4000 / unit.length)).slice(0, 4000);
    const started = process.hrtime.bigint();
    extractOtp(message);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 500, `${JSON.stringify(unit)} repeated took ${ms.toFixed(0)} ms`);
  }
});

test('extractOtp tolerates odd input', () => {
  assert.equal(extractOtp(undefined), null);
  assert.equal(extractOtp(null), null);
  assert.equal(extractOtp(482913).code, '482913');
  assert.equal(extractOtp('x'.repeat(5000) + ' code 482913'), null);
});

test('a message can name the website its code is for', () => {
  const apple = extractOtp('Your Apple Account code is: 482913. Don\'t share it with anyone.\n@apple.com #482913 %apple.com');
  assert.deepEqual(apple, { code: '482913', score: 100, kind: 'domain-bound', domain: 'apple.com', frameDomain: 'apple.com' });

  const github = extractOtp('482913 is your GitHub authentication code.\n\n@GitHub.com #482913');
  assert.equal(github.domain, 'github.com');
  assert.equal(github.frameDomain, null);

  // Written at the end of the only line, as some services do.
  assert.equal(extractOtp('Your Tinder code is 482913 Don\'t share @tinder.com #482913').domain, 'tinder.com');
  assert.equal(extractOtp('Code 482913\n@shop.example.co.uk #482913 %pay.example.net\n').frameDomain, 'pay.example.net');

  // The marked code wins over other numbers in the message.
  assert.equal(extractOtp('Use 111111 or call 5551234.\n@example.com #A1B2C3').code, 'A1B2C3');

  // Not the marker: no host name, or not at the end of a line.
  assert.equal(extractOtp('Your code is 482913').domain, undefined);
  assert.equal(extractOtp('Thanks @maria #482913'), null);
  assert.equal(extractOtp('Your code: 482913 thanks @maria #482913').kind, 'numeric');
  assert.equal(extractOtp('Mail me@example.com #482913 is my ticket'), null);
  assert.equal(extractOtp('Your code is 482913, sent by @example.com #support team').domain, undefined);
});

test('extractOtp reports how it found the code', () => {
  assert.equal(extractOtp('@example.com #482913').kind, 'domain-bound');
  assert.equal(extractOtp('482913').kind, 'bare');
  assert.equal(extractOtp('Your code is 482913').kind, 'numeric');
  assert.equal(extractOtp('Your code is X7K9P2').kind, 'alphanumeric');
});

test('normalizeText converts digits and strips invisible characters', () => {
  assert.equal(normalizeText('٤٨٢٩١٣'), '482913');
  assert.equal(normalizeText('۴۸۲۹۱۳'), '482913');
  assert.equal(normalizeText('４８２９１３'), '482913');
  assert.equal(normalizeText('४८२९१३'), '482913');
  assert.equal(normalizeText('48​29‏13'), '482913');
  assert.equal(normalizeText('482–913'), '482-913');
  assert.equal(normalizeText('a b'), 'a b');
});

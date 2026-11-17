const params = new URLSearchParams(location.search);
if (params.get('mode') === 'reveal') {
  setTimeout(() => document.getElementById('step2').classList.remove('hidden'), 1200);
} else {
  setTimeout(() => {
    document.getElementById('slot').innerHTML = '<p>Enter the verification code.</p><input id="inserted" name="otp" maxlength="6" inputmode="numeric">';
  }, 1200);
}

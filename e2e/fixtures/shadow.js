customElements.define('code-entry', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<label for="i">One-time passcode</label><br><input id="i" name="otp" maxlength="6" inputmode="numeric" style="font:inherit;padding:10px 12px;border:1px solid #cdd2de;border-radius:10px">';
  }
});

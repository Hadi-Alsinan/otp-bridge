/* Real React 18, controlled inputs. Three common ways sites build code entry. */
const e = React.createElement;

function Single() {
  const [value, setValue] = React.useState('');
  return e('section', null,
    e('h1', null, 'Controlled field'),
    e('label', { htmlFor: 'r-otp' }, 'One-time code'),
    e('input', {
      id: 'r-otp', name: 'otp', inputMode: 'numeric', maxLength: 6, value,
      onChange: (event) => setValue(event.target.value.replace(/\D/g, '')),
    }),
    e('output', { id: 'r-single-state' }, value));
}

// Like react-otp-input: writes to whichever box it believes is active.
function Split() {
  const [digits, setDigits] = React.useState(Array(6).fill(''));
  const [active, setActive] = React.useState(0);
  const refs = React.useRef([]);
  const focus = (index) => {
    const next = Math.max(0, Math.min(5, index));
    setActive(next);
    refs.current[next] && refs.current[next].focus();
  };
  const change = (event) => {
    const ch = event.target.value.slice(-1);
    if (!/\d/.test(ch)) return;
    setDigits((old) => old.map((d, i) => (i === active ? ch : d)));
    focus(active + 1);
  };
  return e('section', null,
    e('h1', null, 'Split boxes, state-driven'),
    e('div', { className: 'boxes', id: 'r-boxes' }, digits.map((digit, index) => e('input', {
      key: index, ref: (el) => { refs.current[index] = el; }, maxLength: 1, inputMode: 'numeric', value: digit,
      'aria-label': `Please enter verification code. Digit ${index + 1}`,
      onChange: change, onFocus: () => setActive(index),
      onKeyDown: (event) => {
        if (event.key === 'Backspace') { event.preventDefault(); setDigits((old) => old.map((d, i) => (i === active ? '' : d))); focus(active - 1); }
      },
    }))),
    e('output', { id: 'r-split-state' }, digits.join('')));
}

// Handles the key itself and cancels the key press, as some PIN widgets do.
function KeyDriven() {
  const [digits, setDigits] = React.useState(Array(4).fill(''));
  const refs = React.useRef([]);
  return e('section', null,
    e('h1', null, 'Split boxes, key-driven'),
    e('div', { className: 'boxes', id: 'r-keys' }, digits.map((digit, index) => e('input', {
      key: index, ref: (el) => { refs.current[index] = el; }, maxLength: 1, value: digit, readOnly: false,
      'aria-label': `PIN code digit ${index + 1}`,
      onChange: () => {},
      onKeyDown: (event) => {
        if (/^\d$/.test(event.key)) {
          event.preventDefault();
          setDigits((old) => old.map((d, i) => (i === index ? event.key : d)));
          refs.current[index + 1] && refs.current[index + 1].focus();
        }
      },
    }))),
    e('output', { id: 'r-keys-state' }, digits.join('')));
}

ReactDOM.createRoot(document.getElementById('root')).render(e('main', null, e(Single), e(Split), e(KeyDriven)));

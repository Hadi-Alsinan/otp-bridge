// The bank page lives on another origin, as it does in real card payments.
const other = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
document.getElementById('bank').src = `http://${other}:${location.port}/threeds.html`;

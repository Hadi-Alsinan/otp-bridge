// The usual "close when clicking outside" logic, in both event phases.
const sheet = document.getElementById('sheet');
const overlay = document.getElementById('overlay');
const closeIfOutside = (event) => {
  if (!sheet.contains(event.target)) {
    overlay.remove();
    document.title = 'CLOSED';
  }
};
for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchstart']) {
  document.addEventListener(type, closeIfOutside, true);
  document.addEventListener(type, closeIfOutside, false);
  document.body.addEventListener(type, closeIfOutside, false);
}

// Typical hand-written split-code boxes: the cursor moves on by itself.
const boxes = [...document.querySelectorAll('#boxes input')];
const joined = document.getElementById('joined');
boxes.forEach((box, index) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/\D/g, '').slice(-1);
    if (box.value && boxes[index + 1]) boxes[index + 1].focus();
    joined.textContent = boxes.map((b) => b.value).join('');
  });
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !box.value && boxes[index - 1]) boxes[index - 1].focus();
  });
});

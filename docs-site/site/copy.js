if (navigator.clipboard) {
  for (const button of document.querySelectorAll('button[data-copy]')) {
    const code = document.getElementById(button.dataset.copy);
    const label = button.querySelector('span');
    let reset;

    label.setAttribute('aria-live', 'polite');
    button.hidden = false;
    button.addEventListener('click', async () => {
      clearTimeout(reset);
      try {
        await navigator.clipboard.writeText(code.textContent);
        label.textContent = 'Copiado';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        label.textContent = 'Texto seleccionado';
      }
      reset = setTimeout(() => { label.textContent = 'Copiar'; }, 2200);
    });
  }
}

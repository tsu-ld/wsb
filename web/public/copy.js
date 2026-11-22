for (const button of document.querySelectorAll('[data-copy]')) {
  const field = document.getElementById(button.dataset.copy)
  const status = button.closest('.copy-block').querySelector('[role="status"]')
  button.hidden = false
  button.addEventListener('click', () => {
    status.textContent = ''
    navigator.clipboard.writeText(field.value).then(
      () => {
        status.textContent = 'Copied.'
      },
      () => {
        field.focus()
        field.select()
        status.textContent = 'Text selected. Press Ctrl+C or Command+C to copy.'
      },
    )
  })
}

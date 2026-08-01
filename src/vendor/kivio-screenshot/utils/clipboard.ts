function tryLegacyCopy(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'absolute'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  const result = document.execCommand('copy')
  document.body.removeChild(textarea)
  return result
}

export function copyToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard) {
    return Promise.resolve(tryLegacyCopy(text))
  }
  return navigator.clipboard.writeText(text)
    .then(() => true)
    .catch(() => tryLegacyCopy(text))
}

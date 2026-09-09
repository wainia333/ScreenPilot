function tryLegacyCopy(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'absolute'
  textarea.style.left = '-9999px'
  try {
    document.body.appendChild(textarea)
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

export function getClipboardImage(dataTransfer: DataTransfer): Blob | null {
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }

  for (const file of Array.from(dataTransfer.files)) {
    if (file.type.startsWith('image/')) return file
  }

  return null
}

export function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Clipboard image could not be read'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Clipboard image could not be read'))
    reader.readAsDataURL(blob)
  })
}

export function dataUrlToBase64(dataUrl: string): string {
  const separator = dataUrl.indexOf(',')
  return separator >= 0 ? dataUrl.slice(separator + 1) : dataUrl
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall back for WebViews where the async clipboard API exists but is denied.
    }
  }
  return tryLegacyCopy(text)
}

import { expect, it } from 'vitest'
import { captureFilename, defaultCaptureFilename, filenameIssue } from './filename'

it('previews local time tokens and keeps the extension aligned with the image format', () => {
  const date = new Date(2026, 9, 4, 21, 50, 9, 123)
  expect(captureFilename(defaultCaptureFilename, 'PNG', date)).toBe('Screenshot_2026-10-04_21-50-09.png')
  expect(captureFilename('画面_$yy-M-d_hh-mm-ss-zzz$.png', 'JPG', date)).toBe('画面_26-10-4_09-50-09-123.jpg')
  expect(captureFilename('演示', 'WEBP', date)).toBe('演示.webp')
  for (const name of ['', '../shot', 'C:\\shot', '$yyyy', '$$', 'CON.png', 'LPT9', '$yyyy-Q$', 'shot.', 'a\nb']) expect(filenameIssue(name)).not.toBeNull()
})

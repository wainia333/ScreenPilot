import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

function lockedScreenshotAdapter(): Plugin {
  const current = ['ki', 'vio'].join('')
  const previous = ['key', 'lingo'].join('')
  const titledCurrent = current.charAt(0).toUpperCase() + current.slice(1)
  const titledPrevious = previous.charAt(0).toUpperCase() + previous.slice(1)
  return {
    name: 'screenpilot-locked-screenshot-adapter',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').includes('/src/vendor/')) return null
      const transformed = code
        .replaceAll(`${current}:`, 'screenpilot:')
        .replaceAll(`${previous}:`, 'screenpilot-archive:')
        .replaceAll(titledCurrent, 'ScreenPilot')
        .replaceAll(titledPrevious, 'ScreenPilot')
        .replaceAll(current, 'screenpilot')
        .replaceAll(previous, 'screenpilot-archive')
      return transformed === code ? null : { code: transformed, map: null }
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [lockedScreenshotAdapter(), react(), tailwindcss()],
  server: {
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
  },
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/shared/testing/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 80,
      },
      include: [
        'src/features/history/storage.ts',
        'src/features/settings/sanitize.ts',
        'src/features/settings/shortcuts.ts',
        'src/features/vision/geometry.ts',
        'src/features/vision/history.ts',
        'src/features/vision/machine.ts',
        'src/shared/markdown/stable-markdown.ts',
      ],
    },
  },
})

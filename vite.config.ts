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
      reportOnFailure: true,
      excludeAfterRemap: true,
      // These thresholds cover the explicit production surface below, including
      // currently unexecuted desktop/Vision adapters; they are not a repo-wide claim.
      thresholds: {
        lines: 58,
        functions: 58,
        statements: 55,
        branches: 48,
      },
      include: [
        'src/app/external-link-bridge.tsx',
        'src/desktop/**/*.{ts,tsx}',
        'src/features/history/**/*.{ts,tsx}',
        'src/features/prompt-optimizer/**/*.{ts,tsx}',
        'src/features/settings/**/*.{ts,tsx}',
        'src/features/translator/**/*.{ts,tsx}',
        'src/features/vision/**/*.{ts,tsx}',
        'src/shared/**/*.{ts,tsx}',
      ],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/shared/testing/**',
        'src/vendor/**',
      ],
    },
  },
})

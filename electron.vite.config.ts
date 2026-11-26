import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { build: { externalizeDeps: false } },
  renderer: {
    optimizeDeps: { include: ['zod'] },
    build: { rollupOptions: { input: {
      index: resolve('src/renderer/index.html'),
      capture: resolve('src/renderer/capture/index.html')
    } } },
    plugins: [
      react(),
      {
        name: 'development-csp',
        apply: 'serve',
        transformIndexHtml(html) {
          return html.replace(
            "script-src 'self'; style-src 'self';",
            "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
          )
        }
      }
    ]
  }
})


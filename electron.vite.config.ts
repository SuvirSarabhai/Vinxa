import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { build: { externalizeDeps: false } },
  renderer: {
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


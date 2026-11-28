const { registerHooks, stripTypeScriptTypes } = require('node:module')
const { readFileSync, existsSync } = require('node:fs')
const { fileURLToPath } = require('node:url')
// Tool-only loader. The application continues to use electron-vite's build.
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) }
    catch (error) {
      if (specifier.startsWith('.') && context.parentURL) {
        const url = new URL(specifier + '.ts', context.parentURL)
        if (existsSync(fileURLToPath(url))) return next(url.href, context)
      }
      throw error
    }
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url })
    }
    return next(url, context)
  }
})

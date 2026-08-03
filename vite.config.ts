import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Content Security Policy for the production build.
 *
 * - `wasm-unsafe-eval` is required to compile the DuckDB WebAssembly module.
 * - The DuckDB worker and .wasm files are self-hosted, so `'self'` covers them and
 *   no third-party origin needs to be allowed.
 * - `style-src 'unsafe-inline'` is needed because components set inline `style`
 *   attributes (resizable panes, timeline positioning).
 * - `connect-src` allows `blob:` so the worker can fetch the module it was given.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  // Note: frame-ancestors is intentionally omitted. Browsers ignore it when the
  // policy is delivered via <meta>, so it only belongs in a real response header.
].join('; ')

/**
 * Injects the CSP meta tag into the built index.html only.
 *
 * It is deliberately not applied in dev: the React Fast Refresh preamble is an
 * inline script, which a policy without 'unsafe-inline' would block.
 */
function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cspPlugin()],
  base: '/bgpshark/',
  build: {
    outDir: 'dist',
  },
  // Vite handles SPA fallback automatically with appType: 'spa' (default)
})

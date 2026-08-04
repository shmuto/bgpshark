import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
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

/**
 * Copies the built index.html to 404.html.
 *
 * GitHub Pages is a static file server with no SPA rewrite, so a deep link like
 * /bgpshark/messages has no matching file and returns its 404 page. Serving a copy
 * of index.html as that 404 page lets React Router read the path and render the
 * right route, which is what makes direct links, reloads and bookmarks work.
 *
 * The copy is taken after the build has written the file so it includes the CSP
 * meta tag and the hashed asset URLs.
 */
function spaFallbackPlugin(): Plugin {
  return {
    name: 'spa-fallback-404',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist')
      const indexHtml = resolve(outDir, 'index.html')
      if (!existsSync(indexHtml)) return
      copyFileSync(indexHtml, resolve(outDir, '404.html'))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cspPlugin(), spaFallbackPlugin()],
  base: '/bgpshark/',
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // React changes when we upgrade it, the app changes every commit. Split
        // so a deploy does not invalidate the cached copy of the framework.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  // In dev and preview Vite handles the SPA fallback itself (appType: 'spa').
  // Static hosts need the 404.html copy emitted by spaFallbackPlugin.
})

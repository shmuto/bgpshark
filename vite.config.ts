import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { marked } from 'marked'

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

/**
 * Turns an imported `.md` file into the HTML it renders to, at build time.
 *
 * The user manual is prose, and prose is worth writing in Markdown rather than
 * in JSX. Converting here rather than in the browser is what keeps that from
 * costing anything: `marked` is a devDependency that runs during the build, and
 * no Markdown parser is shipped to anyone.
 *
 * The HTML is trusted by the component that renders it, which is only sound
 * because the input is a file in this repository. Never point this at Markdown
 * that arrived from a user — and note the production CSP forbids inline script
 * regardless, so an injected `<script>` would not run even then.
 */
function markdownPlugin(): Plugin {
  let base = '/'
  return {
    name: 'markdown-to-html',
    configResolved(config) {
      base = config.base
    },
    async transform(code, id) {
      if (!id.endsWith('.md')) return null
      const parsed = await marked.parse(code, { async: true, gfm: true })
      const html = withFigures(withHeadingIds(parsed), base)
      return { code: `export default ${JSON.stringify(html)}`, map: null }
    },
  }
}

/**
 * Gives every h2 and h3 an `id` derived from its text.
 *
 * Two things need them: the table of contents the manual page builds by reading
 * its own HTML back, and links from elsewhere in the app into a specific section
 * — `/manual#filters` should land on Filters rather than at the top.
 *
 * Done with a regex over the output rather than through a `marked` renderer
 * because the renderer API is the part of `marked` that changes between major
 * versions, and this does not need to know about any of it.
 */
function withHeadingIds(html: string): string {
  return html.replace(/<h([23])>(.*?)<\/h\1>/g, (whole, level: string, inner: string) => {
    const slug = inner
      .replace(/<[^>]+>/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return slug ? `<h${level} id="${slug}">${inner}</h${level}>` : whole
  })
}

/**
 * A PNG's pixel dimensions, read from its header.
 *
 * Eleven bytes of parsing rather than an image library, because that is all a
 * PNG needs: an 8-byte signature, then the IHDR chunk's length and type, then
 * width and height as big-endian 32-bit integers.
 */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${path} is not a PNG`)
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * Turns a paragraph that is nothing but an image into a captioned figure.
 *
 * Four things happen here, all of them consequences of the Markdown being
 * converted to a *string* rather than to a module Vite can analyse:
 *
 * - **The source is rewritten against the app's base path.** The screenshots
 *   live in `public/manual/` and the app is served under `/bgpshark/`, so a
 *   `manual/x.png` in the Markdown has to become `/bgpshark/manual/x.png`.
 *   Nothing else resolves it: Vite rewrites asset URLs it finds in HTML and
 *   in imports, and this HTML is neither. Reading the base from the resolved
 *   config rather than hard-coding it keeps the manual working if the app is
 *   ever served from somewhere else.
 * - **The alt text becomes a visible caption.** The manual's images are
 *   screenshots of dense screens, and a screenshot without a line saying what
 *   to look at is decoration.
 * - **Loading is deferred, and space is reserved for it.** The manual is one
 *   long page carrying a dozen screenshots, and a reader who arrived with a
 *   question about filters should not wait for a picture of the SQL console.
 *   But `loading="lazy"` without intrinsic dimensions is a trap: the images
 *   occupy no height until they load, so every anchor below them points at the
 *   wrong place and the page jumps around under the reader. The width and
 *   height attributes come from the file itself, so the browser can reserve
 *   the right box before fetching a byte.
 * - **A missing screenshot fails the build.** Reading the file is what makes
 *   that automatic: the manual cannot reference an image that is not there.
 *
 * Only a paragraph containing a single image is a figure. An image used inline
 * in a sentence stays where it is, and still gets its src rewritten.
 */
function withFigures(html: string, base: string): string {
  const prefix = base.endsWith('/') ? base : `${base}/`
  const absolute = /^(?:[a-z]+:|\/|data:)/i

  const withBase = html.replace(
    /<img([^>]*?)src="([^"]+)"/g,
    (whole, attributes: string, src: string) => {
      if (absolute.test(src)) return whole
      const { width, height } = pngSize(resolve(__dirname, 'public', src))
      return `<img${attributes}src="${prefix}${src}" width="${width}" height="${height}" loading="lazy"`
    }
  )

  return withBase.replace(
    /<p>(<img [^>]*alt="([^"]*)"[^>]*>)<\/p>/g,
    (_whole, image: string, alt: string) =>
      `<figure>${image}<figcaption>${alt}</figcaption></figure>`
  )
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), markdownPlugin(), cspPlugin(), spaFallbackPlugin()],
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

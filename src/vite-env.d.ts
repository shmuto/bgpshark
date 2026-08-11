/// <reference types="vite/client" />

/**
 * Markdown is converted to HTML during the build (see `markdownPlugin` in
 * `vite.config.ts`), so an imported `.md` file is a string of HTML.
 */
declare module '*.md' {
  const html: string
  export default html
}

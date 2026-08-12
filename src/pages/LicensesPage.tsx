/**
 * Third-party licence notices.
 *
 * The app makes no third-party requests, which means the typefaces and the
 * libraries are copied into the build rather than fetched from a CDN — the app
 * redistributes them. The SIL Open Font License and the MIT License both require
 * the copyright notice and the licence text to accompany a redistributed copy,
 * so those texts have to be somewhere a reader can reach. This page is that
 * somewhere, and it ships in the same bundle as everything it covers so the
 * obligation is met by any copy of the app, online or not.
 *
 * The prose lives in `licenses/licenses.md` and is converted to HTML at build
 * time by `markdownPlugin` in `vite.config.ts`, the same as the manual. Unlike
 * the manual it gets no table of contents: this is a page to search rather than
 * to read through, and the headings are already the shape of the list.
 *
 * It is outside `RequireCapture` for the obvious reason — attribution that only
 * appears once you have loaded a capture is attribution nobody finds.
 */
import licensesHtml from './licenses/licenses.md'

export function LicensesPage() {
  return (
    <div className="flex-1 overflow-y-auto bg-canvas">
      <article
        className="manual-prose mx-auto w-full max-w-3xl px-6 py-8"
        // This repository's own Markdown, converted at build time. See the note
        // on `markdownPlugin` in vite.config.ts.
        dangerouslySetInnerHTML={{ __html: licensesHtml }}
      />
    </div>
  )
}

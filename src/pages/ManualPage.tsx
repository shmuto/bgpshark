/**
 * The user manual.
 *
 * The prose lives in `manual/manual.md` and is converted to HTML during the
 * build (`markdownPlugin` in `vite.config.ts`), so what this component receives
 * is already a string of HTML and no Markdown parser is shipped to the browser.
 *
 * It is deliberately outside `RequireCapture`: the most likely reader is someone
 * who has just arrived, has nothing loaded, and wants to know what this is.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import manualHtml from './manual/manual.md'

interface Heading {
  id: string
  text: string
  level: 2 | 3
}

/**
 * The table of contents, read back out of the rendered HTML.
 *
 * Deriving it from the output rather than maintaining a list alongside the
 * Markdown means a section cannot be added to one and forgotten in the other.
 */
function extractHeadings(html: string): Heading[] {
  const headings: Heading[] = []
  const pattern = /<h([23]) id="([^"]+)">(.*?)<\/h\1>/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(html)) !== null) {
    headings.push({
      level: Number(match[1]) as 2 | 3,
      id: match[2],
      text: match[3].replace(/<[^>]+>/g, ''),
    })
  }
  return headings
}

export function ManualPage() {
  const { hash } = useLocation()
  const contentRef = useRef<HTMLDivElement>(null)
  const headings = useMemo(() => extractHeadings(manualHtml), [])
  const [activeId, setActiveId] = useState<string>('')

  // A link into a section has to work on first paint, and the content is
  // injected rather than rendered as elements, so the browser's own hash
  // handling has nothing to scroll to yet when it runs.
  useEffect(() => {
    if (!hash) return
    const target = document.getElementById(hash.slice(1))
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [hash])

  // Highlight whichever section the reader is actually in.
  useEffect(() => {
    const container = contentRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveId(visible[0].target.id)
      },
      // Only the band near the top of the viewport counts as "where you are",
      // so the highlight tracks reading position rather than whatever happens
      // to be on screen.
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    )

    for (const element of container.querySelectorAll('h2[id], h3[id]')) {
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex-1 overflow-y-auto bg-canvas">
      <div className="mx-auto flex w-full max-w-6xl gap-10 px-6 py-8">
        <nav
          aria-label="Manual contents"
          className="sticky top-6 hidden h-fit w-60 shrink-0 lg:block"
        >
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-dim">
            Contents
          </p>
          <ul className="space-y-0.5 border-l border-hair">
            {headings.map((heading) => (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  aria-current={activeId === heading.id ? 'location' : undefined}
                  className={`block border-l-2 py-1 text-sm transition-colors ${
                    heading.level === 3 ? 'pl-6' : 'pl-3'
                  } ${
                    activeId === heading.id
                      ? 'border-accent text-accent'
                      : 'border-transparent text-muted hover:text-body'
                  }`}
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article
          ref={contentRef}
          className="manual-prose min-w-0 flex-1"
          // The HTML is this repository's own Markdown, converted at build time.
          // See the note on `markdownPlugin` in vite.config.ts.
          dangerouslySetInnerHTML={{ __html: manualHtml }}
        />
      </div>
    </div>
  )
}

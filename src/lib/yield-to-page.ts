/**
 * Hand the event loop back to the page for a moment, so it can paint and
 * handle input, then carry on — the pause between slices of the long loops a
 * capture load runs (decoding, the DuckDB insert, route statistics).
 *
 * Not `setTimeout(0)`, which is what those loops first used. A timeout set
 * from inside a timeout callback is nested, and past five levels the browser
 * clamps it to at least 4ms. Every slice after the fifth then waited 4ms
 * doing nothing for 12ms of work: a quarter more time on the whole loop, which
 * is what a 200MB capture's decode lost — 16 seconds to the packet list
 * became 20.
 *
 * A message posted to ourselves is a new task, never clamped, and queued
 * behind whatever else is waiting — a paint, a click, a reply from the DuckDB
 * worker. That last part is why this is not `scheduler.yield()`, which looks
 * made for the job: its continuation runs *ahead* of other queued tasks, so
 * a slice loop resumed before the worker's replies were handled, and the
 * insert that overlaps with flattening stopped overlapping. Measured on a
 * 50MB capture, SQL took 21 seconds to become usable instead of 15.
 */
export function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

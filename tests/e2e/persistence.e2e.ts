import { test, expect } from '@playwright/test'
import { loadSample, openMessagesAfterLoad, shownCount } from './helpers'

/**
 * The capture is kept in IndexedDB so a reload puts the user back where they
 * were.
 *
 * Saving used to sit inside the load, awaited, and settle on the request's own
 * events. Chromium reports an oversized value (anything over ~127MB serialised)
 * only as a transaction abort, so the request never settled and a large
 * capture stuck on "Saving for next visit" for good. The save now runs after
 * the list is up, settles through its transaction, and stores a Blob, which
 * has no such ceiling.
 */
test.describe('keeping the capture across reloads', () => {
  test('a reload restores the capture that was open', async ({ page }) => {
    await loadSample(page)
    const before = await shownCount(page)

    // The save is not awaited by the load, so wait for it to land rather than
    // reloading over it.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<string>((resolve) => {
              const open = indexedDB.open('bgpshark-storage')
              open.onsuccess = () => {
                const db = open.result
                if (!db.objectStoreNames.contains('pcap-files')) return resolve('none')
                const get = db.transaction('pcap-files').objectStore('pcap-files').get('current-file')
                get.onsuccess = () => {
                  const data = (get.result as { data?: unknown } | undefined)?.data
                  resolve(data instanceof Blob ? 'blob' : data ? 'other' : 'none')
                }
                get.onerror = () => resolve('none')
              }
              open.onerror = () => resolve('none')
            })
        )
      )
      .toBe('blob')

    await page.reload()
    await openMessagesAfterLoad(page)
    expect(await shownCount(page)).toBe(before)
  })

  test('a save the browser refuses does not hold up the load', async ({ page }) => {
    // What Chromium does with an oversized value: the transaction aborts, and
    // the request it returned never fires anything.
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
        if (this.name !== 'pcap-files') return put.apply(this, args)
        const transaction = this.transaction
        setTimeout(() => transaction.abort(), 0)
        return {} as IDBRequest<IDBValidKey>
      }
    })

    await loadSample(page)
    expect(await shownCount(page)).toBeGreaterThan(0)

    // Nothing was kept, so a reload has nothing to restore and says so by
    // returning to the upload screen rather than hanging on a restore.
    await page.reload()
    await expect(page.getByRole('button', { name: /sample/i }).first()).toBeVisible()
  })
})

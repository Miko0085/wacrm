/**
 * Bounded-concurrency work pool with an optional start deadline.
 *
 * Used by the cron tick so a slow category (e.g. LLM-backed debounce jobs)
 * can neither fan out into an unbounded Promise.all nor run strictly one at a
 * time until the platform kills the request.
 *
 * - at most `concurrency` workers run at once;
 * - once `deadline` (epoch ms) has passed, no NEW item is started — items
 *   already running are allowed to finish (their leases cover a hard kill);
 * - a worker that throws never rejects the pool: the error is returned in the
 *   per-item outcome, so one bad job cannot strand the rest.
 */
export interface PoolOutcome<R> {
  results: Array<{ ok: true; value: R } | { ok: false; error: unknown }>
  /** Items never started because the deadline passed first. */
  skipped: number
}

export async function runBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  opts: { deadline?: number; now?: () => number } = {},
): Promise<PoolOutcome<R>> {
  const now = opts.now ?? Date.now
  const limit = Math.max(1, Math.floor(concurrency))
  const results: PoolOutcome<R>['results'] = []
  let next = 0
  let skipped = 0

  async function lane(): Promise<void> {
    for (;;) {
      if (opts.deadline !== undefined && now() >= opts.deadline) {
        // Count what is left exactly once, then stop pulling.
        const remaining = items.length - next
        if (remaining > 0) {
          skipped += remaining
          next = items.length
        }
        return
      }
      const index = next
      if (index >= items.length) return
      next += 1
      try {
        results.push({ ok: true, value: await worker(items[index]) })
      } catch (error) {
        results.push({ ok: false, error })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return { results, skipped }
}
